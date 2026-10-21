-- Notice and action: reports about scores, takedowns, strikes and a notice log.
--
-- The Copyright and Content Policy (/copyright) promises: anyone, signed in or
-- not, can report a score (the content-report Edge Function writes it here and
-- emails an acknowledgment); a moderator reviews it and may restrict or remove
-- the score, which emails the uploader a statement of reasons and the reporter
-- the outcome (content-moderation); a copyright takedown is a strike against
-- the uploader; and every report, decision and notice is logged.
--
-- Every write goes through the service role, from those two functions. The
-- browser can only ask whether it is a moderator (is_content_moderator) and,
-- if it is, read the reports, takedowns and log a page at a time
-- (moderation_reports, moderation_takedowns, moderation_log). Moderators are granted by hand:
--
--     insert into public.content_moderators (user_id, note) values ('<uuid>', 'Max');
--
-- Two takedown actions, both reversible, neither deleting anything — a
-- counter-notice or complaint that succeeds must be able to put the score
-- back, and content reported as illegal may have to be preserved:
--
--   restrict  the score can no longer be shared: everyone but its owner loses
--             access (members and share links alike), and nobody new can join.
--   remove    nobody can open it, its owner included. The row, file and
--             markings stay, out of reach of every client.
--
-- Both are enforced in document_role(), which already gates every read and
-- write a client can make on a score — the documents and annotation policies,
-- the scores and thumbnails storage policies, joining either realtime topic —
-- in library_documents(), which lists memberships directly, and in
-- documents_select, whose owner clause would otherwise still hand an owner the
-- row of a removed score.
--
-- Realtime authorizes a channel when it is joined, not per message, so a
-- takedown also reaches viewers who already have the score open: the server
-- stops broadcasting the score's committed changes (doc-db:{id}) while it is
-- taken down, and tells each viewer who lost access to re-check it (see
-- "Realtime" below).

-- ---------------------------------------------------------------------------
-- Moderators
-- ---------------------------------------------------------------------------

create table if not exists public.content_moderators (
    user_id uuid primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now(),
    note text check (note is null or char_length(note) <= 200)
);

alter table public.content_moderators enable row level security;
revoke all on table public.content_moderators from anon, authenticated;

create or replace function public.is_content_moderator () returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.content_moderators m where m.user_id = (select auth.uid())
    );
$$;

revoke all on function public.is_content_moderator () from public;
revoke all on function public.is_content_moderator () from anon;
grant execute on function public.is_content_moderator () to authenticated;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table if not exists public.content_reports (
    id uuid primary key default gen_random_uuid(),
    -- What the acknowledgment email and the reporter quote back to us.
    reference text not null unique default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
    created_at timestamptz not null default now(),
    kind text not null check (kind in ('copyright', 'illegal')),
    category text not null check (
        category in (
            'copyright',
            'child_safety',
            'terrorism',
            'hate',
            'violence',
            'privacy',
            'fraud',
            'other'
        )
    ),
    content_url text not null check (char_length(content_url) between 1 and 2000),
    -- Resolved from content_url when it names a score or a live share link;
    -- null when it does not (the moderator then finds the score by hand).
    document_id uuid references public.documents (id) on delete set null,
    work_description text check (work_description is null or char_length(work_description) <= 4000),
    explanation text not null check (char_length(explanation) between 1 and 8000),
    reporter_name text not null check (char_length(reporter_name) between 1 and 200),
    reporter_email text not null check (char_length(reporter_email) between 3 and 254),
    reporter_address text check (reporter_address is null or char_length(reporter_address) <= 500),
    reporter_phone text check (reporter_phone is null or char_length(reporter_phone) <= 50),
    on_behalf_of text check (on_behalf_of is null or char_length(on_behalf_of) <= 200),
    -- Set when the reporter was signed in; never trusted from the request body.
    reporter_user_id uuid references auth.users (id) on delete set null,
    good_faith boolean not null check (good_faith),
    -- The DMCA statement "under penalty of perjury" — required for copyright.
    perjury_statement boolean not null default false,
    signature text not null check (char_length(signature) between 1 and 200),
    status text not null default 'received' check (status in ('received', 'actioned', 'rejected')),
    decided_at timestamptz,
    decided_by uuid references auth.users (id) on delete set null,
    decision_note text check (decision_note is null or char_length(decision_note) <= 4000),
    acknowledged_at timestamptz,
    check (kind <> 'copyright' or (category = 'copyright' and perjury_statement and work_description is not null)),
    check (kind <> 'illegal' or category <> 'copyright')
);

create index if not exists content_reports_created_idx on public.content_reports (created_at desc);
create index if not exists content_reports_document_idx on public.content_reports (document_id)
where document_id is not null;

alter table public.content_reports enable row level security;
revoke all on table public.content_reports from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Takedowns
-- ---------------------------------------------------------------------------

create table if not exists public.content_takedowns (
    id uuid primary key default gen_random_uuid(),
    -- Set null rather than cascaded: if the uploader deletes the score or their
    -- account, the record of what was taken down, and the strike, stay.
    document_id uuid references public.documents (id) on delete set null,
    report_id uuid references public.content_reports (id) on delete set null,
    uploader_id uuid references auth.users (id) on delete set null,
    document_title text,
    action text not null check (action in ('restrict', 'remove')),
    ground text not null check (ground in ('copyright', 'illegal', 'terms')),
    -- The statement of reasons: the law or term relied on, and the facts.
    legal_basis text not null check (char_length(legal_basis) between 1 and 1000),
    facts text not null check (char_length(facts) between 1 and 4000),
    created_at timestamptz not null default now(),
    created_by uuid references auth.users (id) on delete set null,
    lifted_at timestamptz,
    lifted_by uuid references auth.users (id) on delete set null,
    lift_reason text check (lift_reason is null or char_length(lift_reason) <= 4000)
);

