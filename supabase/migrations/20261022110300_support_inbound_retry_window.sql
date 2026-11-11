-- Inbound support mail: every send attempt pays for itself, and automatic
-- retries stop before Resend forgets the Idempotency-Key.
--
-- 20261022110200_support_inbound_lease.sql kept a forward's budget reservation
-- across retries once a send's outcome was unknown (forward_budget_held), and a
-- held retry reserved nothing. A retry made after the hourly window reset then
-- sent without paying in the window it sent in: eight fresh forwards could use
-- the new hour's allowance and the held retry send a ninth. resend-inbound now
-- reserves on every attempt (the _shared/billingOutbox.ts pattern), keeping the
-- earlier uncertain charge where it was; forward_budget_held stays as a record
-- that a reservation was kept, and nothing reads it to skip the budget.
--
-- And the 16-attempt exponential schedule ran for days, while Resend keeps an
-- Idempotency-Key for 24 hours: a replay after that is a new email, so a
-- forward that did go out on an "unknown" attempt could be delivered twice.
-- Now the row records when its FIRST send was attempted
-- (first_send_attempt_at, set by begin_support_forward right before the send),
-- and no send is made once support_forward_retry_window() (23 hours, an hour
-- inside Resend's retention) has passed since then. Such a row, and one out of
-- attempts, becomes `failed`: terminal, never sent again, and left for a person
-- (the row keeps its body, sender and last error). A later delivery of a failed
-- row is answered as a duplicate.
--
-- Replayable: every statement is idempotent or create-or-replace.
alter table public.support_messages add column if not exists first_send_attempt_at timestamptz;

alter table public.support_messages drop constraint if exists support_messages_status;

alter table public.support_messages add constraint support_messages_status
check (status in ('processing', 'forward_deferred', 'completed', 'failed'));

drop index if exists public.support_messages_due;

create index if not exists support_messages_due on public.support_messages (next_attempt_at)
where status in ('processing', 'forward_deferred');

-- How long after the first send attempt a forward may still be (re)sent:
-- inside Resend's 24-hour Idempotency-Key retention, with an hour to spare.
create or replace function public.support_forward_retry_window () returns interval
language sql immutable as $$ select interval '23 hours' $$;

revoke all on function public.support_forward_retry_window () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- claim_support_message: a failed row is finished, like a completed one
-- ---------------------------------------------------------------------------
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
        if v_row.status in ('completed', 'failed') then
            return jsonb_build_object('status', 'duplicate', 'id', v_row.id, 'failed', v_row.status = 'failed');
        end if;
        if v_row.lease_until is not null and v_row.lease_until > now() then
            return jsonb_build_object(
                'status', 'busy',
                'id', v_row.id,
                'retry_after_seconds', greatest(1, ceil(extract(epoch from v_row.lease_until - now()))::integer)
            );
        end if;
        if v_row.next_attempt_at is not null and v_row.next_attempt_at > now() then
            return jsonb_build_object(
                'status', 'busy',
                'id', v_row.id,
                'retry_after_seconds', greatest(1, ceil(extract(epoch from v_row.next_attempt_at - now()))::integer)
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
        'html_body', v_row.html_body,
        'first_send_attempt_at', v_row.first_send_attempt_at
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_due_support_messages: only rows still in flight
-- ---------------------------------------------------------------------------
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
        where c.status in ('processing', 'forward_deferred')
          and (c.lease_until is null or c.lease_until < now())
          and coalesce(c.next_attempt_at, c.created_at) <= now()
        order by coalesce(c.next_attempt_at, c.created_at), c.created_at
        limit least(greatest(coalesce(p_limit, 10), 1), 50)
        for update skip locked
    )
    returning m.*;
end;
$$;

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
    where id = p_id and lease_holder = p_holder and status in ('processing', 'forward_deferred');
    return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- begin_support_forward: the last check before a send (lease holder only)
-- ---------------------------------------------------------------------------
--   'send'    -- go ahead; the first attempt records first_send_attempt_at;
--   'expired' -- the retry window since the first send attempt has closed:
--                the row is now failed and the lease released; send nothing;
--   'lost'    -- p_holder no longer holds the row (or it is finished).
create or replace function public.begin_support_forward (p_id uuid, p_holder uuid) returns text
language plpgsql security definer
set search_path = public as $$
declare
    v_row public.support_messages;
begin
    select * into v_row from public.support_messages
    where id = p_id and lease_holder = p_holder and status in ('processing', 'forward_deferred')
    for update;
    if not found then
        return 'lost';
    end if;
    if v_row.first_send_attempt_at is null then
        update public.support_messages set first_send_attempt_at = now() where id = p_id;
        return 'send';
    end if;
    if now() >= v_row.first_send_attempt_at + public.support_forward_retry_window () then
        update public.support_messages
        set status = 'failed',
            forward_error = left(
                'retry window closed: no send since ' || (v_row.first_send_attempt_at at time zone 'UTC')::text
                    || ' UTC could be retried safely; last error: ' || coalesce(v_row.forward_error, 'none'),
                500
            ),
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
        return 'expired';
    end if;
    return 'send';
end;
$$;

-- ---------------------------------------------------------------------------
-- finish_support_message: a retry that would land past the window, or one out
-- of attempts, fails for review instead of being scheduled
-- ---------------------------------------------------------------------------
create or replace function public.finish_support_message (
    p_id uuid,
    p_holder uuid,
    p_outcome text,
    p_error text default null,
    p_retry_after_seconds integer default null,
    p_forward_id text default null,
    p_budget_held boolean default null
) returns boolean language plpgsql security definer
set search_path = public as $$
declare
    v_row public.support_messages;
    v_next timestamptz;
begin
    if p_outcome not in ('forwarded', 'stored', 'refused', 'deferred', 'retry') then
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
    select * into v_row from public.support_messages
    where id = p_id and lease_holder = p_holder and status in ('processing', 'forward_deferred')
    for update;
    if not found then
        return false;
    end if;

    if p_outcome = 'forwarded' then
        update public.support_messages
        set status = 'completed', forwarded_at = now(), forward_error = null, forward_resend_id = p_forward_id,
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null,
            forward_budget_held = false
        where id = p_id;
        return true;
    elsif p_outcome in ('stored', 'refused') then
        update public.support_messages
        set status = 'completed', forward_error = left(p_error, 500), completed_at = now(),
            lease_holder = null, lease_until = null, next_attempt_at = null, forward_budget_held = false
        where id = p_id;
        return true;
    end if;

    if p_outcome = 'deferred' then
        v_next := now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 300), 60));
    else
        v_next := now() + coalesce(
            make_interval(secs => p_retry_after_seconds),
            least(interval '6 hours', interval '1 minute' * power(2, least(greatest(v_row.attempts - 1, 0), 20)))
        );
    end if;

    if v_row.first_send_attempt_at is not null
        and v_next >= v_row.first_send_attempt_at + public.support_forward_retry_window () then
        update public.support_messages
        set status = 'failed',
            forward_error = left(
                'retry window closed before the next attempt; last error: ' || coalesce(p_error, 'unknown'), 500
            ),
            forward_budget_held = forward_budget_held or coalesce(p_budget_held, false),
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
    elsif p_outcome = 'deferred' then
        update public.support_messages
        set status = 'forward_deferred',
            forward_error = left(coalesce(p_error, 'forward deferred: the mail budget is spent'), 500),
            attempts = greatest(attempts - 1, 0),
            next_attempt_at = v_next,
            lease_holder = null, lease_until = null
        where id = p_id;
    elsif v_row.attempts >= public.support_message_max_attempts () then
        update public.support_messages
        set status = 'failed',
            forward_error = left('gave up after ' || v_row.attempts || ' attempts: ' || coalesce(p_error, 'unknown'), 500),
            forward_budget_held = forward_budget_held or coalesce(p_budget_held, false),
            completed_at = now(), lease_holder = null, lease_until = null, next_attempt_at = null
        where id = p_id;
    else
        update public.support_messages
        set forward_error = left(p_error, 500),
            forward_budget_held = forward_budget_held or coalesce(p_budget_held, false),
            next_attempt_at = v_next,
            lease_holder = null, lease_until = null
        where id = p_id;
    end if;
    return true;
