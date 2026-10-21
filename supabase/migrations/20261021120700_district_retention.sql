-- District retention: district data goes 30 days after the contract ends.
--
-- Decision 1 of the launch fix pass: a district's billing record carries
-- contract_ends_at (set by an admin from the contract, or from the Stripe
-- subscription's cancel / ended date; mh/district-seats owns how it is set).
-- Thirty days after it, the district's data is purged:
--
--   contract_ends_at + 16 days   the owner is sent an export notice (14 days
--                                before the purge), through the
--                                district-retention-notices function
--   contract_ends_at + 30 days,  SOFT delete: the district's roster students
--   and >= 14 days after the     are archived (signed out of everything, by
--   notice was actually SENT     student_access_revoked) and listed for the
--                                purge. Undone if the contract comes back.
--   soft delete + 7 days         HARD delete: each listed student still
--                                archived is scrubbed and deleted, exactly as
--                                Delete student does, then the district studio
--                                (its seats, its override, this billing record
--                                cascade with it)
--
-- contract_ends_at null means never. A contract that is cleared or moved (a
-- renewal, an admin correction) cancels whatever stage the purge reached and
-- un-archives every student the soft delete archived. Every step is logged
-- with its counts in district_retention_log, which outlives the studio.
--
-- What "district data" is here: the district studio and everything keyed to
-- it, and the roster students (with their markings) provisioned under the
-- district -- the school-provided student data the contract covered.
-- Teachers' own accounts and scores are theirs, not the district's, and are
-- not touched. See retention_district_students(), which
-- 20261021120800_district_student_attribution.sql scopes to the district each
-- student was provisioned under (not to whoever is seated on the day).
--
-- PAUSED. Nothing schedules retention_district_run(): Max first reads the
-- counts from retention_district_dry_run() against production, then schedules
-- it (DEPLOY note below). The notice sender needs the vault secrets
-- district_notice_url / district_notice_secret; without them notices queue and
-- nothing is purged, because nothing is purged before its notice was sent.

-- ---------------------------------------------------------------------------
-- The district billing record
-- ---------------------------------------------------------------------------
-- mh/district-seats (#61) creates this table in 20261020180500, which sorts
-- first; this is the same shape, so on a database that already has it the
-- create is a no-op, and on this branch alone the purge has its column.
create table if not exists public.district_billing (
    studio_id uuid primary key references public.studios (id) on delete cascade,
    stripe_subscription_id text references public.subscriptions (stripe_subscription_id) on delete set null,
    contract_ends_at timestamptz,
    contract_ends_source text check (contract_ends_source in ('admin', 'stripe')),
    grace_extended_until timestamptz,
    updated_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.district_billing
add column if not exists contract_ends_at timestamptz;

alter table public.district_billing enable row level security;

revoke all on table public.district_billing from public, anon, authenticated;

grant all on table public.district_billing to service_role;

-- ---------------------------------------------------------------------------
-- Purge state, the student list, the notice outbox and the log
-- ---------------------------------------------------------------------------
-- No foreign keys to studios: each of these outlives the studio it describes,
-- which is the point of a record of a deletion.

-- One row per district in a purge cycle, for the contract end it was started
-- for. Removed when the cycle is cancelled; kept (hard_deleted_at set) when it
-- completes.
create table if not exists public.district_retention (
    studio_id uuid primary key,
    owner_id uuid,
    contract_ends_at timestamptz not null,
    notice_queued_at timestamptz not null default now(),
    notice_sent_at timestamptz,
    soft_deleted_at timestamptz,
    hard_deleted_at timestamptz
);

-- The students a soft delete archived, and whether they were archived already
-- (a cancel un-archives only the ones it archived itself).
create table if not exists public.district_retention_students (
    studio_id uuid not null,
    managed_student_id uuid not null,
    student_user_id uuid not null,
    was_archived boolean not null,
    primary key (studio_id, managed_student_id)
);

create table if not exists public.district_retention_notices (
    id bigint generated by default as identity primary key,
    studio_id uuid not null,
    owner_id uuid,
    to_email text not null,
    studio_name text not null,
    contract_ends_at timestamptz not null,
    purge_not_before timestamptz not null,
    created_at timestamptz not null default now(),
    attempts int not null default 0,
    lease_until timestamptz,
    last_error text,
    sent_at timestamptz,
    unique (studio_id, contract_ends_at)
);

create table if not exists public.district_retention_log (
    id bigint generated by default as identity primary key,
    studio_id uuid not null,
    step text not null check (step in ('notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled')),
    contract_ends_at timestamptz,
    counts jsonb not null default '{}'::jsonb,
    at timestamptz not null default now()
);

create index if not exists district_retention_log_studio on public.district_retention_log (studio_id, at desc);

alter table public.district_retention enable row level security;

alter table public.district_retention_students enable row level security;

alter table public.district_retention_notices enable row level security;

alter table public.district_retention_log enable row level security;

revoke all on table public.district_retention, public.district_retention_students, public.district_retention_notices,
public.district_retention_log
from public, anon, authenticated;

grant all on table public.district_retention, public.district_retention_students, public.district_retention_notices,
public.district_retention_log
to service_role;

-- ---------------------------------------------------------------------------
-- Which roster students are the district's
-- ---------------------------------------------------------------------------
-- Provisioned by the studio's owner or by a teacher seated in it.
create or replace function public.retention_district_students (p_studio uuid) returns setof public.managed_students
language sql stable security definer
set search_path = public as $$
    select ms.*
    from public.managed_students ms
    where ms.teacher_id in (
        select st.owner_id from public.studios st where st.id = p_studio
        union
        select sm.user_id from public.studio_members sm where sm.studio_id = p_studio
    );
$$;

-- ---------------------------------------------------------------------------
-- The next step for one district, the one rule the run and the dry run share
-- ---------------------------------------------------------------------------
-- 'notice' | 'soft_delete' | 'hard_delete' | 'cancel' | null (nothing due).
create or replace function public.retention_district_next_step (
    p_contract_ends_at timestamptz,
    p_state public.district_retention,
    p_now timestamptz,
    p_notice_after interval default interval '16 days',
    p_purge_after interval default interval '30 days',
    p_notice_lead interval default interval '14 days',
    p_hard_after interval default interval '7 days'
) returns text language sql immutable
set search_path = public as $$
    select case
        when p_state.studio_id is not null and p_state.hard_deleted_at is not null then null
        -- The contract was cleared or moved since this cycle began.
        when p_state.studio_id is not null
             and p_contract_ends_at is distinct from p_state.contract_ends_at then 'cancel'
        when p_contract_ends_at is null then null
        when p_state.studio_id is null then
            case when p_now >= p_contract_ends_at + p_notice_after then 'notice' end
        when p_state.soft_deleted_at is not null then
            case when p_now >= p_state.soft_deleted_at + p_hard_after then 'hard_delete' end
        when p_state.notice_sent_at is not null
             and p_now >= greatest(p_contract_ends_at + p_purge_after, p_state.notice_sent_at + p_notice_lead)
            then 'soft_delete'
    end;
$$;

-- Every district with a step due or a cycle open: the billing records, and
-- the cycles whose billing record is gone (the studio was deleted another way).
create or replace function public.retention_district_candidates (p_now timestamptz)
returns table (studio_id uuid, contract_ends_at timestamptz, next_step text)
language sql stable security definer
set search_path = public as $$
    select coalesce(b.studio_id, r.studio_id),
           b.contract_ends_at,
           public.retention_district_next_step (b.contract_ends_at, r, p_now)
    from public.district_billing b
    full join public.district_retention r on r.studio_id = b.studio_id
    where public.retention_district_next_step (b.contract_ends_at, r, p_now) is not null;
$$;

-- ---------------------------------------------------------------------------
-- Dry run: counts only, writes nothing
-- ---------------------------------------------------------------------------
create or replace function public.retention_district_dry_run (p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer
set search_path = public as $$
declare
    v_studios jsonb;
begin
    select coalesce(jsonb_agg(jsonb_build_object(
               'studio_id', c.studio_id,
               'contract_ends_at', c.contract_ends_at,
               'next_step', c.next_step,
               'students', (select count(*) from public.retention_district_students (c.studio_id)),
               'listed_students', (select count(*) from public.district_retention_students s
                                   where s.studio_id = c.studio_id),
               'members', (select count(*) from public.studio_members sm where sm.studio_id = c.studio_id),
               'notice_sent_at', (select r.notice_sent_at from public.district_retention r
                                  where r.studio_id = c.studio_id)
           ) order by c.contract_ends_at nulls last), '[]'::jsonb)
    into v_studios
    from public.retention_district_candidates (p_now) c;

    return jsonb_build_object(
        'now', p_now,
        'studios', v_studios,
        'notices_due', (select count(*) from jsonb_array_elements(v_studios) e where e ->> 'next_step' = 'notice'),
        'soft_deletes_due', (select count(*) from jsonb_array_elements(v_studios) e
                             where e ->> 'next_step' = 'soft_delete'),
        'hard_deletes_due', (select count(*) from jsonb_array_elements(v_studios) e
                             where e ->> 'next_step' = 'hard_delete'),
        'cancels_due', (select count(*) from jsonb_array_elements(v_studios) e where e ->> 'next_step' = 'cancel'),
        'students_to_archive', (select coalesce(sum((e ->> 'students')::int), 0) from jsonb_array_elements(v_studios) e
                                where e ->> 'next_step' = 'soft_delete'),
        'students_to_delete', (select coalesce(sum((e ->> 'listed_students')::int), 0)
                               from jsonb_array_elements(v_studios) e where e ->> 'next_step' = 'hard_delete'),
        'unsent_notices', (select count(*) from public.district_retention_notices where sent_at is null)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- The run
-- ---------------------------------------------------------------------------
-- Each district is locked through its billing record (FOR UPDATE SKIP LOCKED,
-- so an admin editing it is passed over until tomorrow) and its next step is
-- worked out again under that lock: a contract renewed after the candidates
-- were listed is cancelled, not purged.
create or replace function public.retention_district_run (p_now timestamptz default now(), p_batch int default 20)
returns jsonb language plpgsql security definer
set search_path = public, extensions, vault as $$
declare
    candidate record;
    v_billing public.district_billing;
    v_state public.district_retention;
    v_step text;
    v_owner uuid;
    v_email text;
    v_name text;
    v_student record;
    v_n int;
    v_members int;
    v_url text;
    v_secret text;
    v_done jsonb := '{"notice":0,"soft_delete":0,"hard_delete":0,"cancel":0,"students_archived":0,"students_deleted":0,"students_restored":0}';
begin
    for candidate in
        select c.studio_id from public.retention_district_candidates (p_now) c
        order by c.contract_ends_at nulls first
        limit greatest(p_batch, 0)
    loop
        v_billing := null;
        select b.* into v_billing from public.district_billing b where b.studio_id = candidate.studio_id
        for update skip locked;
        if not found and exists (select 1 from public.district_billing b where b.studio_id = candidate.studio_id) then
            continue; -- locked by someone else: tomorrow
        end if;

        v_state := null;
        select r.* into v_state from public.district_retention r where r.studio_id = candidate.studio_id for update;

        v_step := public.retention_district_next_step (v_billing.contract_ends_at, v_state, p_now);

        if v_step = 'cancel' then
            update public.managed_students ms
            set archived_at = null
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id
              and s.managed_student_id = ms.id
              and not s.was_archived
              and ms.archived_at is not null;
            get diagnostics v_n = row_count;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            delete from public.district_retention_notices
            where studio_id = candidate.studio_id and sent_at is null;
            delete from public.district_retention where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'cancelled', v_state.contract_ends_at,
                    jsonb_build_object('students_restored', v_n, 'new_contract_ends_at', v_billing.contract_ends_at));
            v_done := v_done || jsonb_build_object(
                'cancel', (v_done ->> 'cancel')::int + 1,
                'students_restored', (v_done ->> 'students_restored')::int + v_n);

        elsif v_step = 'notice' then
            select st.owner_id, st.name, u.email into v_owner, v_name, v_email
            from public.studios st
            left join auth.users u on u.id = st.owner_id
            where st.id = candidate.studio_id;
            if v_email is null then
                -- Nobody to tell, so nothing will be purged: the next stage
                -- waits for a SENT notice. Logged loudly for a human.
                raise warning 'district retention: studio % has no owner address; not purging', candidate.studio_id;
                continue;
            end if;
            insert into public.district_retention (studio_id, owner_id, contract_ends_at, notice_queued_at)
            values (candidate.studio_id, v_owner, v_billing.contract_ends_at, p_now);
            insert into public.district_retention_notices
                (studio_id, owner_id, to_email, studio_name, contract_ends_at, purge_not_before)
            values (candidate.studio_id, v_owner, v_email, v_name, v_billing.contract_ends_at,
                    greatest(v_billing.contract_ends_at + interval '30 days', p_now + interval '14 days'))
            -- A cycle cancelled and begun again for the same date mails again:
            -- the owner may have been told the purge was off.
            on conflict (studio_id, contract_ends_at) do update
            set to_email = excluded.to_email,
                studio_name = excluded.studio_name,
                purge_not_before = excluded.purge_not_before,
                created_at = now(),
                attempts = 0,
                lease_until = null,
                last_error = null,
                sent_at = null;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'notice_queued', v_billing.contract_ends_at,
                    jsonb_build_object('students', (select count(*) from public.retention_district_students (candidate.studio_id)),
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object('notice', (v_done ->> 'notice')::int + 1);

        elsif v_step = 'soft_delete' then
            insert into public.district_retention_students (studio_id, managed_student_id, student_user_id, was_archived)
            select candidate.studio_id, ds.id, ds.student_user_id, ds.archived_at is not null
            from public.retention_district_students (candidate.studio_id) ds
            on conflict do nothing;

            -- Archived and every token refused (student_access_revoked), under
            -- the roster row's lock that student writes share (20261021120400).
            update public.managed_students ms
            set archived_at = coalesce(ms.archived_at, p_now),
                access_revoked_at = clock_timestamp()
            from public.district_retention_students s
            where s.studio_id = candidate.studio_id and s.managed_student_id = ms.id;
            get diagnostics v_n = row_count;

            delete from auth.refresh_tokens
            where user_id in (select s.student_user_id::text from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);
            delete from auth.sessions
            where user_id in (select s.student_user_id from public.district_retention_students s
                              where s.studio_id = candidate.studio_id);

            update public.district_retention set soft_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'soft_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_archived', v_n,
                                       'members', (select count(*) from public.studio_members sm
                                                   where sm.studio_id = candidate.studio_id)));
            v_done := v_done || jsonb_build_object(
                'soft_delete', (v_done ->> 'soft_delete')::int + 1,
                'students_archived', (v_done ->> 'students_archived')::int + v_n);

        elsif v_step = 'hard_delete' then
            v_n := 0;
            for v_student in
                select s.managed_student_id, s.student_user_id
                from public.district_retention_students s
                where s.studio_id = candidate.studio_id
            loop
                -- Still archived (a teacher's restore since the soft delete
                -- wins) and still a provisioned student: the same re-check
                -- under the same lock as the 12-month purge (20261021120500).
                perform 1
                from public.managed_students m
                join auth.users u on u.id = m.student_user_id
                where m.id = v_student.managed_student_id
                  and m.archived_at is not null
                  and u.raw_app_meta_data ->> 'user_type' = 'student'
                for update of m;
                if found then
                    perform public.scrub_student_markings (v_student.student_user_id);
                    delete from auth.users where id = v_student.student_user_id;
                    v_n := v_n + 1;
                end if;
            end loop;

            select count(*) into v_members from public.studio_members sm where sm.studio_id = candidate.studio_id;
            -- Takes the seats, the override and the billing record with it.
            delete from public.studios where id = candidate.studio_id;
            delete from public.district_retention_students where studio_id = candidate.studio_id;
            update public.district_retention set hard_deleted_at = p_now where studio_id = candidate.studio_id;
            insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
            values (candidate.studio_id, 'hard_deleted', v_state.contract_ends_at,
                    jsonb_build_object('students_deleted', v_n, 'members_removed', v_members, 'studios', 1));
            v_done := v_done || jsonb_build_object(
                'hard_delete', (v_done ->> 'hard_delete')::int + 1,
                'students_deleted', (v_done ->> 'students_deleted')::int + v_n);
        end if;
    end loop;

    -- Wake the sender when there is mail to send. No-op without its secrets.
    if exists (select 1 from public.district_retention_notices where sent_at is null) then
        begin
            select decrypted_secret into v_url from vault.decrypted_secrets where name = 'district_notice_url' limit 1;
            select decrypted_secret into v_secret from vault.decrypted_secrets
            where name = 'district_notice_secret' limit 1;
            if v_url is not null and v_secret is not null then
                perform net.http_post(
                    url := v_url,
                    headers := jsonb_build_object('Content-Type', 'application/json', 'x-district-notice-secret', v_secret),
                    body := '{}'::jsonb,
                    timeout_milliseconds := 5000
                );
            end if;
        exception
            when others then
                raise warning 'district retention: could not wake the notice sender: %', sqlerrm;
        end;
    end if;

    return v_done;
end;
$$;

-- ---------------------------------------------------------------------------
-- The notice sender's two calls (district-retention-notices)
-- ---------------------------------------------------------------------------
-- Claims unsent notices for ten minutes, so two senders never mail one twice
-- and a sender that dies hands them on.
create or replace function public.claim_district_retention_notices (p_limit int default 20)
returns setof public.district_retention_notices language plpgsql security definer
set search_path = public as $$
begin
    return query
    update public.district_retention_notices n
    set lease_until = now() + interval '10 minutes',
        attempts = n.attempts + 1
    where n.id in (
        select q.id from public.district_retention_notices q
        where q.sent_at is null and (q.lease_until is null or q.lease_until < now())
        order by q.id
        limit greatest(p_limit, 0)
        for update skip locked
    )
    returning n.*;
end;
$$;

-- p_error null: sent, which is what lets the purge go ahead 14 days later.
-- Otherwise the failure is kept and the notice is retried on the next run.
create or replace function public.finish_district_retention_notice (p_id bigint, p_error text default null)
returns void language plpgsql security definer
set search_path = public as $$
declare
    v_notice public.district_retention_notices;
begin
    if p_error is not null then
        update public.district_retention_notices
        set lease_until = null, last_error = left(p_error, 500)
        where id = p_id and sent_at is null;
        return;
    end if;

    update public.district_retention_notices
    set sent_at = now(), lease_until = null, last_error = null
    where id = p_id and sent_at is null
    returning * into v_notice;
    if not found then
        return;
    end if;

    update public.district_retention
    set notice_sent_at = v_notice.sent_at
    where studio_id = v_notice.studio_id and contract_ends_at = v_notice.contract_ends_at;

    insert into public.district_retention_log (studio_id, step, contract_ends_at, counts)
    values (v_notice.studio_id, 'notice_sent', v_notice.contract_ends_at,
            jsonb_build_object('attempts', v_notice.attempts));
end;
$$;

do $$
declare
    fn text;
begin
    foreach fn in array array[
        'public.retention_district_students (uuid)',
        'public.retention_district_next_step (timestamptz, public.district_retention, timestamptz, interval, interval, interval, interval)',
        'public.retention_district_candidates (timestamptz)',
        'public.retention_district_dry_run (timestamptz)',
        'public.retention_district_run (timestamptz, int)',
        'public.claim_district_retention_notices (int)',
        'public.finish_district_retention_notice (bigint, text)'
    ]
    loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end;
$$;

-- DEPLOY (Max, after reading retention_district_dry_run()'s counts):
--   select cron.schedule ('retention-district', '57 3 * * *',
--       $$select public.retention_district_run ()$$);
-- and the vault secrets district_notice_url (the function's URL) and
-- district_notice_secret (= DISTRICT_NOTICE_SECRET in the function's env).