-- One live takedown per score, and the lookup document_role() makes.
create unique index if not exists content_takedowns_active_document on public.content_takedowns (document_id)
where lifted_at is null;
create index if not exists content_takedowns_uploader_idx on public.content_takedowns (uploader_id);

alter table public.content_takedowns enable row level security;
revoke all on table public.content_takedowns from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Strikes (repeat-infringer policy)
-- ---------------------------------------------------------------------------

create table if not exists public.content_strikes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    takedown_id uuid not null unique references public.content_takedowns (id) on delete cascade,
    created_at timestamptz not null default now(),
    voided_at timestamptz,
    void_reason text
);

create index if not exists content_strikes_user_idx on public.content_strikes (user_id, created_at desc);

alter table public.content_strikes enable row level security;
revoke all on table public.content_strikes from anon, authenticated;

-- Strikes that count: not withdrawn, and within the window the policy states
-- (STRIKE_WINDOW_MONTHS in src/features/moderation/moderationRules.ts).
create or replace function public.active_content_strikes (p_user uuid) returns integer language sql stable security definer
set search_path = public as $$
    select count(*)::int
    from public.content_strikes s
    where s.user_id = p_user
      and s.voided_at is null
      and s.created_at > now() - interval '12 months';
$$;

revoke all on function public.active_content_strikes (uuid) from public;
revoke all on function public.active_content_strikes (uuid) from anon;
revoke all on function public.active_content_strikes (uuid) from authenticated;
grant execute on function public.active_content_strikes (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Notice log
-- ---------------------------------------------------------------------------

create table if not exists public.content_notice_log (
    id bigint generated by default as identity primary key,
    created_at timestamptz not null default now(),
    report_id uuid references public.content_reports (id) on delete set null,
    takedown_id uuid references public.content_takedowns (id) on delete set null,
    event text not null check (
        event in (
            'report_received',
            'report_acknowledged',
            'report_rejected',
            'reporter_notified',
            'takedown',
            'statement_of_reasons',
            'takedown_lifted',
            'uploader_notified_lift'
        )
    ),
    -- The address mailed, for an email event.
    recipient text,
    -- queued: put in content_notice_outbox; each attempt then logs how it went.
    -- skipped: there was no address to send to.
    delivery text check (delivery is null or delivery in ('queued', 'sent', 'failed', 'unconfigured', 'skipped')),
    actor_id uuid references auth.users (id) on delete set null,
    detail jsonb not null default '{}'::jsonb
);

create index if not exists content_notice_log_created_idx on public.content_notice_log (created_at desc);

alter table public.content_notice_log enable row level security;
revoke all on table public.content_notice_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Outbox: every notice we owe, kept until it is sent
-- ---------------------------------------------------------------------------
-- The acknowledgment (blind-copied to the legal mailbox), the statement of
-- reasons, the reporter's outcome and the lift notice are promises the
-- policy makes, and a mail budget or a Resend outage must delay them, never
-- lose them. So each is written here IN THE SAME TRANSACTION as the report or
-- decision it is about (the trigger and the three actions below), and the
-- content-report, content-moderation and content-notices functions deliver
-- them: claim due rows (a lease, so two deliverers never send one twice),
-- take a unit of the sender's mail budget, send with the row id as Resend's
-- idempotency key, and finish the row. Out of budget: back in the queue until
-- the budget's window reopens, not counted as an attempt. A failed or
-- unconfigured send: retried with backoff (1 minute doubling, at most 6
-- hours), indefinitely; the moderation page shows how many are waiting. A
-- crash mid-send: the lease runs out and the row is claimed again, and the
-- idempotency key stops Resend sending it twice.
--
-- What it sends is rendered at delivery from `payload` by contentReports.ts
-- (renderNotice), from the facts recorded here: the decision's wording, not
-- whatever the rows say later. The recipient is resolved now: the reporter's
-- address, or the uploader's sign-in address from auth.users.

create table if not exists public.content_notice_outbox (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    -- Whose mail budget it spends (MAIL_CATEGORY_CAPS in _shared/mailBudget.ts).
    sender text not null check (sender in ('content-report-ack', 'moderation-notice')),
    template text not null check (
        template in ('report_acknowledgment', 'statement_of_reasons', 'reporter_outcome', 'takedown_lifted')
    ),
    -- The content_notice_log event each attempt is logged as.
    event text not null check (
        event in ('report_acknowledged', 'statement_of_reasons', 'reporter_notified', 'uploader_notified_lift')
    ),
    report_id uuid references public.content_reports (id) on delete set null,
    takedown_id uuid references public.content_takedowns (id) on delete set null,
    actor_id uuid references auth.users (id) on delete set null,
    recipient text not null check (char_length(recipient) between 3 and 320),
    -- Blind-copy the legal mailbox (the acknowledgment: how a person hears of a report).
    bcc_legal boolean not null default false,
    payload jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'sent')),
    attempts int not null default 0,
    next_attempt_at timestamptz not null default now(),
    claimed_until timestamptz,
    last_outcome text check (last_outcome is null or last_outcome in ('failed', 'unconfigured', 'deferred')),
    sent_at timestamptz
);

create index if not exists content_notice_outbox_due_idx on public.content_notice_outbox (next_attempt_at)
where status = 'pending';

alter table public.content_notice_outbox enable row level security;
revoke all on table public.content_notice_outbox from anon, authenticated;

-- Queue one notice and log it as queued. A recipient-less notice (an uploader
-- with no sign-in address: a guest, a roster student) is logged as skipped,
-- so the moderator sees it needs following up by hand. Internal.
create or replace function public.enqueue_content_notice (
    p_sender text,
    p_template text,
    p_event text,
    p_recipient text,
    p_bcc_legal boolean,
    p_payload jsonb,
    p_report uuid,
    p_takedown uuid,
    p_actor uuid
) returns uuid language plpgsql security definer
set search_path = public as $$
declare
    v_id uuid;
