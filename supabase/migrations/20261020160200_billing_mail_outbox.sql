-- A durable outbox for billing mail (launch compliance fix pass, Codex findings
-- 3 and 4 on #62).
--
-- Finding 3: the purchase and cancellation confirmations -- mail the law wants
-- sent (CA BPC §17602(a)(3), the EU durable-medium confirmation) -- were sent
-- inline from the webhook and their failure swallowed: a Resend error was a
-- log line, the event was marked done, and Stripe's redelivery exited as a
-- duplicate, so nothing ever tried again. An isolate dying after claiming a
-- notice in `billing_notices` left a claim nobody would ever release.
--
-- Finding 4: the signed-out cancel form answered a subscriber differently from
-- everyone else whenever the mail budget was spent or Resend failed (503 vs
-- 200), which told anyone typing an address whether it subscribes.
--
-- Both are answered by writing the mail down FIRST and sending it after:
--
--   * the webhook enqueues the confirmation (idempotently, keyed on the Stripe
--     object) in the same delivery that applies the purchase, and a failure to
--     enqueue fails the event so Stripe redelivers it -- the event is never
--     marked done with its mail unrecorded;
--   * /cancel enqueues a request for EVERY well-formed address and answers the
--     same thing for all of them; whether there is a subscription, a budget, or
--     a working mail provider is decided later, by the worker, where nobody is
--     waiting on the answer;
--   * the worker (billing-mail-outbox, poked after each enqueue and by the cron
--     below) claims due rows under an expiring lease, so a worker that dies
--     mid-send leaves a row the next tick picks up, never a stuck claim, and
--     retries with backoff until the mail goes out.
--
-- `billing_notices` (20261020160000) did the de-duplication half of this and
-- is replaced by the outbox's unique (kind, dedupe_key).
--
-- What a row holds: confirmations carry the user id and what the email says,
-- never an address (it is read from auth.users at send time, so an address
-- changed in between gets the mail). A cancel-link request carries the address
-- that was typed, because that is the lookup it has yet to make; it is deleted
-- as soon as it is handled, and the cron drops any that are a day old.

create table public.billing_mail_outbox (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('purchase_confirmation', 'cancellation_confirmation', 'cancel_link')),
    -- The Checkout Session for a purchase, subscription id + end for a
    -- cancellation. Null for cancel-link requests, which are not de-duplicated
    -- here (the worker's per-recipient limit does that).
    dedupe_key text,
    mode text not null check (mode in ('live', 'test')),
    payload jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'sent')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    -- The lease a worker holds while it sends. Expires on its own, which is what
    -- makes a worker dying mid-send recoverable.
    claim_token uuid,
    claimed_until timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    sent_at timestamptz,
    check ((kind = 'cancel_link') = (dedupe_key is null))
);

create unique index billing_mail_outbox_dedupe on public.billing_mail_outbox (kind, dedupe_key)
where dedupe_key is not null;

create index billing_mail_outbox_due on public.billing_mail_outbox (next_attempt_at)
where status = 'pending';

alter table public.billing_mail_outbox enable row level security;

revoke all on table public.billing_mail_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_mail_outbox to service_role;

-- ---------------------------------------------------------------------------
-- enqueue_billing_mail: write a mail down, once
-- ---------------------------------------------------------------------------
-- Idempotent on (kind, dedupe_key): a redelivered event enqueues nothing new,
-- and answers with the row it already has. Raises rather than answering null on
-- anything else, so the caller can fail the event instead of losing the mail.
create or replace function public.enqueue_billing_mail (
    p_kind text,
    p_dedupe_key text,
    p_mode text,
    p_payload jsonb
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
    v_id uuid;
begin
    insert into public.billing_mail_outbox (kind, dedupe_key, mode, payload)
    values (p_kind, p_dedupe_key, p_mode, p_payload)
    on conflict (kind, dedupe_key) where dedupe_key is not null do nothing
    returning id into v_id;

    if v_id is null then
        select o.id into v_id
        from public.billing_mail_outbox o
        where o.kind = p_kind and o.dedupe_key = p_dedupe_key;
    end if;
    return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_billing_mail: lease the rows that are due
-- ---------------------------------------------------------------------------
-- SKIP LOCKED so two workers (the poke after an enqueue and the cron tick)
-- never take the same row; the lease (`claimed_until`) so a worker that dies
-- holding a row only delays it.
create or replace function public.claim_billing_mail (p_limit integer, p_lease interval)
returns setof public.billing_mail_outbox
language plpgsql
set search_path = ''
as $$
begin
    return query
    update public.billing_mail_outbox o
    set claim_token = gen_random_uuid(),
        claimed_until = now() + p_lease,
        attempts = o.attempts + 1
    where o.id in (
        select d.id
        from public.billing_mail_outbox d
        where d.status = 'pending'
          and d.next_attempt_at <= now()
          and (d.claimed_until is null or d.claimed_until < now())
        order by d.next_attempt_at, d.created_at
        limit greatest(p_limit, 0)
        for update skip locked
    )
    returning o.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- settle_billing_mail: what became of a claimed row
-- ---------------------------------------------------------------------------
--   sent   -- a confirmation is kept (status sent) as the record that it went
--             out and the key that stops a second one; a cancel-link request
--             is deleted, address and all.
--   retry  -- the lease goes, the row is due again after p_retry_after.
--   done   -- handled with nothing to send (an address with no subscription, a
--             recipient already sent a link): deleted.
-- Scoped to the claim token, so a worker whose lease expired and was taken
-- over cannot settle the row out from under the worker that holds it now.
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
    else
        raise exception 'unknown outcome %', p_outcome using errcode = '22023';
    end if;
    return true;
end;
$$;

revoke all on function public.enqueue_billing_mail (text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_billing_mail (integer, interval) from public, anon, authenticated;
revoke all on function public.settle_billing_mail (uuid, uuid, text, text, interval) from public, anon, authenticated;
grant execute on function public.enqueue_billing_mail (text, text, text, jsonb) to service_role;
grant execute on function public.claim_billing_mail (integer, interval) to service_role;
grant execute on function public.settle_billing_mail (uuid, uuid, text, text, interval) to service_role;

-- ---------------------------------------------------------------------------
-- The cron tick: housekeeping, then poke the worker if anything is due
-- ---------------------------------------------------------------------------
-- The worker is also poked straight after every enqueue (EdgeRuntime.waitUntil
-- in the functions that enqueue), so this is the retry path: backoff, a budget
-- window reopening, Resend coming back. Vault secrets billing_outbox_url /
-- billing_outbox_secret are created out of band (DEPLOY.md); without them the
-- tick only does its housekeeping, as imslp_sync_tick does.
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
    -- for, and the row holds an address.
    delete from public.billing_mail_outbox
    where kind = 'cancel_link' and created_at < now() - interval '1 day';

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

do $$
begin
    perform cron.unschedule (jobid)
    from cron.job
    where jobname = 'billing-mail-outbox';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('billing-mail-outbox', '* * * * *', $$select public.billing_mail_outbox_tick ()$$);

-- ---------------------------------------------------------------------------
-- billing_notices: replaced by the outbox's (kind, dedupe_key)
-- ---------------------------------------------------------------------------
drop table if exists public.billing_notices;
