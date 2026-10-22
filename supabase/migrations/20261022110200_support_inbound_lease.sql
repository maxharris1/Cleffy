-- Inbound support mail: a processing state and a reclaimable lease, so a
-- delivery that dies part-way is resumed rather than lost or doubled.
--
-- resend-inbound used to INSERT ... ON CONFLICT DO NOTHING and treat a lost
-- insert as "duplicate, 200". That made the FIRST delivery the only one that
-- ever did any work: if it died after the insert -- the body fetch failed, the
-- body write failed (and was ignored), the forward errored -- every retry Svix
-- sent hit the duplicate path, and the message sat unforwarded for good. And
-- the forward itself was a direct POST with no budget, outside the shared mail
-- split (_shared/mailBudget.ts) that everything else we send counts against.
--
-- Now each row moves through:
--
--   processing        -- a delivery holds it under a lease (lease_holder,
--                        lease_until); unleased, it is due for a resume at
--                        next_attempt_at;
--   forward_deferred  -- stored, with its body, but the contentReportAck share
--                        of the mail budget is spent; retried when it reopens;
--   completed         -- forwarded, stored-only, or refused for good (the loop
--                        guard, a forward Resend rejected, no body at all, or
--                        out of attempts). A completed row is the only kind a
--                        later delivery treats as a duplicate.
--
-- A delivery CLAIMS the row (claim_support_message): it inserts it, or takes
-- an existing one that is not completed and not leased by anyone else. Only the
-- lease holder can save the body or finish the row. A lease that runs out
-- (the function was killed) makes the row claimable again -- by Svix's next
-- retry or by the retry tick below -- and the forward carries an
-- Idempotency-Key derived from Resend's email id, so a resumed send can never
-- deliver a second copy.
--
-- The retry path is the content-notice pattern (20261020150000): pg_cron runs
-- support_inbound_retry_tick() every five minutes; when anything is due it
-- POSTs to resend-inbound with the shared secret from the vault
-- (support_inbound_url, support_inbound_secret = the function's
-- SUPPORT_RETRY_SECRET). Without those secrets the tick is a no-op and rows
-- resume only on Svix's own retries.
--
-- Rows from before this migration are completed: they were handled (or not)
-- under the old rules, and resuming them is a decision for a person.
alter table public.support_messages
    add column if not exists status text not null default 'completed',
    add column if not exists lease_holder uuid,
    add column if not exists lease_until timestamptz,
    add column if not exists attempts integer not null default 0,
    add column if not exists next_attempt_at timestamptz,
    add column if not exists completed_at timestamptz,
    -- Resend's id for the forward we sent, once it was accepted.
    add column if not exists forward_resend_id text;

alter table public.support_messages alter column status set default 'processing';

do $$
begin
    alter table public.support_messages add constraint support_messages_status
        check (status in ('processing', 'forward_deferred', 'completed'));
exception
    when duplicate_object then null;
end;
$$;

-- What the retry tick looks for, without scanning the table.
create index if not exists support_messages_due on public.support_messages (next_attempt_at)
where status <> 'completed';

-- How many failed attempts a row gets before it is completed with its error.
-- Budget deferrals are not attempts.
create or replace function public.support_message_max_attempts () returns integer
language sql immutable as $$ select 12 $$;

revoke all on function public.support_message_max_attempts () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- claim_support_message: the webhook's first write
-- ---------------------------------------------------------------------------
-- {status: 'claimed', id, holder, inserted, attempts, from_address, to_addresses,
-- received_for, subject, text_body, html_body}, {status: 'duplicate'} for a
-- completed row, or {status: 'busy', retry_after_seconds} while another
-- delivery holds the lease.
create or replace function public.claim_support_message (
    p_email_id text,
    p_message_id text,
    p_from text,
    p_to text[],
    p_received_for text[],
    p_subject text,
    p_attachments jsonb,
    p_received_at timestamptz,
    p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row public.support_messages;
    v_holder uuid := gen_random_uuid();
    v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30));
    v_inserted boolean := false;
