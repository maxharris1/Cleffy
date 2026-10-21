-- A deleted cancel link cannot be put back by a transaction running at the
-- same time as its deletion (Codex round 6 on #62, the round-5 major 1 still
-- open; decisions 29 and 34).
--
-- 20261020160400 tombstones every deleted token and refuses a tombstoned hash
-- or outbox id on insert -- but the insert's trigger read the tombstones
-- without a lock. Transaction A deletes hash H (the tick's cleanup, or an
-- account's deletion) and writes its tombstone; until A commits, B cannot see
-- it. B inserts H against a fresh pending request -- or a new hash under A's
-- outbox id -- finds no tombstone, waits at most on A's deleted row, and once
-- A commits H is free: the spent link is back, unused. And the outbox id's
-- tombstone was not unique. Now:
--
--   * every path that deletes a token and every path that inserts one takes
--     the same transaction advisory locks, the token's outbox id first, then
--     its hash (billing_cancel_link_lock, keys from
--     billing_cancel_link_lock_key below), and the insert reads the
--     tombstones only once it holds them. A delete takes them before the row
--     goes (a BEFORE DELETE trigger, whoever deletes; the tick for all its
--     rows at once, before its delete), so they are held until its tombstone
--     commits: an insert of that hash or that outbox id waits for it, and
--     then sees the tombstone. Under READ COMMITTED every statement reads
--     afresh, so the read after the wait is current; an insert under any
--     other isolation level, whose snapshot may predate the delete it waited
--     for, is refused;
--   * save_cancel_link_token_v2 takes them too, after the row's lock and
--     before it reads the tombstones (and its insert's trigger again, which
--     the transaction already holds);
--   * the tick takes all of its rows' locks before deleting any: every outbox
--     id, then every hash, each in key order. Every other path takes one
--     outbox id and then one hash, so no two paths wait for each other in a
--     circle;
--   * an outbox id is tombstoned once (a unique index). A request with two
--     tokens -- its link saved again after the cancel-link secret was rotated
--     -- keeps both hashes; the second tombstone just leaves the id out. Any
--     duplicates already kept keep their hashes, and all but the earliest
--     lose the id.
--
-- The lock keys: hashtextextended('cleffy.billing_cancel_link.<kind>:<value>',
-- 0), kind `outbox` (the uuid as text) or `hash` (the SHA-256 hex). The
-- namespace keeps them apart from each other and from any other advisory lock
-- in this database; a collision only makes two unrelated saves wait for each
-- other. The same function computes them on every path, so they always agree.
--
-- tests/sql/cancel_link_tombstone_race.sql proves it with two sessions racing
-- a third.
--
-- Safe to re-run: every function is CREATE OR REPLACE, every trigger is
-- dropped before it is made, the index is IF NOT EXISTS (and the one it
-- replaces dropped IF EXISTS), the de-duplication changes nothing once there
-- is nothing to change, and grants and revokes are idempotent.

-- ---------------------------------------------------------------------------
-- The history locks
-- ---------------------------------------------------------------------------
create or replace function public.billing_cancel_link_lock_key (p_kind text, p_value text)
returns bigint
language sql
immutable
set search_path = ''
as $$
    select pg_catalog.hashtextextended('cleffy.billing_cancel_link.' || p_kind || ':' || p_value, 0)
$$;

revoke all on function public.billing_cancel_link_lock_key (text, text) from public, anon, authenticated, service_role;

-- Held until the transaction ends. Outbox id first, then hash: the one order
-- every path takes them in.
create or replace function public.billing_cancel_link_lock (p_outbox_id uuid, p_hash text)
returns void
language plpgsql
set search_path = ''
as $$
begin
    if p_outbox_id is not null then
        perform pg_catalog.pg_advisory_xact_lock(public.billing_cancel_link_lock_key ('outbox', p_outbox_id::text));
    end if;
    if p_hash is not null then
        perform pg_catalog.pg_advisory_xact_lock(public.billing_cancel_link_lock_key ('hash', p_hash));
    end if;
end;
$$;

revoke all on function public.billing_cancel_link_lock (uuid, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- billing_cancel_token_tombstones: an outbox id once
-- ---------------------------------------------------------------------------
-- In one block, under one lock, so no duplicate lands between the clean-up
-- and the index. The permanence trigger is set aside only for that clean-up,
-- which keeps every hash.
do $$
begin
    lock table public.billing_cancel_token_tombstones in share row exclusive mode;
    if exists (
        select 1 from public.billing_cancel_token_tombstones
        where outbox_id is not null
        group by outbox_id
        having count(*) > 1
    ) then
        alter table public.billing_cancel_token_tombstones disable trigger billing_cancel_token_tombstones_permanent;
        update public.billing_cancel_token_tombstones t
        set outbox_id = null
        where t.outbox_id is not null
          and exists (
              select 1 from public.billing_cancel_token_tombstones k
              where k.outbox_id = t.outbox_id
                and (k.deleted_at, k.token_hash) < (t.deleted_at, t.token_hash)
          );
        alter table public.billing_cancel_token_tombstones enable trigger billing_cancel_token_tombstones_permanent;
    end if;
    create unique index if not exists billing_cancel_token_tombstones_outbox_once
    on public.billing_cancel_token_tombstones (outbox_id)
    where outbox_id is not null;
    drop index if exists public.billing_cancel_token_tombstones_outbox;
end;
$$;

-- ---------------------------------------------------------------------------
-- billing_cancel_tokens: locked on delete, locked before the check on insert
-- ---------------------------------------------------------------------------
-- Every delete, whoever makes it (the tick, which already holds them, an
-- account's cascade, an operator), takes the row's locks before the row goes.
-- SECURITY DEFINER: the service role, which may delete, may not lock directly.
create or replace function public.billing_cancel_tokens_delete_lock ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.billing_cancel_link_lock (old.outbox_id, old.token_hash);
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_delete_lock () from public, anon, authenticated, service_role;

drop trigger if exists billing_cancel_tokens_delete_lock on public.billing_cancel_tokens;
create trigger billing_cancel_tokens_delete_lock
before delete on public.billing_cancel_tokens
for each row execute function public.billing_cancel_tokens_delete_lock ();

-- The tombstone, as 20261020160400 writes it, under the same locks -- and when
-- the outbox id is already tombstoned (a second token for one request), the
-- hash alone.
create or replace function public.billing_cancel_tokens_tombstone ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.billing_cancel_link_lock (old.outbox_id, old.token_hash);
    insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
    values (old.token_hash, old.outbox_id)
    on conflict do nothing;
    if not found then
        insert into public.billing_cancel_token_tombstones (token_hash, outbox_id)
        values (old.token_hash, null)
        on conflict (token_hash) do nothing;
    end if;
    return old;
end;
$$;

revoke all on function public.billing_cancel_tokens_tombstone () from public, anon, authenticated, service_role;

-- A deleted link's hash, or any token for a deleted link's request, never goes
-- in again -- now also not while that deletion is still uncommitted: the
-- locks first, the tombstones after.
create or replace function public.billing_cancel_tokens_not_tombstoned ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'a cancel link is only saved under READ COMMITTED, where its history is read after its locks'
            using errcode = '55000';
    end if;
    perform public.billing_cancel_link_lock (new.outbox_id, new.token_hash);
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

-- ---------------------------------------------------------------------------
-- save_cancel_link_token_v2: the history locks before the history
-- ---------------------------------------------------------------------------
-- As 20261020160500 defines it (its answers are unchanged), with the locks
-- taken after the row's and before the tombstones are read.
create or replace function public.save_cancel_link_token_v2 (
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

    perform public.billing_cancel_link_lock (p_outbox_id, p_hash);

    if exists (
        select 1 from public.billing_cancel_token_tombstones t
        where t.token_hash = p_hash or t.outbox_id = p_outbox_id
    ) then
        update public.billing_mail_outbox
        set status = 'expired', last_error = 'cancel link already spent or removed', payload = payload - 'email'
        where id = p_outbox_id;
        return jsonb_build_object('answer', 'spent', 'remaining_seconds', 0);
    end if;

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

revoke all on function public.save_cancel_link_token_v2 (uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.save_cancel_link_token_v2 (uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The cron tick: every lock first, then the delete
-- ---------------------------------------------------------------------------
-- As 20261020160400 defines it, except the cleanup: it takes the locks of
-- every token it is about to delete -- every outbox id, then every hash, each
-- in key order -- and only then deletes them, under the same conditions read
-- again. Each deleted token's tombstone is written by the delete trigger, in
-- the deleting statement; one that cannot be written fails the delete.
create or replace function public.billing_mail_outbox_tick ()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
    v_url text;
    v_secret text;
    v_hashes text[];
    v_key bigint;
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
    select array_agg(t.token_hash) into v_hashes
    from public.billing_cancel_tokens t
    where t.expires_at <= now()
      and not exists (
          select 1 from public.billing_mail_outbox o where o.id = t.outbox_id and o.status = 'pending'
      );
    if v_hashes is not null then
        for v_key in
            select k.key
            from (
                select 1 as rank, public.billing_cancel_link_lock_key ('outbox', t.outbox_id::text) as key
                from public.billing_cancel_tokens t
                where t.token_hash = any (v_hashes) and t.outbox_id is not null
                union
                select 2, public.billing_cancel_link_lock_key ('hash', h)
                from unnest(v_hashes) h
            ) k
            order by k.rank, k.key
        loop
            perform pg_advisory_xact_lock(v_key);
        end loop;
        delete from public.billing_cancel_tokens t
        where t.token_hash = any (v_hashes)
          and t.expires_at <= now()
          and not exists (
              select 1 from public.billing_mail_outbox o where o.id = t.outbox_id and o.status = 'pending'
          );
    end if;

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
