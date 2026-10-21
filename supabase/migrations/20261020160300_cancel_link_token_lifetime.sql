-- A cancel link's lifetime is fixed once, when it is asked for (Codex round 4
-- on #62, the cancel-link token lifecycle).
--
-- The link's token is derived from its billing_mail_outbox row (HMAC of the
-- row id, billingCancelStore.ts cancelLinkToken), so every retry of the row
-- mails the same link. Until now every retry also saved that token again with
-- a FRESH expiry -- an upsert on token_hash that set expires_at to "an hour
-- from this send". Two retries racing kept whichever wrote last, and a retry
-- that came after the link had expired, unused, made the same link valid
-- again for another hour.
--
-- Now:
--
--   * the expiry is computed once, when the request is written down, and kept
--     on the outbox row (`link_expires_at`, an hour after `created_at`); it is
--     never moved later;
--   * the token is saved only through save_cancel_link_token, by the worker
--     holding the row's lease, with the row's expiry, and INSERT ... ON
--     CONFLICT (token_hash) DO NOTHING -- the first save wins, and no retry
--     rewrites expires_at or used_at;
--   * a token's expires_at, too, can never be moved later;
--   * nothing is sent once the expiry has passed: the row is settled
--     `expired` ("expired before delivery"), keeping no address, and never
--     claimed again -- an expired link is never emailed.
--
-- tests/sql/cancel_link_lifetime.sql proves it, two sessions at once included.
--
-- Safe to re-run: every column, index and constraint is guarded, every
-- function is CREATE OR REPLACE, every trigger is dropped before it is made.

-- ---------------------------------------------------------------------------
-- billing_mail_outbox.link_expires_at: when a cancel link stops working
-- ---------------------------------------------------------------------------
alter table public.billing_mail_outbox add column if not exists link_expires_at timestamptz;

drop trigger if exists billing_mail_outbox_link_lifetime on public.billing_mail_outbox;

-- A request written down before this migration gets the hour it was asked
-- for, from when it was asked -- not from whenever it is next tried.
update public.billing_mail_outbox
set link_expires_at = created_at + interval '1 hour'
where kind = 'cancel_link' and link_expires_at is null;

alter table public.billing_mail_outbox drop constraint if exists billing_mail_outbox_link_expiry;
alter table public.billing_mail_outbox
add constraint billing_mail_outbox_link_expiry check ((kind = 'cancel_link') = (link_expires_at is not null));

-- Set on insert from created_at, whatever the insert says (an hour: cancelFlow.ts
-- CANCEL_LINK_TTL_MS); afterwards it may only be brought forward, which can
-- only ever make a link invalid sooner.
create or replace function public.billing_mail_outbox_link_lifetime ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        new.link_expires_at := case when new.kind = 'cancel_link' then new.created_at + interval '1 hour' end;
        return new;
    end if;
    if new.link_expires_at is distinct from old.link_expires_at
       and (old.link_expires_at is null or new.link_expires_at is null or new.link_expires_at > old.link_expires_at) then
        raise exception 'a cancel link''s expiry is set once, when it is asked for'
            using errcode = '55000';
    end if;
    return new;
end;
$$;

revoke all on function public.billing_mail_outbox_link_lifetime () from public, anon, authenticated, service_role;

create trigger billing_mail_outbox_link_lifetime
before insert or update on public.billing_mail_outbox
for each row execute function public.billing_mail_outbox_link_lifetime ();

-- `expired`: a cancel link whose hour ran out before it could be sent. Kept,
-- without its address, as the record of why nothing went; the tick drops it
-- with the other day-old cancel-link rows.
alter table public.billing_mail_outbox drop constraint if exists billing_mail_outbox_status_check;
alter table public.billing_mail_outbox
add constraint billing_mail_outbox_status_check check (status in ('pending', 'sent', 'expired'));

-- ---------------------------------------------------------------------------
-- billing_cancel_tokens.outbox_id: which request a token was mailed for
-- ---------------------------------------------------------------------------
alter table public.billing_cancel_tokens add column if not exists outbox_id uuid;

create index if not exists billing_cancel_tokens_outbox on public.billing_cancel_tokens (outbox_id);

drop trigger if exists billing_cancel_tokens_lifetime on public.billing_cancel_tokens;

