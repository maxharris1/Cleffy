-- A spent cancel link never comes back, and whether a link can still be sent
-- is the database's call, on its own clock (Codex round 5 on #62, new majors
-- 1 and 2; decisions 29 and 30).
--
-- Major 1. 20261020160300 stops a retry reviving a spent link, but once the
-- cleanup has deleted a token nothing remembered it: the service role could
-- insert the same hash, unused, against any fresh pending cancel-link row
-- (the token trigger checked the row, not the hash's history), and a request
-- re-created under the deleted row's id recreated the same HMAC token
-- (billingCancelStore.ts cancelLinkToken) through the ordinary save. Now:
--
--   * every deleted token leaves a permanent tombstone -- its hash and its
--     outbox id, and when, nothing else: no user, no address, no mode
--     (`billing_cancel_token_tombstones`). The cron tick's cleanup writes it in
--     the statement that deletes the token, and a trigger writes it for every
--     other delete (an account's, an operator's);
--   * a token whose hash or outbox id is tombstoned is refused on INSERT by a
--     trigger, whoever inserts it, the table's owner included;
--   * save_cancel_link_token refuses a tombstoned hash or outbox id before it
--     gets that far, and settles the row for good (`expired`, "cancel link
--     already spent or removed") instead of leaving it to retry; a settled
--     row is never pending again (20261020160300), so it is refused too;
--   * the service role may no longer INSERT tokens at all (or TRUNCATE them,
--     which would skip the tombstones): save_cancel_link_token, now SECURITY
--     DEFINER, is the one way in. It keeps SELECT, UPDATE (billing-cancel
--     spends a link) and DELETE (each delete is tombstoned);
--   * nobody may update, delete or truncate a tombstone. Only the SECURITY
--     DEFINER functions below write them; the service role may read them.
--
-- Major 2. save_cancel_link_token compared the expiry with now() -- the time
-- its transaction STARTED. A save that began before the expiry and waited on
-- the row's lock until after it still passed, and the edge function's own
-- final check, on its own clock, could pass too. Now the save reads
-- clock_timestamp() after it holds the row's lock, refuses -- and settles the
-- row `expired`, without its address -- with less than 120 seconds left, and
-- answers how many seconds are left on that clock. cancelFlow.ts sends on
-- that answer alone (CANCEL_LINK_SEND_MARGIN_S), never on its own clock. The
-- token trigger's expiry check reads clock_timestamp() too.
--
-- save_cancel_link_token now answers jsonb {answer, remaining_seconds}, so it
-- is dropped and recreated: a function's result type cannot be replaced. The
-- edge function that reads it ships in the same PR; until it is deployed the
-- previous one reads an answer it does not know, throws, and retries the row
-- -- it never sends on it.
--
-- tests/sql/cancel_link_tombstones.sql and tests/sql/cancel_link_db_clock.sql
-- prove it, the latter with a second session holding the row's lock.
--
-- Safe to re-run: the table and index are IF NOT EXISTS, every trigger is
-- dropped before it is made, every function is CREATE OR REPLACE (the save
-- dropped first, IF EXISTS), and grants and revokes are idempotent.

-- ---------------------------------------------------------------------------
-- billing_cancel_token_tombstones: every cancel link that was ever deleted
-- ---------------------------------------------------------------------------
create table if not exists public.billing_cancel_token_tombstones (
    token_hash text primary key,
    -- Null only for a token saved before 20261020160300 gave tokens a row.
    outbox_id uuid,
    deleted_at timestamptz not null default now()
);

create index if not exists billing_cancel_token_tombstones_outbox on public.billing_cancel_token_tombstones (outbox_id)
where outbox_id is not null;

alter table public.billing_cancel_token_tombstones enable row level security;

revoke all on table public.billing_cancel_token_tombstones from public, anon, authenticated, service_role;
grant select on table public.billing_cancel_token_tombstones to service_role;

-- What is kept is kept: no update, delete or truncate, by anyone -- and for
-- billing_cancel_tokens, no truncate, which would delete tokens without
-- leaving their tombstones.
create or replace function public.billing_cancel_link_history_kept ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_table_name = 'billing_cancel_token_tombstones' then
        raise exception 'a cancel link''s tombstone is permanent'
            using errcode = '55000';
    end if;
    raise exception 'cancel links are deleted one at a time, so each leaves its tombstone'
        using errcode = '55000';
end;
$$;

revoke all on function public.billing_cancel_link_history_kept () from public, anon, authenticated, service_role;

drop trigger if exists billing_cancel_token_tombstones_permanent on public.billing_cancel_token_tombstones;
create trigger billing_cancel_token_tombstones_permanent
before update or delete on public.billing_cancel_token_tombstones
for each row execute function public.billing_cancel_link_history_kept ();

drop trigger if exists billing_cancel_token_tombstones_no_truncate on public.billing_cancel_token_tombstones;
create trigger billing_cancel_token_tombstones_no_truncate
before truncate on public.billing_cancel_token_tombstones
for each statement execute function public.billing_cancel_link_history_kept ();

drop trigger if exists billing_cancel_tokens_no_truncate on public.billing_cancel_tokens;
create trigger billing_cancel_tokens_no_truncate
before truncate on public.billing_cancel_tokens
for each statement execute function public.billing_cancel_link_history_kept ();

-- ---------------------------------------------------------------------------
-- billing_cancel_tokens: tombstoned on delete, refused on insert
-- ---------------------------------------------------------------------------
-- Every delete, whoever makes it -- the tick (which writes the tombstone
-- itself as well), an account's cascade, an operator. SECURITY DEFINER: none
-- of them may write the tombstone table themselves.
create or replace function public.billing_cancel_tokens_tombstone ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
    values (old.token_hash, old.outbox_id)
    on conflict (token_hash) do nothing;
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_tombstone () from public, anon, authenticated, service_role;

drop trigger if exists billing_cancel_tokens_tombstone on public.billing_cancel_tokens;
create trigger billing_cancel_tokens_tombstone
after delete on public.billing_cancel_tokens
for each row execute function public.billing_cancel_tokens_tombstone ();

-- A deleted link's hash, or any token for a deleted link's request, never goes
-- in again: not through the save, not by the service role (which may not
-- insert at all), not by the table's owner. SECURITY DEFINER to read the
-- tombstones, which the inserting role may not.
create or replace function public.billing_cancel_tokens_not_tombstoned ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if exists (
        select 1 from public.billing_cancel_token_tombstones t
        where t.token_hash = new.token_hash
           or (new.outbox_id is not null and t.outbox_id = new.outbox_id)
    ) then
        raise exception 'a cancel link that was spent or removed never comes back'
            using errcode = '55000';
    end if;
    return new;
end;
$$;

revoke all on function public.billing_cancel_tokens_not_tombstoned () from public, anon, authenticated, service_role;

drop trigger if exists billing_cancel_tokens_not_tombstoned on public.billing_cancel_tokens;
create trigger billing_cancel_tokens_not_tombstoned
before insert on public.billing_cancel_tokens
for each row execute function public.billing_cancel_tokens_not_tombstoned ();

-- The token table's own guard, as 20261020160300 defines it, with the
-- insert's expiry check on the real clock rather than the transaction's.
create or replace function public.billing_cancel_tokens_lifetime ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_status text;
    v_kind text;
    v_expires timestamptz;
begin
    if tg_op = 'INSERT' then
        select o.status, o.kind, o.link_expires_at into v_status, v_kind, v_expires
        from public.billing_mail_outbox o
        where o.id = new.outbox_id;
        if new.outbox_id is null or v_kind is distinct from 'cancel_link' or v_status is distinct from 'pending'
           or v_expires <= clock_timestamp() then
            raise exception 'a cancel link is only saved for its own request, while it waits to send and before it expires'
                using errcode = '55000';
        end if;
        new.expires_at := v_expires;
        return new;
    end if;

    if tg_op = 'UPDATE' then
        if new.token_hash <> old.token_hash
           or new.user_id <> old.user_id
           or new.mode <> old.mode
           or new.outbox_id is distinct from old.outbox_id
           or new.expires_at > old.expires_at then
            raise exception 'a saved cancel link keeps its expiry and what it cancels'
                using errcode = '55000';
        end if;
        if old.used_at is not null and new.used_at is distinct from old.used_at then
            raise exception 'a spent cancel link stays spent'
                using errcode = '55000';
        end if;
        return new;
    end if;

    -- DELETE
    if exists (select 1 from auth.users u where u.id = old.user_id)
       and (old.expires_at > now()
            or exists (select 1 from public.billing_mail_outbox o where o.id = old.outbox_id and o.status = 'pending')) then
        raise exception 'a cancel link is kept until it has expired and its request can no longer be retried'
            using errcode = '55000';
    end if;
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_lifetime () from public, anon, authenticated, service_role;

-- All writes of a new token go through save_cancel_link_token.
revoke insert, truncate on table public.billing_cancel_tokens from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- save_cancel_link_token: on the database's clock, after the lock
-- ---------------------------------------------------------------------------
-- Answers {"answer": ..., "remaining_seconds": n}:
--   saved    -- the token is stored (now, or by an earlier attempt at this row,
--               whose expiry and used_at are left exactly as they were), with
--               n >= 120 seconds left: the caller may send, and only then;
--   expired  -- fewer than 120 seconds are left (n, at most 119, never below
--               0): nothing is saved, the row is settled `expired` without its
--               address, and the caller must not send;
--   spent    -- this link (its hash) or its request (the row id) was deleted
--               before: nothing is saved, the row is settled `expired`, and
--               the caller must not send;
--   not_held -- the caller does not hold this row's lease (another worker took
--               it over, or the row was settled): it must not send.
-- The row is locked FOR UPDATE first, so two saves of one row run one after
-- the other, and the clock is read only once the lock is held: however long
-- the wait, the time left is the time left now. A row settled here keeps its
-- lease, so the worker holding it records the outcome as it would have.
-- SECURITY DEFINER: the service role no longer inserts tokens itself.
drop function if exists public.save_cancel_link_token (uuid, uuid, text, uuid);

create or replace function public.save_cancel_link_token (
    p_outbox_id uuid,
    p_claim uuid,
    p_hash text,
    p_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_mode text;
    v_expires timestamptz;
    v_left integer;
begin
    select o.mode, o.link_expires_at into v_mode, v_expires
    from public.billing_mail_outbox o
    where o.id = p_outbox_id
      and o.claim_token = p_claim
      and o.kind = 'cancel_link'
      and o.status = 'pending'
    for update;
    if not found then
        return jsonb_build_object('answer', 'not_held', 'remaining_seconds', 0);
    end if;

    if exists (
        select 1 from public.billing_cancel_token_tombstones t
        where t.token_hash = p_hash or t.outbox_id = p_outbox_id
    ) then
        update public.billing_mail_outbox
        set status = 'expired', last_error = 'cancel link already spent or removed', payload = payload - 'email'
        where id = p_outbox_id;
        return jsonb_build_object('answer', 'spent', 'remaining_seconds', 0);
    end if;

    -- A token an earlier attempt saved may have had its expiry brought
    -- forward since; the sooner of the two is the one that counts.
    v_expires := least(v_expires, (select t.expires_at from public.billing_cancel_tokens t where t.token_hash = p_hash));
    if v_expires is null
       or v_expires - clock_timestamp() < interval '120 seconds' then
        v_left := greatest(0, coalesce(floor(extract(epoch from v_expires - clock_timestamp()))::integer, 0));
        update public.billing_mail_outbox
        set status = 'expired', last_error = 'expired before delivery', payload = payload - 'email'
        where id = p_outbox_id;
        return jsonb_build_object('answer', 'expired', 'remaining_seconds', v_left);
    end if;
    v_left := floor(extract(epoch from v_expires - clock_timestamp()))::integer;

    insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
    values (p_hash, p_user, v_mode, v_expires, p_outbox_id)
    on conflict (token_hash) do nothing;
    return jsonb_build_object('answer', 'saved', 'remaining_seconds', v_left);
end;
$$;

revoke all on function public.save_cancel_link_token (uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.save_cancel_link_token (uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The cron tick: and the tombstone, in the statement that deletes the token
-- ---------------------------------------------------------------------------
-- As 20261020160300 defines it; the cleanup now writes each deleted token's
-- tombstone in the same statement (the delete trigger would too -- whichever
-- lands first, the other does nothing). A tombstone that cannot be written
-- fails the delete with it.
create or replace function public.billing_mail_outbox_tick ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    v_url text;
    v_secret text;
begin
    -- A sent confirmation is only needed as a de-duplication key while Stripe
    -- may still redeliver its event (three days); 30 is generous.
    delete from public.billing_mail_outbox
    where status = 'sent' and sent_at < now() - interval '30 days';
    -- A cancel link asked for a day ago is not one anybody is still waiting
    -- for, and the row holds an address. (Its hour ran out long before.)
    delete from public.billing_mail_outbox
    where kind = 'cancel_link' and created_at < now() - interval '1 day';
    -- Expired cancel links whose request can no longer be retried, each
    -- leaving its tombstone.
    with gone as (
        delete from public.billing_cancel_tokens t
        where t.expires_at <= now()
          and not exists (
              select 1 from public.billing_mail_outbox o where o.id = t.outbox_id and o.status = 'pending'
          )
        returning t.token_hash, t.outbox_id
    )
    insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
    select gone.token_hash, gone.outbox_id from gone
    on conflict (token_hash) do nothing;

    if not exists (
        select 1 from public.billing_mail_outbox
        where status = 'pending' and next_attempt_at <= now()
          and (claimed_until is null or claimed_until < now())
    ) then
        return;
    end if;

    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'billing_outbox_url' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'billing_outbox_secret' limit 1;
    if v_url is null or v_secret is null or length(trim(v_url)) = 0 then
        raise notice 'billing_mail_outbox_tick: vault secrets billing_outbox_url/billing_outbox_secret missing — skip';
        return;
    end if;

    perform net.http_post(
        url := rtrim(v_url, '/'),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-outbox-secret', v_secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
    );
end;
$$;

revoke all on function public.billing_mail_outbox_tick () from public, anon, authenticated;
grant execute on function public.billing_mail_outbox_tick () to service_role;