begin
    if nullif(btrim(coalesce(p_recipient, '')), '') is null then
        insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id)
        values (p_report, p_takedown, p_event, null, 'skipped', p_actor);
        return null;
    end if;
    insert into public.content_notice_outbox (
        sender, template, event, report_id, takedown_id, actor_id, recipient, bcc_legal, payload
    ) values (
        p_sender, p_template, p_event, p_report, p_takedown, p_actor, p_recipient, p_bcc_legal, p_payload
    ) returning id into v_id;
    insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id, detail)
    values (p_report, p_takedown, p_event, p_recipient, 'queued', p_actor, jsonb_build_object('notice_id', v_id));
    return v_id;
end;
$$;

revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from public;
revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from anon;
revoke all on function public.enqueue_content_notice (text, text, text, text, boolean, jsonb, uuid, uuid, uuid) from authenticated;

-- The decision time as the emails print it (UTC, ISO 8601).
create or replace function public.content_notice_time (p_at timestamptz) returns text language sql immutable
set search_path = public as $$
    select to_char(p_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- The report is logged and its acknowledgment queued by the insert itself, so
-- a stored report always has one owed, whatever happens to the request after.
create or replace function public.content_report_enqueue_ack () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    insert into public.content_notice_log (report_id, event, actor_id, detail)
    values (new.id, 'report_received', new.reporter_user_id,
            jsonb_build_object('kind', new.kind, 'category', new.category, 'resolved', new.document_id is not null));
    perform public.enqueue_content_notice (
        'content-report-ack',
        'report_acknowledgment',
        'report_acknowledged',
        new.reporter_email,
        true,
        jsonb_build_object(
            'reference', new.reference,
            'reporterName', new.reporter_name,
            'category', new.category,
            'contentUrl', new.content_url,
            'workDescription', new.work_description,
            'onBehalfOf', new.on_behalf_of,
            'explanation', new.explanation
        ),
        new.id,
        null,
        new.reporter_user_id
    );
    return null;
end;
$$;

revoke all on function public.content_report_enqueue_ack () from public;
revoke all on function public.content_report_enqueue_ack () from anon;
revoke all on function public.content_report_enqueue_ack () from authenticated;

drop trigger if exists content_reports_enqueue_ack on public.content_reports;
create trigger content_reports_enqueue_ack
after insert on public.content_reports
for each row execute function public.content_report_enqueue_ack ();

-- Delivery (service role only). Claim: the due rows, the caller's own first
-- (`p_first`, the notices its request just queued), each leased for
-- p_lease_seconds and counted as an attempt.
create or replace function public.claim_content_notices (
    p_limit integer default 10,
    p_first uuid[] default '{}',
    p_lease_seconds integer default 120
) returns setof public.content_notice_outbox language plpgsql security definer
set search_path = public as $$
begin
    return query
    update public.content_notice_outbox o
    set claimed_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)),
        attempts = o.attempts + 1
    where o.id in (
        select c.id
        from public.content_notice_outbox c
        where c.status = 'pending'
          and (c.next_attempt_at <= now() or c.id = any (coalesce(p_first, '{}')))
          and (c.claimed_until is null or c.claimed_until < now())
        order by (c.id = any (coalesce(p_first, '{}'))) desc, c.next_attempt_at, c.created_at
        limit least(greatest(coalesce(p_limit, 10), 1), 50)
        for update skip locked
    )
    returning o.*;
end;
$$;

-- Finish a claimed row: sent; failed or unconfigured (retry with backoff,
-- logged); or deferred because the sender's budget is spent (retry when
-- p_retry_after_seconds says the window reopens; not an attempt, not logged:
-- the row's queued entry already says it is owed).
create or replace function public.finish_content_notice (
    p_id uuid,
    p_outcome text,
    p_retry_after_seconds integer default null
) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_row public.content_notice_outbox;
begin
    if p_outcome not in ('sent', 'failed', 'unconfigured', 'deferred') then
        raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
    end if;
    select * into v_row from public.content_notice_outbox where id = p_id and status = 'pending' for update;
    if not found then
        return;
    end if;

    if p_outcome = 'sent' then
        update public.content_notice_outbox
        set status = 'sent', sent_at = now(), claimed_until = null, last_outcome = null
        where id = p_id;
        if v_row.template = 'report_acknowledgment' and v_row.report_id is not null then
            update public.content_reports set acknowledged_at = coalesce(acknowledged_at, now())
            where id = v_row.report_id;
        end if;
    elsif p_outcome = 'deferred' then
        update public.content_notice_outbox
        set claimed_until = null,
            attempts = greatest(attempts - 1, 0),
            last_outcome = 'deferred',
            next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 1))
        where id = p_id;
        return;
    else
        update public.content_notice_outbox
        set claimed_until = null,
            last_outcome = p_outcome,
            next_attempt_at = now() + coalesce(
                make_interval(secs => p_retry_after_seconds),
                least(interval '6 hours', interval '1 minute' * power(2, least(greatest(attempts - 1, 0), 20)))
            )
        where id = p_id;
    end if;

    insert into public.content_notice_log (report_id, takedown_id, event, recipient, delivery, actor_id, detail)
    values (v_row.report_id, v_row.takedown_id, v_row.event, v_row.recipient, p_outcome, v_row.actor_id,
            jsonb_build_object('notice_id', p_id, 'attempt', v_row.attempts));
end;
$$;

revoke all on function public.claim_content_notices (integer, uuid[], integer) from public;
revoke all on function public.claim_content_notices (integer, uuid[], integer) from anon;
revoke all on function public.claim_content_notices (integer, uuid[], integer) from authenticated;
grant execute on function public.claim_content_notices (integer, uuid[], integer) to service_role;