-- A saved token keeps what it was saved with: the same link, account, mode and
-- request, and an expiry that can only come sooner.
create or replace function public.billing_cancel_tokens_lifetime ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.token_hash <> old.token_hash
       or new.user_id <> old.user_id
       or new.mode <> old.mode
       or new.outbox_id is distinct from old.outbox_id
       or new.expires_at > old.expires_at then
        raise exception 'a saved cancel link keeps its expiry and what it cancels'
            using errcode = '55000';
    end if;
    return new;
end;
$$;

revoke all on function public.billing_cancel_tokens_lifetime () from public, anon, authenticated, service_role;

create trigger billing_cancel_tokens_lifetime
before update on public.billing_cancel_tokens
for each row execute function public.billing_cancel_tokens_lifetime ();

-- ---------------------------------------------------------------------------
-- save_cancel_link_token: the one way a cancel link is saved
-- ---------------------------------------------------------------------------
-- Answers:
--   saved    -- the token is stored (now, or by an earlier attempt at this row,
--               whose expiry and used_at are left exactly as they were);
--   expired  -- the row's expiry has passed: nothing is saved, and the caller
--               must not send but settle the row `expired`;
--   not_held -- the caller does not hold this row's lease (another worker took
--               it over, or the row was settled): it must not send.
-- The row is locked FOR UPDATE, so two saves of one row run one after the
-- other, and its expiry -- not the caller's clock -- is the token's.
create or replace function public.save_cancel_link_token (
    p_outbox_id uuid,
    p_claim uuid,
    p_hash text,
    p_user uuid
) returns text
language plpgsql
set search_path = ''
as $$
declare
    v_mode text;
    v_expires timestamptz;
begin
    select o.mode, o.link_expires_at into v_mode, v_expires
    from public.billing_mail_outbox o
    where o.id = p_outbox_id
      and o.claim_token = p_claim
      and o.kind = 'cancel_link'
      and o.status = 'pending'
    for update;
    if not found then
        return 'not_held';
    end if;
    if v_expires <= now() then
        return 'expired';
    end if;

    insert into public.billing_cancel_tokens (token_hash, user_id, mode, expires_at, outbox_id)
    values (p_hash, p_user, v_mode, v_expires, p_outbox_id)
    on conflict (token_hash) do nothing;
    return 'saved';
end;
$$;

revoke all on function public.save_cancel_link_token (uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.save_cancel_link_token (uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- settle_billing_mail: and `expired`
-- ---------------------------------------------------------------------------
-- As 20261020160200 defines it, plus `expired` for a cancel link whose hour ran
-- out before it was sent: settled for good -- lease cleared, the address taken
-- out of the payload, the reason kept -- and, no longer pending, never claimed
-- again.
create or replace function public.settle_billing_mail (
    p_id uuid,
    p_claim uuid,
    p_outcome text,
    p_error text default null,
    p_retry_after interval default null
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
    v_kind text;
begin
    select o.kind into v_kind
    from public.billing_mail_outbox o
    where o.id = p_id and o.claim_token = p_claim
    for update;
    if not found then
        return false;
    end if;

    if p_outcome = 'sent' and v_kind <> 'cancel_link' then
        update public.billing_mail_outbox
        set status = 'sent', sent_at = now(), claim_token = null, claimed_until = null, last_error = null
        where id = p_id;
    elsif p_outcome in ('sent', 'done') then
        delete from public.billing_mail_outbox where id = p_id;
    elsif p_outcome = 'retry' then
        update public.billing_mail_outbox
        set claim_token = null,
            claimed_until = null,
            last_error = left(p_error, 500),
            next_attempt_at = now() + coalesce(p_retry_after, interval '1 minute')
        where id = p_id;
    elsif p_outcome = 'expired' and v_kind = 'cancel_link' then
        update public.billing_mail_outbox
        set status = 'expired',
            claim_token = null,
            claimed_until = null,
            last_error = left(coalesce(p_error, 'expired before delivery'), 500),
            payload = payload - 'email'
        where id = p_id;
    else
        raise exception 'unknown outcome % for %', p_outcome, v_kind using errcode = '22023';
    end if;
    return true;
end;
$$;

revoke all on function public.settle_billing_mail (uuid, uuid, text, text, interval) from public, anon, authenticated;
grant execute on function public.settle_billing_mail (uuid, uuid, text, text, interval) to service_role;