begin
    if p_email_id is null or length(p_email_id) = 0 then
        raise exception 'p_email_id is required' using errcode = '22004';
    end if;

    insert into public.support_messages (
        resend_email_id, message_id, from_address, to_addresses, received_for, subject, attachments,
        received_at, status, lease_holder, lease_until, attempts
    )
    values (
        p_email_id, p_message_id, coalesce(p_from, 'unknown'), coalesce(p_to, '{}'), coalesce(p_received_for, '{}'),
        p_subject, coalesce(p_attachments, '[]'::jsonb), coalesce(p_received_at, now()),
        'processing', v_holder, now() + v_lease, 1
    )
    on conflict (resend_email_id) do nothing
    returning * into v_row;

    if found then
        v_inserted := true;
    else
        select * into v_row from public.support_messages where resend_email_id = p_email_id for update;
        if v_row.status = 'completed' then
            return jsonb_build_object('status', 'duplicate', 'id', v_row.id);
        end if;
        if v_row.lease_until is not null and v_row.lease_until > now() then
            return jsonb_build_object(
                'status', 'busy',
                'id', v_row.id,
                'retry_after_seconds', greatest(1, ceil(extract(epoch from v_row.lease_until - now()))::integer)
            );
        end if;
        update public.support_messages
        set lease_holder = v_holder, lease_until = now() + v_lease, attempts = attempts + 1
        where id = v_row.id
        returning * into v_row;
    end if;

    return jsonb_build_object(
        'status', 'claimed',
        'id', v_row.id,
        'holder', v_holder,
        'inserted', v_inserted,
        'attempts', v_row.attempts,
        'resend_email_id', v_row.resend_email_id,
        'from_address', v_row.from_address,
        'to_addresses', to_jsonb(v_row.to_addresses),
        'received_for', to_jsonb(v_row.received_for),
        'subject', v_row.subject,
        'text_body', v_row.text_body,
        'html_body', v_row.html_body
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_due_support_messages: the retry path's claim
-- ---------------------------------------------------------------------------
-- Every row that is not completed, not leased, and due, oldest first, each
-- under a fresh lease and counted as an attempt.
create or replace function public.claim_due_support_messages (
    p_limit integer default 10,
    p_lease_seconds integer default 120
) returns setof public.support_messages language plpgsql security definer
set search_path = public as $$
begin
    return query
    update public.support_messages m
    set lease_holder = gen_random_uuid(),
        lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
        attempts = m.attempts + 1
    where m.id in (
        select c.id
        from public.support_messages c
        where c.status <> 'completed'
          and (c.lease_until is null or c.lease_until < now())
          and coalesce(c.next_attempt_at, c.created_at) <= now()
        order by coalesce(c.next_attempt_at, c.created_at), c.created_at
        limit least(greatest(coalesce(p_limit, 10), 1), 50)
        for update skip locked
    )
    returning m.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_support_message_body: the fetched body, written by the lease holder
-- ---------------------------------------------------------------------------
create or replace function public.save_support_message_body (
    p_id uuid,
    p_holder uuid,
    p_text text,
    p_html text
) returns boolean language plpgsql security definer
set search_path = public as $$
begin
    update public.support_messages
    set text_body = p_text, html_body = p_html
    where id = p_id and lease_holder = p_holder and status <> 'completed';
    return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_support_message: how this attempt ended (lease holder only)
-- ---------------------------------------------------------------------------
--   forwarded  -- completed; forwarded_at and the forward's Resend id;
--   stored     -- completed, store-only (no forwarding address configured);
--   refused    -- completed with p_error: the loop guard, a forward Resend
--                 rejected for good, a message with no body at all;
--   deferred   -- forward_deferred: the budget is spent; retried after
--                 p_retry_after_seconds; NOT an attempt;
--   retry      -- still processing: the body fetch failed, or the forward's
--                 outcome is unknown; retried with backoff, and completed
--                 with its error once it is out of attempts.
-- False when p_holder no longer holds the row (its lease ran out and another
-- delivery took it): that delivery's outcome stands, not this one.
create or replace function public.finish_support_message (
    p_id uuid,
    p_holder uuid,
    p_outcome text,
    p_error text default null,
    p_retry_after_seconds integer default null,
    p_forward_id text default null
) returns boolean language plpgsql security definer
set search_path = public as $$
declare
    v_row public.support_messages;
begin
    if p_outcome not in ('forwarded', 'stored', 'refused', 'deferred', 'retry') then
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
    select * into v_row from public.support_messages where id = p_id and lease_holder = p_holder for update;
    if not found then
        return false;
    end if;

    if p_outcome = 'forwarded' then
        update public.support_messages
        set status = 'completed', forwarded_at = now(), forward_error = null, forward_resend_id = p_forward_id,
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
    elsif p_outcome in ('stored', 'refused') then
        update public.support_messages
        set status = 'completed', forward_error = left(p_error, 500), completed_at = now(),
            lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
    elsif p_outcome = 'deferred' then
        update public.support_messages
        set status = 'forward_deferred', forward_error = left(coalesce(p_error, 'forward deferred: the mail budget is spent'), 500),
            attempts = greatest(attempts - 1, 0),
            next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 300), 60)),
            lease_holder = null, lease_until = null
        where id = p_id;
    elsif v_row.attempts >= public.support_message_max_attempts () then
        update public.support_messages
        set status = 'completed',
            forward_error = left('gave up after ' || v_row.attempts || ' attempts: ' || coalesce(p_error, 'unknown'), 500),
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
    else
        update public.support_messages
        set forward_error = left(p_error, 500),
            next_attempt_at = now() + coalesce(
                make_interval(secs => p_retry_after_seconds),
                least(interval '6 hours', interval '1 minute' * power(2, least(greatest(v_row.attempts - 1, 0), 20)))
            ),
            lease_holder = null, lease_until = null
        where id = p_id;
    end if;
    return true;