revoke all on function public.finish_content_notice (uuid, text, integer) from public;
revoke all on function public.finish_content_notice (uuid, text, integer) from anon;
revoke all on function public.finish_content_notice (uuid, text, integer) from authenticated;
grant execute on function public.finish_content_notice (uuid, text, integer) to service_role;

-- The retry when nobody is using either function: every five minutes, if
-- anything is due, pg_cron pokes content-notices (pg_net + vault, the
-- omr_sweep pattern). Vault secrets content_notice_url (the function's URL)
-- and content_notice_secret (= the function's CONTENT_NOTICE_SECRET) are
-- created out of band (DEPLOY.md); without them the tick is a no-op, and
-- notices still go out with the next report or moderator action.
create or replace function public.content_notice_retry_tick () returns void language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    v_url text;
    v_secret text;
begin
    if not exists (
        select 1 from public.content_notice_outbox
        where status = 'pending' and next_attempt_at <= now()
          and (claimed_until is null or claimed_until < now())
    ) then
        return;
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'content_notice_url' limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'content_notice_secret' limit 1;
    if v_url is null or v_secret is null or length(trim(v_url)) = 0 then
        raise notice 'content_notice_retry_tick: vault secrets content_notice_url/content_notice_secret missing — skip';
        return;
    end if;
    perform net.http_post(
        url := v_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-content-notice-secret', v_secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
    );
end;
$$;

revoke all on function public.content_notice_retry_tick () from public, anon, authenticated;
grant execute on function public.content_notice_retry_tick () to service_role;

do $$
begin
    perform cron.unschedule (jobid) from cron.job where jobname = 'content-notice-retry';
exception
    when undefined_table then null;
    when others then null;
end;
$$;

select cron.schedule ('content-notice-retry', '*/5 * * * *', $$select public.content_notice_retry_tick ()$$);

-- ---------------------------------------------------------------------------
-- Actions (service role only: content-moderation calls them after checking
-- the caller is a moderator, then sends the emails and logs them)
-- ---------------------------------------------------------------------------

create or replace function public.apply_content_takedown (
    p_document uuid,
    p_action text,
    p_ground text,
    p_legal_basis text,
    p_facts text,
    p_report uuid,
    p_moderator uuid
) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_doc record;
    v_takedown uuid;
    v_strikes int := null;
    v_report record;
    v_uploader_notice uuid;
    v_reporter_notice uuid;
begin
    select d.id, d.owner_id, d.title into v_doc from public.documents d where d.id = p_document for update;
    if not found then
        raise exception 'score not found' using errcode = 'P0002', detail = '{"code":"document_not_found"}';
    end if;
    if exists (select 1 from public.content_takedowns t where t.document_id = p_document and t.lifted_at is null) then
        raise exception 'score already taken down' using errcode = '23505', detail = '{"code":"already_taken_down"}';
    end if;
    if p_report is not null and not exists (select 1 from public.content_reports r where r.id = p_report) then
        raise exception 'report not found' using errcode = 'P0002', detail = '{"code":"report_not_found"}';
    end if;

    insert into public.content_takedowns (
        document_id, report_id, uploader_id, document_title, action, ground, legal_basis, facts, created_by
    ) values (
        p_document, p_report, v_doc.owner_id, v_doc.title, p_action, p_ground, p_legal_basis, p_facts, p_moderator
    ) returning id into v_takedown;

    -- Repeat-infringer policy: copyright takedowns count against the uploader.
    if p_ground = 'copyright' and v_doc.owner_id is not null then
        insert into public.content_strikes (user_id, takedown_id) values (v_doc.owner_id, v_takedown);
    end if;
    if v_doc.owner_id is not null then
        v_strikes := public.active_content_strikes (v_doc.owner_id);
    end if;

    if p_report is not null then
        update public.content_reports
        set status = 'actioned', decided_at = now(), decided_by = p_moderator,
            document_id = coalesce(document_id, p_document)
        where id = p_report;
    end if;

    insert into public.content_notice_log (report_id, takedown_id, event, actor_id, detail)
    values (p_report, v_takedown, 'takedown', p_moderator,
            jsonb_build_object('document_id', p_document, 'action', p_action, 'ground', p_ground));

    -- Viewers who already have the score open: re-check, and lose it.
    perform public.content_takedown_notify_viewers (p_document, p_action);

    -- The statement of reasons to the uploader, and the outcome to the
    -- reporter, owed from this commit on (see "Outbox").
    v_uploader_notice := public.enqueue_content_notice (
        'moderation-notice', 'statement_of_reasons', 'statement_of_reasons',
        (select u.email from auth.users u where u.id = v_doc.owner_id),
        false,
        jsonb_build_object(
            'documentTitle', v_doc.title,
            'action', p_action,
            'ground', p_ground,
            'legalBasis', p_legal_basis,
            'facts', p_facts,
            'fromReport', p_report is not null,
            'activeStrikes', v_strikes,
            'decidedAt', public.content_notice_time (now())
        ),
        p_report, v_takedown, p_moderator
    );
    if p_report is not null then
        select r.reference, r.reporter_name, r.reporter_email into v_report
        from public.content_reports r where r.id = p_report;
        v_reporter_notice := public.enqueue_content_notice (
            'moderation-notice', 'reporter_outcome', 'reporter_notified',
            v_report.reporter_email,
            false,
            jsonb_build_object(
                'reference', v_report.reference,
                'reporterName', v_report.reporter_name,
                'decision', 'actioned',
                'action', p_action
            ),
            p_report, v_takedown, p_moderator
        );
    end if;

    return jsonb_build_object(
        'takedown_id', v_takedown,
        'uploader_id', v_doc.owner_id,
        'document_title', v_doc.title,
        'active_strikes', v_strikes,
        'uploader_notice_id', v_uploader_notice,
        'reporter_notice_id', v_reporter_notice
    );
end;
$$;

create or replace function public.lift_content_takedown (p_takedown uuid, p_reason text, p_moderator uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row record;
    v_uploader_notice uuid;
begin
    update public.content_takedowns
    set lifted_at = now(), lifted_by = p_moderator, lift_reason = p_reason
    where id = p_takedown and lifted_at is null
    returning id, document_id, uploader_id, document_title, report_id into v_row;
    if not found then
        raise exception 'no live takedown' using errcode = 'P0002', detail = '{"code":"takedown_not_found"}';
    end if;

    -- The policy: a strike is withdrawn when a counter-notice or complaint succeeds.
    update public.content_strikes
    set voided_at = now(), void_reason = p_reason
    where takedown_id = p_takedown and voided_at is null;

    insert into public.content_notice_log (report_id, takedown_id, event, actor_id, detail)
    values (v_row.report_id, p_takedown, 'takedown_lifted', p_moderator, jsonb_build_object('reason', p_reason));

    v_uploader_notice := public.enqueue_content_notice (
        'moderation-notice', 'takedown_lifted', 'uploader_notified_lift',
        (select u.email from auth.users u where u.id = v_row.uploader_id),
        false,
        jsonb_build_object('documentTitle', v_row.document_title, 'reason', p_reason),
        null, p_takedown, p_moderator
    );

    return jsonb_build_object(
        'takedown_id', v_row.id,
        'document_id', v_row.document_id,
        'uploader_id', v_row.uploader_id,
        'document_title', v_row.document_title,
        'report_id', v_row.report_id,
        'uploader_notice_id', v_uploader_notice
    );
end;
$$;

create or replace function public.reject_content_report (p_report uuid, p_note text, p_moderator uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row record;
begin
    update public.content_reports
    set status = 'rejected', decided_at = now(), decided_by = p_moderator, decision_note = p_note
    where id = p_report and status = 'received'
    returning id, reference, reporter_email, reporter_name, content_url into v_row;
    if not found then
        raise exception 'no open report' using errcode = 'P0002', detail = '{"code":"report_not_open"}';
    end if;

    insert into public.content_notice_log (report_id, event, actor_id, detail)
    values (p_report, 'report_rejected', p_moderator, jsonb_build_object('note', p_note));

    return to_jsonb(v_row) || jsonb_build_object(
        'reporter_notice_id',
        public.enqueue_content_notice (
            'moderation-notice', 'reporter_outcome', 'reporter_notified',
            v_row.reporter_email,
            false,
            jsonb_build_object(
                'reference', v_row.reference,
                'reporterName', v_row.reporter_name,
                'decision', 'rejected',
                'note', p_note
            ),
            p_report, null, p_moderator
        )
    );
end;
$$;

revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from public;
revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from anon;
revoke all on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) from authenticated;
grant execute on function public.apply_content_takedown (uuid, text, text, text, text, uuid, uuid) to service_role;

revoke all on function public.lift_content_takedown (uuid, text, uuid) from public;
revoke all on function public.lift_content_takedown (uuid, text, uuid) from anon;
revoke all on function public.lift_content_takedown (uuid, text, uuid) from authenticated;
grant execute on function public.lift_content_takedown (uuid, text, uuid) to service_role;

revoke all on function public.reject_content_report (uuid, text, uuid) from public;
revoke all on function public.reject_content_report (uuid, text, uuid) from anon;
revoke all on function public.reject_content_report (uuid, text, uuid) from authenticated;
grant execute on function public.reject_content_report (uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The moderator's read: reports, takedowns (with each uploader's strike
-- count) and the notice log, each a page at a time. Refuses everyone else.
-- ---------------------------------------------------------------------------
-- Keyset pagination, never a fixed cap: a list that stopped at its newest 200
-- rows would let an older open report, or an older live takedown and its lift
-- control, drop out of reach as newer ones arrive. Each call answers
-- {rows, total, next}: `next` is the cursor for the following page (null on
-- the last) and `total` counts the whole filtered set, so the page can say how
-- many are waiting. The filters are the ones a moderator works from: open
-- reports (oldest first, the queue order) or decided ones, live takedowns or
-- lifted ones.

-- An earlier draft of this migration had one capped moderation_queue(); no
-- client calls it any more.
drop function if exists public.moderation_queue ();

create index if not exists content_reports_status_created_idx on public.content_reports (status, created_at, id);
create index if not exists content_takedowns_created_idx on public.content_takedowns (created_at desc, id desc);

create or replace function public.moderation_reports (
    p_status text default 'open',
    p_after_created_at timestamptz default null,
    p_after_id uuid default null,
    p_limit integer default 25
) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
    v_open boolean;
    v_rows jsonb;
    v_count int;
    v_total int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;
    if p_status not in ('open', 'decided', 'all') then
        raise exception 'unknown report filter: %', p_status using errcode = '22023';
    end if;
    if (p_after_created_at is null) <> (p_after_id is null) then
        raise exception 'report cursor is incomplete' using errcode = '22023';
    end if;
    -- Open reports read oldest first, so the one waiting longest is on top;
    -- the rest newest first.
    v_open := p_status = 'open';

    with filtered as (
        select cr.*
        from public.content_reports cr
        where (p_status = 'all'
               or (p_status = 'open' and cr.status = 'received')
               or (p_status = 'decided' and cr.status <> 'received'))
    ),
    page as (
        select f.*,
               row_number() over (
                   order by
                       case when v_open then f.created_at end asc,
                       case when v_open then f.id end asc,
                       case when not v_open then f.created_at end desc,
                       case when not v_open then f.id end desc
               ) as rn
        from filtered f
        where p_after_id is null
           or (v_open and (f.created_at, f.id) > (p_after_created_at, p_after_id))
           or (not v_open and (f.created_at, f.id) < (p_after_created_at, p_after_id))
    ),
    limited as (
        select * from page where rn <= v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'reference', l.reference,
                    'created_at', l.created_at,
                    'kind', l.kind,
                    'category', l.category,
                    'content_url', l.content_url,
                    'document_id', l.document_id,
                    'document_title', (select d.title from public.documents d where d.id = l.document_id),
                    'work_description', l.work_description,
                    'explanation', l.explanation,
                    'reporter_name', l.reporter_name,
                    'reporter_email', l.reporter_email,
                    -- The complete notice as submitted, attestations included.
                    'reporter_address', l.reporter_address,
                    'reporter_phone', l.reporter_phone,
                    'on_behalf_of', l.on_behalf_of,
                    'reporter_user_id', l.reporter_user_id,
                    'good_faith', l.good_faith,
                    'perjury_statement', l.perjury_statement,
                    'signature', l.signature,
                    'status', l.status,
                    'decided_at', l.decided_at,
                    'decision_note', l.decision_note,
                    'acknowledged_at', l.acknowledged_at,
                    'active_takedown_id', (
                        select t.id from public.content_takedowns t
                        where t.document_id = l.document_id and t.lifted_at is null
                    )
                )
                order by l.rn
            )
            from limited l
            where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    select count(*)::int into v_total
    from public.content_reports cr
    where (p_status = 'all'
           or (p_status = 'open' and cr.status = 'received')
           or (p_status = 'decided' and cr.status <> 'received'));

    -- The cursor is the last row served; there is none after the last page.
    return jsonb_build_object(
        'rows', v_rows,
        'total', v_total,
        'next', case when v_count > v_limit
                     then jsonb_build_object('created_at', v_rows -> (v_limit - 1) -> 'created_at',
                                             'id', v_rows -> (v_limit - 1) -> 'id')
                end
    );
end;
$$;

create or replace function public.moderation_takedowns (
    p_state text default 'active',
    p_after_created_at timestamptz default null,
    p_after_id uuid default null,
    p_limit integer default 25
) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
    v_rows jsonb;
    v_count int;
    v_total int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;
    if p_state not in ('active', 'lifted', 'all') then
        raise exception 'unknown takedown filter: %', p_state using errcode = '22023';
    end if;
    if (p_after_created_at is null) <> (p_after_id is null) then
        raise exception 'takedown cursor is incomplete' using errcode = '22023';
    end if;

    with limited as (
        select ct.*, row_number() over (order by ct.created_at desc, ct.id desc) as rn
        from public.content_takedowns ct
        where (p_state = 'all'
               or (p_state = 'active' and ct.lifted_at is null)
               or (p_state = 'lifted' and ct.lifted_at is not null))
          and (p_after_id is null or (ct.created_at, ct.id) < (p_after_created_at, p_after_id))
        order by ct.created_at desc, ct.id desc
        limit v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', l.id,
                    'document_id', l.document_id,
                    'document_title', l.document_title,
                    'report_id', l.report_id,
                    'uploader_id', l.uploader_id,
                    'action', l.action,
                    'ground', l.ground,
                    'legal_basis', l.legal_basis,
                    'facts', l.facts,
                    'created_at', l.created_at,
                    'lifted_at', l.lifted_at,
                    'lift_reason', l.lift_reason,
                    'uploader_active_strikes', case when l.uploader_id is null then 0
                                                    else public.active_content_strikes (l.uploader_id) end
                )
                order by l.rn
            )
            from limited l
            where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    select count(*)::int into v_total
    from public.content_takedowns ct
    where (p_state = 'all'
           or (p_state = 'active' and ct.lifted_at is null)
           or (p_state = 'lifted' and ct.lifted_at is not null));

    -- The cursor is the last row served; there is none after the last page.
    return jsonb_build_object(
        'rows', v_rows,
        'total', v_total,
        'next', case when v_count > v_limit
                     then jsonb_build_object('created_at', v_rows -> (v_limit - 1) -> 'created_at',
                                             'id', v_rows -> (v_limit - 1) -> 'id')
                end
    );
end;
$$;

-- The log, newest first. Its identity id grows with every insert, so it is
-- the whole cursor.
create or replace function public.moderation_log (p_before_id bigint default null, p_limit integer default 50) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
    v_rows jsonb;
    v_count int;
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;

    with limited as (
        select nl.id, nl.created_at, nl.report_id, nl.takedown_id, nl.event, nl.recipient, nl.delivery,
               row_number() over (order by nl.id desc) as rn
        from public.content_notice_log nl
        where p_before_id is null or nl.id < p_before_id
        order by nl.id desc
        limit v_limit + 1
    )
    select
        coalesce((
            select jsonb_agg(to_jsonb(l) - 'rn' order by l.rn) from limited l where l.rn <= v_limit
        ), '[]'::jsonb),
        (select count(*)::int from limited)
    into v_rows, v_count;

    return jsonb_build_object(
        'rows', v_rows,
        'next', case when v_count > v_limit
                     then jsonb_build_object('id', (v_rows -> (v_limit - 1) ->> 'id')::bigint)
                end,
        -- Notices still owed (content_notice_outbox), and how many of those
        -- last failed or found mail unconfigured rather than waiting on budget.
        'undelivered', (select count(*)::int from public.content_notice_outbox where status = 'pending'),
        'failing', (
            select count(*)::int from public.content_notice_outbox
            where status = 'pending' and last_outcome in ('failed', 'unconfigured')
        )
    );
end;
$$;

revoke all on function public.moderation_reports (text, timestamptz, uuid, integer) from public;
revoke all on function public.moderation_reports (text, timestamptz, uuid, integer) from anon;
grant execute on function public.moderation_reports (text, timestamptz, uuid, integer) to authenticated;

revoke all on function public.moderation_takedowns (text, timestamptz, uuid, integer) from public;
revoke all on function public.moderation_takedowns (text, timestamptz, uuid, integer) from anon;
grant execute on function public.moderation_takedowns (text, timestamptz, uuid, integer) to authenticated;

revoke all on function public.moderation_log (bigint, integer) from public;
revoke all on function public.moderation_log (bigint, integer) from anon;
grant execute on function public.moderation_log (bigint, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------

-- 20261010120300's definition plus the takedown clause: a restricted score
-- answers its owner only; a removed one answers nobody.
create or replace function public.document_role (doc uuid) returns text language sql stable security definer
set search_path = public as $$
    select dm.role
    from public.document_members dm
    where dm.document_id = doc
      and dm.user_id = (select auth.uid())
      and not exists (
          select 1
          from public.managed_students ms
          where ms.student_user_id = dm.user_id
            and public.student_access_revoked ()
      )
      and not exists (
          select 1
          from public.content_takedowns ct
          where ct.document_id = doc
            and ct.lifted_at is null
            and (ct.action = 'remove' or dm.role <> 'owner')
      );
$$;

-- Nobody new joins a taken-down score — not through a share link
-- (redeem_share_link), a roster assignment, or anything else that adds a
-- member — so lifting the takedown restores exactly the access it suspended.
create or replace function public.refuse_members_on_taken_down () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if new.role <> 'owner' and exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = new.document_id and ct.lifted_at is null
    ) then
        raise exception 'this score is unavailable' using errcode = '42501', detail = '{"code":"content_unavailable"}';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_members_on_taken_down () from public;
revoke all on function public.refuse_members_on_taken_down () from anon;
revoke all on function public.refuse_members_on_taken_down () from authenticated;

drop trigger if exists document_members_refuse_taken_down on public.document_members;
create trigger document_members_refuse_taken_down
before insert on public.document_members
for each row execute function public.refuse_members_on_taken_down ();

create or replace function public.refuse_share_links_on_taken_down () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = new.document_id and ct.lifted_at is null
    ) then
        raise exception 'this score cannot be shared' using errcode = '42501', detail = '{"code":"content_unavailable"}';
    end if;
    return new;
