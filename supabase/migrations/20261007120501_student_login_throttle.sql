-- Per-account failed-sign-in throttling for student-login (see
-- supabase/functions/_shared/loginThrottle.ts for why the per-IP limit is not
-- enough: GoTrue only ever sees the edge function's IP).
--
-- Two kinds of row, told apart by key shape (the edge function derives both
-- with an HMAC, so no username or IP address is ever stored):
--
--   <scope>:<account>           ACCOUNT row: a loose fixed-window ceiling on
--                               attempts against one username from anywhere
--                               (attempts + window_ends_at).
--   <scope>:<account>:<client>  SOURCE row: the steep backoff for one username
--                               from one client address (attempts +
--                               last_attempt_at + locked_until).
--
-- The split is what keeps the limiter from being a lockout service: the steep
-- lock only ever shuts out the address that earned it, so somebody hammering a
-- classmate's username locks THEMSELVES out, not the classmate signing in from
-- home. The account ceiling is there for the one thing per-source backoff
-- cannot stop — many addresses guessing one account — and is set far above any
-- real student's use, so tripping it takes a sustained distributed effort.
--
-- Service-role only, like edge_rate_buckets: RLS on with no policies, no client
-- grants, and every function executable by service_role alone. They are
-- SECURITY INVOKER: the only caller already holds the table grants, so there is
-- nothing to elevate.

create table public.edge_login_attempts (
    key text primary key check (length(key) between 1 and 200),
    attempts int not null default 0 check (attempts >= 0),
    last_attempt_at timestamptz not null default now(),
    -- Source rows: the backoff lock.
    locked_until timestamptz,
    -- Account rows: the end of the current counting window.
    window_ends_at timestamptz
);

-- Housekeeping scans by age.
create index edge_login_attempts_last_attempt on public.edge_login_attempts (last_attempt_at);

alter table public.edge_login_attempts enable row level security;

revoke all on table public.edge_login_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.edge_login_attempts to service_role;

-- Count one attempt, or refuse it.
--
-- Called BEFORE the password is checked, holding both rows' locks, so parallel
-- requests are counted one at a time and a burst cannot outrun the count.
--
-- 1. The source's own backoff. Its p_free_attempts-th attempt is allowed and
--    arms the first lock (p_base_lock_ms); every attempt after that doubles it,
--    up to p_max_lock_ms. A source quiet for p_decay_ms starts over.
-- 2. The account ceiling: at most p_account_limit attempts per
--    p_account_window_ms window, from all sources together.
--
-- A refused attempt is counted NOWHERE: hammering a locked source does not
-- extend its lock, and cannot spend the account's shared ceiling either — only
-- attempts that were let through do.
--
-- Returns {ok: true, attempts, accountAttempts} or
-- {ok: false, retryAfterSec, scope: 'source' | 'account'}.
create or replace function public.begin_login_attempt (
    p_account_key text,
    p_source_key text,
    p_free_attempts int,
    p_base_lock_ms int,
    p_max_lock_ms int,
    p_decay_ms int,
    p_account_limit int,
    p_account_window_ms int
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    now_ts timestamptz := clock_timestamp();
    decay interval;
    acct public.edge_login_attempts%rowtype;
    src public.edge_login_attempts%rowtype;
    lock_ms bigint;
begin
    if p_account_key is null or length(p_account_key) not between 1 and 200
        or p_source_key is null or length(p_source_key) not between 1 and 200
        -- The source key must sit under its account key, so that clearing an
        -- account (clear_login_account) reaches every source row too.
        or length(p_source_key) <= length(p_account_key) + 1
        or left(p_source_key, length(p_account_key) + 1) <> p_account_key || ':'
        or p_free_attempts is null or p_free_attempts < 1
        or p_base_lock_ms is null or p_base_lock_ms < 1
        or p_max_lock_ms is null or p_max_lock_ms < p_base_lock_ms
        or p_decay_ms is null or p_decay_ms < 1
        or p_account_limit is null or p_account_limit < 1
        or p_account_window_ms is null or p_account_window_ms < 1 then
        raise exception 'begin_login_attempt: invalid arguments';
    end if;
    decay := make_interval(secs => p_decay_ms / 1000.0);

    -- Keep the table to keys that still mean something: a few long-quiet rows
    -- with no live lock or window go per call, skipping any another attempt
    -- holds.
    delete from public.edge_login_attempts
    where key in (
        select stale.key
        from public.edge_login_attempts stale
        where stale.last_attempt_at < now_ts - decay
          and (stale.locked_until is null or stale.locked_until <= now_ts)
          and (stale.window_ends_at is null or stale.window_ends_at <= now_ts)
          and stale.key <> p_account_key
          and stale.key <> p_source_key
        limit 20
        for update skip locked
    );

    -- Account row first, then the source row: every caller takes the two locks
    -- in the same order, so concurrent attempts on one account queue rather
    -- than deadlock. The no-op DO UPDATE is deliberate: unlike DO NOTHING it
    -- locks and returns an existing row in the same statement, so there is no
    -- gap in which another call's cleanup could delete it from under us.
    insert into public.edge_login_attempts as t (key, last_attempt_at)
    values (p_account_key, now_ts)
    on conflict (key) do update set key = t.key
    returning * into acct;

    insert into public.edge_login_attempts as t (key, last_attempt_at)
    values (p_source_key, now_ts)
    on conflict (key) do update set key = t.key
    returning * into src;

    if src.locked_until is not null and src.locked_until > now_ts then
        return jsonb_build_object(
            'ok', false,
            'scope', 'source',
            'retryAfterSec', greatest(1, ceil(extract(epoch from (src.locked_until - now_ts))))::int
        );
    end if;

    if acct.window_ends_at is null or acct.window_ends_at <= now_ts then
        acct.attempts := 0;
        acct.window_ends_at := now_ts + make_interval(secs => p_account_window_ms / 1000.0);
    end if;
    if acct.attempts >= p_account_limit then
        return jsonb_build_object(
            'ok', false,
            'scope', 'account',
            'retryAfterSec', greatest(1, ceil(extract(epoch from (acct.window_ends_at - now_ts))))::int
        );
    end if;
    acct.attempts := acct.attempts + 1;

    if src.last_attempt_at < now_ts - decay then
        src.attempts := 0;
    end if;
    src.attempts := src.attempts + 1;

    if src.attempts >= p_free_attempts then
        -- 2^20 x base is far past any sane ceiling; the cap keeps the power finite.
        lock_ms := least(
            p_max_lock_ms::bigint,
            p_base_lock_ms::bigint * (2::bigint ^ least(src.attempts - p_free_attempts, 20))::bigint
        );
        src.locked_until := now_ts + make_interval(secs => lock_ms / 1000.0);
    else
        src.locked_until := null;
    end if;

    update public.edge_login_attempts
    set attempts = acct.attempts,
        last_attempt_at = now_ts,
        window_ends_at = acct.window_ends_at
    where key = p_account_key;

    update public.edge_login_attempts
    set attempts = src.attempts,
        last_attempt_at = now_ts,
        locked_until = src.locked_until
    where key = p_source_key;

    return jsonb_build_object('ok', true, 'attempts', src.attempts, 'accountAttempts', acct.attempts);
end;
$$;

-- A successful sign-in: the misses from this source before it were typos. The
-- account ceiling is left alone — it caps guessing volume, and a student who
-- just signed in is nowhere near it.
create or replace function public.clear_login_attempts (p_key text) returns void
language sql
security invoker
set search_path = public
as $$
    delete from public.edge_login_attempts where key = p_key;
$$;

-- Forget everything about one account: its ceiling and every source's backoff.
-- The teacher's recovery path (student-provision 'reset') and a successful
-- student-claim call this, so a fresh setup card really is a way back in.
-- Returns the number of rows removed.
create or replace function public.clear_login_account (p_account_key text) returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
    removed int;
begin
    if p_account_key is null or length(p_account_key) not between 1 and 200 then
        raise exception 'clear_login_account: invalid arguments';
    end if;
    delete from public.edge_login_attempts
    where key = p_account_key
       or left(key, length(p_account_key) + 1) = p_account_key || ':';
    get diagnostics removed = row_count;
    return removed;
end;
$$;

revoke all on function public.begin_login_attempt (text, text, int, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.begin_login_attempt (text, text, int, int, int, int, int, int) to service_role;

revoke all on function public.clear_login_attempts (text) from public, anon, authenticated;
grant execute on function public.clear_login_attempts (text) to service_role;

revoke all on function public.clear_login_account (text) from public, anon, authenticated;
grant execute on function public.clear_login_account (text) to service_role;
