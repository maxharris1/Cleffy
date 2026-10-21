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
-- if it is, read the queue (moderation_queue). Moderators are granted by hand:
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
-- the scores and thumbnails storage policies, both realtime topics — and in
-- library_documents(), which lists memberships directly.

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
    delivery text check (delivery is null or delivery in ('sent', 'failed', 'unconfigured', 'skipped')),
    actor_id uuid references auth.users (id) on delete set null,
    detail jsonb not null default '{}'::jsonb
);

create index if not exists content_notice_log_created_idx on public.content_notice_log (created_at desc);

alter table public.content_notice_log enable row level security;
revoke all on table public.content_notice_log from anon, authenticated;

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

    return jsonb_build_object(
        'takedown_id', v_takedown,
        'uploader_id', v_doc.owner_id,
        'document_title', v_doc.title,
        'active_strikes', v_strikes
    );
end;
$$;

create or replace function public.lift_content_takedown (p_takedown uuid, p_reason text, p_moderator uuid) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_row record;
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

    return jsonb_build_object(
        'takedown_id', v_row.id,
        'document_id', v_row.document_id,
        'uploader_id', v_row.uploader_id,
        'document_title', v_row.document_title,
        'report_id', v_row.report_id
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

    return to_jsonb(v_row);
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
-- The moderator's read: the queue, the takedowns with each uploader's strike
-- count, and the notice log. Refuses everyone else.
-- ---------------------------------------------------------------------------

create or replace function public.moderation_queue () returns jsonb language plpgsql stable security definer
set search_path = public as $$
begin
    if not public.is_content_moderator () then
        raise exception 'not a moderator' using errcode = '42501';
    end if;

    return jsonb_build_object(
        'reports', coalesce((
            select jsonb_agg(to_jsonb(r) order by r.created_at desc)
            from (
                select cr.id, cr.reference, cr.created_at, cr.kind, cr.category, cr.content_url,
                       cr.document_id, d.title as document_title, cr.work_description, cr.explanation,
                       cr.reporter_name, cr.reporter_email, cr.on_behalf_of, cr.status,
                       cr.decided_at, cr.decision_note, cr.acknowledged_at,
                       (select t.id from public.content_takedowns t
                        where t.document_id = cr.document_id and t.lifted_at is null) as active_takedown_id
                from public.content_reports cr
                left join public.documents d on d.id = cr.document_id
                order by cr.created_at desc
                limit 200
            ) r
        ), '[]'::jsonb),
        'takedowns', coalesce((
            select jsonb_agg(to_jsonb(t) order by t.created_at desc)
            from (
                select ct.id, ct.document_id, ct.document_title, ct.report_id, ct.uploader_id, ct.action,
                       ct.ground, ct.legal_basis, ct.facts, ct.created_at, ct.lifted_at, ct.lift_reason,
                       case when ct.uploader_id is null then 0
                            else public.active_content_strikes (ct.uploader_id) end as uploader_active_strikes
                from public.content_takedowns ct
                order by ct.created_at desc
                limit 200
            ) t
        ), '[]'::jsonb),
        'log', coalesce((
            select jsonb_agg(to_jsonb(l) order by l.created_at desc, l.id desc)
            from (
                select nl.id, nl.created_at, nl.report_id, nl.takedown_id, nl.event, nl.recipient, nl.delivery
                from public.content_notice_log nl
                order by nl.created_at desc, nl.id desc
                limit 300
            ) l
        ), '[]'::jsonb)
    );
end;
$$;

revoke all on function public.moderation_queue () from public;
revoke all on function public.moderation_queue () from anon;
grant execute on function public.moderation_queue () to authenticated;

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