end;
$$;

revoke all on function public.refuse_share_links_on_taken_down () from public;
revoke all on function public.refuse_share_links_on_taken_down () from anon;
revoke all on function public.refuse_share_links_on_taken_down () from authenticated;

drop trigger if exists share_links_refuse_taken_down on public.share_links;
create trigger share_links_refuse_taken_down
before insert on public.share_links
for each row execute function public.refuse_share_links_on_taken_down ();

-- ---------------------------------------------------------------------------
-- Realtime: cutting off viewers who are already connected
-- ---------------------------------------------------------------------------
-- Superseded in part by 20261020150100_takedown_realtime_topics: a takedown
-- now moves the score to fresh topics, so a client that ignores the hint is
-- left on a dead doc:{id}, and the owner's devices keep their committed-row
-- fan-out. What follows is how this migration left it.
--
-- document_role() refuses a taken-down score when a channel JOINS, but a
-- collaborator who joined before the takedown keeps the channel: Realtime does
-- not re-run the realtime.messages policies per message. Two things close it:
--
--  1. The server stops sending the score's committed changes. Every
--     server-authored event on doc-db:{id} (committed marks, the PDF being
--     replaced, play-along status) comes from the three trigger functions
--     below, which now send nothing while the score has a live takedown. A
--     client that ignores everything we tell it still receives nothing more
--     on doc-db:{id}. For a restricted score this pauses its owner's live
--     sync between their own devices too (each still syncs by pulling, on
--     reconnect and when it comes online); nobody else can be sent its
--     changes, and a broadcast cannot pick out one recipient.
--  2. Every viewer who lost access is sent the `membership` hint on
--     doc:{id}, with role null, the way end_student_sessions does it. The
--     app re-reads the score and its role over PostgREST, which IS checked
--     per request, finds neither, closes the score and leaves both channels.
--     It is only a hint: the client never trusts the payload.
--
-- What stays open is doc:{id} itself for a client that ignores the hint: live
-- ink and presence, which clients send to each other (the server cannot drop
-- one recipient's copy). It carries in-progress strokes, never the score or
-- its committed markings, and only while the owner is drawing; Realtime
-- re-runs the policies when the client refreshes its access token and closes
-- the channel when that token expires (auth.jwt_expiry, an hour), so a
-- refused re-check ends it there. tests/sql/content_moderation.sql proves the
-- rest: no doc-db:{id} message while taken down, the hint to each member who
-- lost access, a refused re-join on both topics, and broadcasts back on lift.

-- Whether a score has a live takedown. Internal: the triggers below and the
-- notification call it as their owner; no client can ask it about a score.
create or replace function public.content_taken_down (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.content_takedowns ct
        where ct.document_id = doc and ct.lifted_at is null
    );
$$;

revoke all on function public.content_taken_down (uuid) from public;
revoke all on function public.content_taken_down (uuid) from anon;
revoke all on function public.content_taken_down (uuid) from authenticated;

-- The membership hint to every member a takedown shuts out: everyone but the
-- owner for restrict, everyone for remove.
create or replace function public.content_takedown_notify_viewers (p_document uuid, p_action text) returns void language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid;
begin
    for v_user in
        select dm.user_id
        from public.document_members dm
        where dm.document_id = p_document
          and (p_action = 'remove' or dm.role <> 'owner')
    loop
        perform realtime.send(
            jsonb_build_object(
                'table', 'document_members',
                'document_id', p_document,
                'user_id', v_user,
                'role', null
            ),
            'membership', -- event
            'doc:' || p_document::text, -- topic
            true -- private
        );
    end loop;
end;
$$;

revoke all on function public.content_takedown_notify_viewers (uuid, text) from public;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from anon;
revoke all on function public.content_takedown_notify_viewers (uuid, text) from authenticated;

-- 20261007120101's three fan-out functions, unchanged but for the takedown check.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_taken_down (new.document_id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        tg_op,                              -- event name ('INSERT' | 'UPDATE')
        tg_op,                              -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if public.content_taken_down (new.id) then
        return null;
    end if;
    perform realtime.broadcast_changes(
        'doc-db:' || new.id::text, -- topic (receive-only for clients)
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;
    if public.content_taken_down (new.document_id) then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The owner's own read of a removed score
-- ---------------------------------------------------------------------------
-- documents_select (20260802044133) lets an owner read their row without
-- document_role(), so a removed score's title and storage path stayed one
-- PostgREST request away from its uploader, and the app, re-checking after
-- the hint above, would still have found it. The owner clause now stops at a
-- removal; a restricted score stays readable by its owner, as document_role()
-- has it. The function answers only about the caller's own scores.
create or replace function public.owned_document_removed (doc uuid) returns boolean language sql stable security definer
set search_path = public as $$
    select exists (
        select 1
        from public.content_takedowns ct
        join public.documents d on d.id = ct.document_id
        where ct.document_id = doc
          and ct.lifted_at is null
          and ct.action = 'remove'
          and d.owner_id = (select auth.uid())
    );
$$;

revoke all on function public.owned_document_removed (uuid) from public;
revoke all on function public.owned_document_removed (uuid) from anon;
grant execute on function public.owned_document_removed (uuid) to authenticated;

-- ALTER, not drop and create: the policy keeps its name, command and role, and
-- owners never lose their read mid-migration.
alter policy documents_select on public.documents
using (
    (owner_id = (select auth.uid()) and not public.owned_document_removed (id))
    or public.document_role (id) is not null
);

-- 20261014120000's library_documents(), unchanged but for the takedown clause:
-- it lists memberships directly, so document_role() alone would leave a
-- taken-down score in its members' libraries, failing to open.
create or replace function public.library_documents (
    p_sort text default 'recent',
    p_after_updated_at timestamptz default null,
    p_after_title text default null,
    p_after_id uuid default null,
    p_query text default null,
    p_tag_id uuid default null,
    p_favorites_only boolean default false,
    p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid uuid := (select auth.uid());
    v_sort text := coalesce(p_sort, 'recent');
    v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_pattern text;
    v_rows jsonb;
    v_count int;
    -- Once per call, not per row: about the caller only.
    v_revoked boolean := public.student_access_revoked ();
begin
    if v_uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if v_sort not in ('recent', 'title') then
        raise exception 'unknown library sort: %', v_sort using errcode = '22023';
    end if;
    -- A half cursor would compare against null and silently return nothing.
    if p_after_id is not null
       and ((v_sort = 'recent' and p_after_updated_at is null)
            or (v_sort = 'title' and p_after_title is null)) then
        raise exception 'library cursor is incomplete' using errcode = '22023';
    end if;

    if v_query is not null then
        -- Titles are short; a pasted paragraph is not a search worth running.
        -- Escape ilike's own wildcards so "50%" or "op_1" match literally.
        v_pattern := '%'
            || replace(replace(replace(left(v_query, 200), '\', '\\'), '%', '\%'), '_', '\_')
            || '%';
    end if;

    with visible as (
        select
            d.id,
            d.owner_id,
            d.title,
            d.storage_path,
            d.page_count,
            d.content_rev,
            d.thumb_rev,
            d.created_at,
            d.updated_at,
            d.archived_at
        from public.documents d
        -- The caller's own scores (documents_owner_id_idx) and memberships
        -- (document_members_user), collected first and then looked up by
        -- primary key. Written as `= any (array(...))` rather than a join so
        -- the planner cannot turn it back into a scan: on a join it hashed the
        -- candidates and still read every row of documents to apply a title
        -- search, 31 ms where this takes 2.
        where d.id = any (array(
                select o.id
                from public.documents o
                where o.owner_id = v_uid
                union
                select m.document_id
                from public.document_members m
                where m.user_id = v_uid
                  and not v_revoked
            ))
          and (v_pattern is null or d.title ilike v_pattern)
          -- Taken down (20261020150000): a restricted score lists for its owner
          -- only, a removed one for nobody — the same answer document_role() gives.
          and not exists (
                select 1
                from public.content_takedowns ct
                where ct.document_id = d.id
                  and ct.lifted_at is null
                  and (ct.action = 'remove' or d.owner_id <> v_uid)
            )
          and (
                p_tag_id is null
                or exists (
                    select 1
                    from public.document_tags dt
                    join public.library_tags t on t.id = dt.tag_id
                    where dt.document_id = d.id
                      and dt.tag_id = p_tag_id
                      and t.user_id = v_uid
                )
            )
          and (
                not coalesce(p_favorites_only, false)
                or exists (
                    select 1
                    from public.document_favorites f
                    where f.document_id = d.id
                      and f.user_id = v_uid
                )
            )
          and (
                p_after_id is null
                or (v_sort = 'recent' and (d.updated_at, d.id) < (p_after_updated_at, p_after_id))
                or (v_sort = 'title' and (lower(d.title), d.id) > (lower(p_after_title), p_after_id))
            )
    ),
    ordered as (
        select
            v.*,
            row_number() over (
                order by
                    case when v_sort = 'title' then lower(v.title) end asc,
                    case when v_sort = 'title' then v.id end asc,
                    case when v_sort = 'recent' then v.updated_at end desc,
                    case when v_sort = 'recent' then v.id end desc
            ) as rn
        from visible v
    ),
    page as (
        select * from ordered where rn <= v_limit + 1
    )
    select
        coalesce(
            (select jsonb_agg(to_jsonb(p) - 'rn' order by p.rn) from page p where p.rn <= v_limit),
            '[]'::jsonb
        ),
        (select count(*)::int from page)
    into v_rows, v_count;

    return jsonb_build_object(
        'documents', v_rows,
        'has_more', v_count > v_limit
    );
end;
$$;

revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from public;
revoke all on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) from anon;
grant execute on function public.library_documents (text, timestamptz, text, uuid, text, uuid, boolean, integer) to authenticated;