end;
$$;

revoke all on function public.claim_support_message (text, text, text, text[], text[], text, jsonb, timestamptz, integer)
from public, anon, authenticated;

grant execute on function public.claim_support_message (text, text, text, text[], text[], text, jsonb, timestamptz, integer)
to service_role;

revoke all on function public.claim_due_support_messages (integer, integer) from public, anon, authenticated;

grant execute on function public.claim_due_support_messages (integer, integer) to service_role;

revoke all on function public.save_support_message_body (uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.save_support_message_body (uuid, uuid, text, text) to service_role;

revoke all on function public.finish_support_message (uuid, uuid, text, text, integer, text) from public, anon, authenticated;

grant execute on function public.finish_support_message (uuid, uuid, text, text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- The retry tick (pg_cron + pg_net + vault, the content-notice pattern)
-- ---------------------------------------------------------------------------
create or replace function public.support_inbound_retry_tick () returns void language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    v_url text;
    v_secret text;
begin
    if not exists (
        select 1 from public.support_messages
        where status <> 'completed'
          and (lease_until is null or lease_until < now())
          and coalesce(next_attempt_at, created_at) <= now()
    ) then
        return;
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'support_inbound_url' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'support_inbound_secret' limit 1;
    if v_url is null or v_secret is null or length(trim(v_url)) = 0 then
        raise notice 'support_inbound_retry_tick: vault secrets support_inbound_url/support_inbound_secret missing — skip';
        return;
    end if;
    perform net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-support-retry-secret', v_secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
    );
end;
$$;

revoke all on function public.support_inbound_retry_tick () from public, anon, authenticated;

grant execute on function public.support_inbound_retry_tick () to service_role;

do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'support-inbound-retry';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('support-inbound-retry', '2-59/5 * * * *', $$select public.support_inbound_retry_tick ()$$);
