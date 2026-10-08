-- Per-account failed-sign-in throttling for student-login (see
-- supabase/functions/_shared/loginThrottle.ts for why the per-IP limit is not
-- enough: GoTrue only ever sees the edge function's IP).
--
-- One row per throttled key — `student-login:<sha256(username)>`, never the
-- username itself. Service-role only, like edge_rate_buckets: RLS on with no
-- policies, no client grants, and both functions executable by service_role
-- alone. They are SECURITY INVOKER: the only caller already holds the table
-- grants, so there is nothing to elevate.

create table public.edge_login_attempts (
    key text primary key check (length(key) between 1 and 200),
    attempts int not null default 0 check (attempts >= 0),
    last_attempt_at timestamptz not null default now(),
    locked_until timestamptz
);

-- Housekeeping scans by age.
create index edge_login_attempts_last_attempt on public.edge_login_attempts (last_attempt_at);

alter table public.edge_login_attempts enable row level security;

revoke all on table public.edge_login_attempts from public, anon, authenticated;
grant select, insert, update, delete on table public.edge_login_attempts to service_role;

-- Count one attempt against p_key, or refuse it while the key is locked.
--
-- Called BEFORE the password is checked, under a row lock, so parallel
-- requests are counted one at a time and a burst cannot outrun the count. The
-- p_free_attempts-th attempt is allowed and arms the first lockout
-- (p_base_lock_ms); every attempt after a lockout doubles it, up to
-- p_max_lock_ms. Refused attempts are NOT counted, so hammering a locked key
-- does not extend the lock — only attempts that were let through do. A key
-- with no attempt for p_decay_ms starts over.
--
-- Returns {ok: true, attempts} or {ok: false, retryAfterSec}.
create or replace function public.begin_login_attempt (
    p_key text,
    p_free_attempts int,
    p_base_lock_ms int,
    p_max_lock_ms int,
    p_decay_ms int
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    now_ts timestamptz := clock_timestamp();
    decay interval;
    rec public.edge_login_attempts%rowtype;
    lock_ms bigint;
begin
    if p_key is null or length(p_key) not between 1 and 200
        or p_free_attempts is null or p_free_attempts < 1
        or p_base_lock_ms is null or p_base_lock_ms < 1
        or p_max_lock_ms is null or p_max_lock_ms < p_base_lock_ms
        or p_decay_ms is null or p_decay_ms < 1 then
        raise exception 'begin_login_attempt: invalid arguments';
    end if;
    decay := make_interval(secs => p_decay_ms / 1000.0);

    -- Keep the table to keys that still mean something: a few long-quiet,
    -- unlocked rows go per call, skipping any another attempt holds.
    delete from public.edge_login_attempts
    where key in (
        select stale.key
        from public.edge_login_attempts stale
        where stale.last_attempt_at < now_ts - decay
          and (stale.locked_until is null or stale.locked_until <= now_ts)
          and stale.key <> p_key
        limit 20
        for update skip locked
    );

    insert into public.edge_login_attempts (key, attempts, last_attempt_at)
    values (p_key, 0, now_ts)
    on conflict (key) do nothing;

    select * into rec from public.edge_login_attempts where key = p_key for update;

    if rec.locked_until is not null and rec.locked_until > now_ts then
        return jsonb_build_object(
            'ok', false,
            'retryAfterSec', greatest(1, ceil(extract(epoch from (rec.locked_until - now_ts))))::int
        );
    end if;

    if rec.last_attempt_at < now_ts - decay then
        rec.attempts := 0;
    end if;
    rec.attempts := rec.attempts + 1;

    if rec.attempts >= p_free_attempts then
        -- 2^20 x base is far past any sane ceiling; the cap keeps the power finite.
        lock_ms := least(
            p_max_lock_ms::bigint,
            p_base_lock_ms::bigint * (2::bigint ^ least(rec.attempts - p_free_attempts, 20))::bigint
        );
        rec.locked_until := now_ts + make_interval(secs => lock_ms / 1000.0);
    else
        rec.locked_until := null;
    end if;

    update public.edge_login_attempts
    set attempts = rec.attempts,
        last_attempt_at = now_ts,
        locked_until = rec.locked_until
    where key = p_key;

    return jsonb_build_object('ok', true, 'attempts', rec.attempts);
end;
$$;

-- A successful sign-in: the misses before it were typos.
create or replace function public.clear_login_attempts (p_key text) returns void
language sql
security invoker
set search_path = public
as $$
    delete from public.edge_login_attempts where key = p_key;
$$;

revoke all on function public.begin_login_attempt (text, int, int, int, int) from public, anon, authenticated;
grant execute on function public.begin_login_attempt (text, int, int, int, int) to service_role;

revoke all on function public.clear_login_attempts (text) from public, anon, authenticated;
grant execute on function public.clear_login_attempts (text) to service_role;