end;
$$;

revoke all on function public.begin_support_forward (uuid, uuid) from public, anon, authenticated;

grant execute on function public.begin_support_forward (uuid, uuid) to service_role;

-- create or replace keeps existing grants; restated so this file stands alone.
revoke all on function public.claim_support_message (text, text, text, text[], text[], text, jsonb, timestamptz, integer)
from public, anon, authenticated;

grant execute on function public.claim_support_message (text, text, text, text[], text[], text, jsonb, timestamptz, integer)
to service_role;

revoke all on function public.claim_due_support_messages (integer, integer) from public, anon, authenticated;

grant execute on function public.claim_due_support_messages (integer, integer) to service_role;

revoke all on function public.save_support_message_body (uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.save_support_message_body (uuid, uuid, text, text) to service_role;

revoke all on function public.finish_support_message (uuid, uuid, text, text, integer, text, boolean)
from public, anon, authenticated;

grant execute on function public.finish_support_message (uuid, uuid, text, text, integer, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- The retry tick: only rows still in flight are due
-- ---------------------------------------------------------------------------
create or replace function public.support_inbound_retry_tick () returns void language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    v_url text;
    v_secret text;
begin
    if not exists (
        select 1 from public.support_messages
        where status in ('processing', 'forward_deferred')
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
