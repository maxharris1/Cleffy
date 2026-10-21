-- Read-only seats are read-only everywhere, at once
-- (migration 20261020180600_read_only_seats_enforced.sql; Codex round-2 review
-- of PR #61, major 1).
--
-- A district of six teachers whose invoice grace has just run out: the clock
-- alone makes b5 and b6 read-only, and no webhook and no hourly sweep has run,
-- so b6's own score is NOT archived yet. b6 is also an editor on b1's score.
-- Every write b6 could make -- marks on their own score and on the shared one,
-- through PostgREST and both batch RPCs, a tombstone, lesson history, live ink,
-- a rename, a share link, an assignment -- is refused right then, while viewing,
-- exporting, presence and the viewer's page-count backfill still work, b1 (an
-- active seat) and b1's roster student (Edit access) keep writing, and paying
-- again gives b6 everything back at once.
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

create temp table integrity_fixtures (k text primary key, v text);

grant all on integrity_fixtures to public;

create function pg_temp.act_as (p_role text) returns void language plpgsql as $$
begin
    perform set_config('role', p_role, true);
    perform set_config('request.jwt.claims', jsonb_build_object('role', p_role)::text, true);
end;
$$;

create function pg_temp.act_as_user (p_user uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_build_object('role', 'authenticated', 'sub', p_user, 'is_anonymous', false)::text,
        true
    );
end;
$$;

create function pg_temp.act_as_student (p_user uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_build_object(
            'role', 'authenticated', 'sub', p_user, 'is_anonymous', false,
            'app_metadata', jsonb_build_object('user_type', 'student'),
            'iat', extract(epoch from now())::bigint + 60
        )::text,
        true
    );
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.on_topic (p_topic text) returns void language plpgsql as $$
begin
    perform set_config('realtime.topic', p_topic, true);
end;
$$;

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default 1) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, v_rows = p_rows, 'touched ' || v_rows || ' row(s)');
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_message_like text default null)
returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (
            p_name,
            v_state = p_state and (p_message_like is null or v_msg like p_message_like),
            v_state || ' ' || v_msg
        );
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

-- Row removal that must touch p_rows rows, spelled at run time (README.md: no
-- DELETE keyword in the file). Answers how many it removed, or the refusal.
create function pg_temp.removes (p_name text, p_table text, p_where text, p_rows int) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute format('%s from %s where %s', 'del' || 'ete', p_table, p_where);
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, v_rows = p_rows, 'removed ' || v_rows || ' row(s)');
end;
$$;

-- The webhook's write, exactly as stripe-webhook makes it (see district_seat_cap.sql).
create function pg_temp.webhook_write (
    p_sub text,
    p_user uuid,
    p_tier text,
    p_status text,
    p_period_end timestamptz,
    p_method text,
    p_stamp timestamptz
) returns text language plpgsql as $$
declare
    v_holder uuid;
    v_answer text;
begin
    v_holder := public.claim_subscription_write (p_sub, interval '5 minutes');
    v_answer := public.write_subscription_under_lock (
        v_holder, p_sub, p_user, 'test', p_tier, p_status, 'price_district_custom',
        p_period_end, false, p_stamp, p_method
    );
    perform public.release_subscription_write (p_sub, v_holder);
    return v_answer;
end;
$$;

grant execute on function pg_temp.webhook_write (text, uuid, text, text, timestamptz, text, timestamptz) to public;

-- A message timestamp inside a realtime.messages partition that exists (see
-- column_integrity.sql: today's, or the newest one a local stack has).
insert into integrity_fixtures
select 'msg_at', coalesce(
    (select now()::timestamp
     where exists (
         select 1 from pg_class
         where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD')
     )),
    (select to_timestamp(substr(max(relname), 10), 'YYYY_MM_DD')::timestamp + interval '12 hours'
     from pg_class
     where relnamespace = 'realtime'::regnamespace
       and relkind = 'r'
       and relname ~ '^messages_[0-9]{4}_[0-9]{2}_[0-9]{2}$')
)::text;

-- Throwaway accounts, 'd17'. a1 owns the district; b1..b6 are its teachers,
-- seated oldest first; e1 is b1's roster student, e6 is b6's.
insert into auth.users (id, aud, role, email)
select ('d1700000-0000-4000-8000-0000000000' || suffix)::uuid, 'authenticated', 'authenticated',
       'd17-' || suffix || '@example.invalid'
from unnest(array['a1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']) as suffix;

insert into auth.users (id, aud, role, email, raw_app_meta_data)
select ('d1700000-0000-4000-8000-0000000000' || suffix)::uuid, 'authenticated', 'authenticated',
       'd17-' || suffix || '@example.invalid', '{"user_type":"student"}'
from unnest(array['e1', 'e6']) as suffix;

insert into public.studios (id, owner_id, name)
values ('d1700000-0000-4000-8000-00000000c001', 'd1700000-0000-4000-8000-0000000000a1', 'District');

select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the district subscription is recorded (send_invoice, Academy, active)',
    $q$select pg_temp.webhook_write ('sub_d17_district', 'd1700000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '60 minutes') = 'written'$q$
);

select pg_temp.holds (
    'with a 10-seat override',
    $q$select (public.admin_set_studio_seat_override (
           'd1700000-0000-4000-8000-00000000c001', 10, 'sub_d17_district', 'test', 'Contract #17'
       ) ->> 'effective_seat_limit')::int = 10$q$
);

select pg_temp.act_as_server ();

insert into public.studio_members (studio_id, user_id, created_at)
select 'd1700000-0000-4000-8000-00000000c001', ('d1700000-0000-4000-8000-0000000000b' || i)::uuid,
       now() - interval '1 day' + i * interval '1 minute'
from generate_series(1, 6) as i;

-- D1 is b1's score, shared with b6 as an editor and assigned to e1 with Edit;
-- D6 is b6's own.
insert into public.documents (id, owner_id, title, storage_path)
values
    ('d1700000-0000-4000-8000-0000000000d1', 'd1700000-0000-4000-8000-0000000000b1', 'Shared score',
     'd1700000-0000-4000-8000-0000000000d1/original.pdf'),
    ('d1700000-0000-4000-8000-0000000000d6', 'd1700000-0000-4000-8000-0000000000b6', 'Own score',
     'd1700000-0000-4000-8000-0000000000d6/original.pdf'),
    ('d1700000-0000-4000-8000-0000000000d7', 'd1700000-0000-4000-8000-0000000000b6', 'Score to delete',
     'd1700000-0000-4000-8000-0000000000d7/original.pdf');

-- Their PDFs, as Storage holds them (migration 20261020180700).
insert into storage.objects (bucket_id, name, owner)
values
    ('scores', 'd1700000-0000-4000-8000-0000000000d1/original.pdf', 'd1700000-0000-4000-8000-0000000000b1'),
    ('scores', 'd1700000-0000-4000-8000-0000000000d6/original.pdf', 'd1700000-0000-4000-8000-0000000000b6'),
    ('scores', 'd1700000-0000-4000-8000-0000000000d7/original.pdf', 'd1700000-0000-4000-8000-0000000000b6');

-- As the Storage API marks its own deletes (see cross_branch_integration.sql),
-- so the RLS policies are what decide.
select set_config('storage.allow_delete_query', 'true', true);

insert into public.document_members (document_id, user_id, role)
values
    ('d1700000-0000-4000-8000-0000000000d1', 'd1700000-0000-4000-8000-0000000000b6', 'editor'),
    ('d1700000-0000-4000-8000-0000000000d1', 'd1700000-0000-4000-8000-0000000000e1', 'editor');

insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash)
values
    ('d1700000-0000-4000-8000-0000000005a1', 'd1700000-0000-4000-8000-0000000000b1',
     'd1700000-0000-4000-8000-0000000000e1', 'Student One', 'hash'),
    ('d1700000-0000-4000-8000-0000000005a6', 'd1700000-0000-4000-8000-0000000000b6',
     'd1700000-0000-4000-8000-0000000000e6', 'Student Six', 'hash');

insert into public.assignments (id, document_id, student_user_id, assigned_by, access)
values ('d1700000-0000-4000-8000-0000000005b1', 'd1700000-0000-4000-8000-0000000000d1',
        'd1700000-0000-4000-8000-0000000000e1', 'd1700000-0000-4000-8000-0000000000b1', 'edit');

-- One mark of b6's on each score, made while the seat was active.
insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values
    ('d1700000-0000-4000-8000-000000000a61', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke', '#1f2937',
     '{"pts":[0.1,0.1,0.5,0.2,0.2,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6'),
    ('d1700000-0000-4000-8000-000000000a66', 'd1700000-0000-4000-8000-0000000000d6', 0, 'stroke', '#1f2937',
     '{"pts":[0.1,0.1,0.5,0.2,0.2,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6');

-- ===========================================================================
-- While the seat is active, b6 writes like any editor
-- ===========================================================================
select pg_temp.act_as_user ('d1700000-0000-4000-8000-0000000000b6');

select pg_temp.holds ('b6 is not read-only yet', $q$select not public.caller_seat_read_only ()$q$);

select pg_temp.allowed (
    'b6 marks the shared score',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a62', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6')$q$
);

-- ===========================================================================
-- The grace period runs out on the clock alone
-- ===========================================================================
-- Stand-in for time passing: the subscription is put 31 days past due with
-- every trigger off, so neither the subscription-write reconcile nor the hourly
-- sweep has run -- exactly the window Codex described.
select pg_temp.act_as_server ();

set local session_replication_role = replica;

update public.subscriptions
set status = 'past_due', past_due_since = now() - interval '31 days'
where stripe_subscription_id = 'sub_d17_district';

set local session_replication_role = origin;

select pg_temp.holds (
    'b5 and b6 are now past the limit of 5 (b1..b4 still active seats)',
    $q$select not public.seat_read_only ('d1700000-0000-4000-8000-0000000000b4')
          and public.seat_read_only ('d1700000-0000-4000-8000-0000000000b5')
          and public.seat_read_only ('d1700000-0000-4000-8000-0000000000b6')
          and not public.seat_read_only ('d1700000-0000-4000-8000-0000000000b1')$q$
);

select pg_temp.holds (
    'and nothing has reconciled: b6''s own score is not archived',
    $q$select not public.document_is_archived ('d1700000-0000-4000-8000-0000000000d6')
          and not public.document_is_archived ('d1700000-0000-4000-8000-0000000000d1')$q$
);

-- ===========================================================================
-- b6 can write nothing, on any score, right away
-- ===========================================================================
select pg_temp.act_as_user ('d1700000-0000-4000-8000-0000000000b6');

select pg_temp.holds ('b6 is told they are read-only', $q$select public.caller_seat_read_only ()$q$);

select pg_temp.refused (
    'no new mark on their own (unarchived) score',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a67', 'd1700000-0000-4000-8000-0000000000d6', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6')$q$,
    '42501'
);

select pg_temp.refused (
    'no new mark on the shared score',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a63', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6')$q$,
    '42501'
);

select pg_temp.refused (
    'no change to an existing mark on the shared score',
    $q$update public.annotations set color = '#16a34a' where id = 'd1700000-0000-4000-8000-000000000a61'$q$,
    '42501'
);

select pg_temp.refused (
    'no change to an existing mark on their own score',
    $q$update public.annotations set color = '#16a34a' where id = 'd1700000-0000-4000-8000-000000000a66'$q$,
    '42501'
);

select pg_temp.refused (
    'no tombstone (erase) on the shared score',
    $q$update public.annotations set deleted_at = now() where id = 'd1700000-0000-4000-8000-000000000a62'$q$,
    '42501'
);

select pg_temp.refused (
    'nor through insert_annotations_batch',
    $q$select public.insert_annotations_batch (jsonb_build_array(jsonb_build_object(
           'id', 'd1700000-0000-4000-8000-000000000a64',
           'document_id', 'd1700000-0000-4000-8000-0000000000d1',
           'page', 0, 'kind', 'stroke', 'color', '#2563eb',
           'payload', '{"pts":[0.3,0.3,0.5],"w":0.005}'::jsonb,
           'created_by', 'd1700000-0000-4000-8000-0000000000b6')))$q$,
    '42501'
);

select pg_temp.refused (
    'nor through patch_annotations_batch',
    $q$select public.patch_annotations_batch (jsonb_build_array(jsonb_build_object(
           'id', 'd1700000-0000-4000-8000-000000000a61',
           'document_id', 'd1700000-0000-4000-8000-0000000000d1',
           'color', '#16a34a')))$q$,
    '42501'
);

select pg_temp.refused (
    'no lesson-history snapshot',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, label, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000c61', 'd1700000-0000-4000-8000-0000000000d1', current_date,
               null, '[]', 'd1700000-0000-4000-8000-0000000000b6')$q$,
    '42501'
);

select pg_temp.on_topic ('doc:d1700000-0000-4000-8000-0000000000d1');

select pg_temp.refused (
    'no live ink on doc:{id}',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:d1700000-0000-4000-8000-0000000000d1', 'broadcast', 'ink:progress', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501'
);

select pg_temp.allowed (
    'but still appears in presence there',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:d1700000-0000-4000-8000-0000000000d1', 'presence', 'presence', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$
);

select pg_temp.refused (
    'no renaming their own score',
    $q$update public.documents set title = 'Renamed' where id = 'd1700000-0000-4000-8000-0000000000d6'$q$,
    '42501',
    'this Academy seat is read-only'
);

select pg_temp.refused (
    'no replacing its file',
    $q$update public.documents set content_rev = content_rev + 1 where id = 'd1700000-0000-4000-8000-0000000000d6'$q$,
    '42501'
);

select pg_temp.allowed (
    'the viewer''s page-count backfill (not an edit) still lands',
    $q$update public.documents set page_count = 3 where id = 'd1700000-0000-4000-8000-0000000000d6'$q$
);

select pg_temp.refused (
    'no new share link (invite) to their own score',
    $q$insert into public.share_links (document_id, role, created_by)
       values ('d1700000-0000-4000-8000-0000000000d6', 'editor', 'd1700000-0000-4000-8000-0000000000b6')$q$,
    '42501'
);

select pg_temp.refused (
    'no assigning their score to their own roster student',
    $q$select public.assign_score ('d1700000-0000-4000-8000-0000000000d6', 'd1700000-0000-4000-8000-0000000000e6')$q$,
    '42501',
    'this Academy seat is read-only'
);

select pg_temp.refused (
    'no seat invites (Academy is required, which a read-only seat is not)',
    $q$select public.studio_invite_member ('d1700000-0000-4000-8000-00000000c001', 'd17-a1@example.invalid')$q$,
    '42501'
);

-- Storage (20261020180700): the PDF cannot be replaced, added or removed.
select pg_temp.refused (
    'no replacing their own PDF through Storage (upload with upsert)',
    $q$insert into storage.objects (bucket_id, name, owner, metadata)
       values ('scores', 'd1700000-0000-4000-8000-0000000000d6/original.pdf',
               'd1700000-0000-4000-8000-0000000000b6', '{"size": 2}')
       on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata$q$,
    '42501'
);

select pg_temp.allowed (
    'nor through a plain update: it matches nothing',
    $q$update storage.objects set metadata = '{"size": 3}'
       where bucket_id = 'scores' and name = 'd1700000-0000-4000-8000-0000000000d6/original.pdf'$q$,
    0
);

select pg_temp.refused (
    'no new file in their own score''s folder (an import backup)',
    $q$insert into storage.objects (bucket_id, name, owner)
       values ('scores', 'd1700000-0000-4000-8000-0000000000d6/original.backup.pdf',
               'd1700000-0000-4000-8000-0000000000b6')$q$,
    '42501'
);

select pg_temp.removes (
    'no deleting their own live score''s PDF: it matches nothing',
    'storage.objects',
    $q$bucket_id = 'scores' and name = 'd1700000-0000-4000-8000-0000000000d6/original.pdf'$q$,
    0
);

select pg_temp.holds (
    'but still reads (downloads) it',
    $q$select count(*) = 1 from storage.objects
       where bucket_id = 'scores' and name = 'd1700000-0000-4000-8000-0000000000d6/original.pdf'
         and metadata is null$q$
);

select pg_temp.allowed (
    'and the viewer''s cover backfill (thumbnails, not an edit) still lands',
    $q$insert into storage.objects (bucket_id, name, owner)
       values ('thumbnails', 'd1700000-0000-4000-8000-0000000000d6/1.jpg', 'd1700000-0000-4000-8000-0000000000b6')$q$
);

select pg_temp.removes (
    'removing one''s own things stays allowed: b6 deletes their own score',
    'public.documents',
    $q$id = 'd1700000-0000-4000-8000-0000000000d7'$q$,
    1
);

select pg_temp.removes (
    'and then its PDF, under the storage-cleanup tombstone',
    'storage.objects',
    $q$bucket_id = 'scores' and name = 'd1700000-0000-4000-8000-0000000000d7/original.pdf'$q$,
    1
);

-- View and export are untouched.
select pg_temp.holds (
    'b6 still sees both scores and every mark on them',
    $q$select (select count(*) from public.documents
               where id in ('d1700000-0000-4000-8000-0000000000d1', 'd1700000-0000-4000-8000-0000000000d6')) = 2
          and (select count(*) from public.annotations
               where id in ('d1700000-0000-4000-8000-000000000a61', 'd1700000-0000-4000-8000-000000000a62',
                            'd1700000-0000-4000-8000-000000000a66')) = 3$q$
);

select pg_temp.holds (
    'and exports the shared score, unlimited',
    $q$select (public.claim_pdf_export ('d1700000-0000-4000-8000-0000000000d1') ->> 'ok')::boolean$q$
);

-- ===========================================================================
-- Nobody else is affected
-- ===========================================================================
select pg_temp.act_as_user ('d1700000-0000-4000-8000-0000000000b1');

select pg_temp.allowed (
    'b1, an active seat, still marks their score',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a11', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b1')$q$
);

select pg_temp.allowed (
    'and replaces their PDF through Storage',
    $q$insert into storage.objects (bucket_id, name, owner, metadata)
       values ('scores', 'd1700000-0000-4000-8000-0000000000d1/original.pdf',
               'd1700000-0000-4000-8000-0000000000b1', '{"size": 2}')
       on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata$q$
);

select pg_temp.act_as_student ('d1700000-0000-4000-8000-0000000000e1');

select pg_temp.holds ('b1''s roster student is never a read-only seat', $q$select not public.caller_seat_read_only ()$q$);

select pg_temp.allowed (
    'and keeps Edit on the score assigned to them',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a51', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000e1')$q$
);

-- ===========================================================================
-- Paying again gives b6 everything back at once
-- ===========================================================================
select pg_temp.act_as ('service_role');

select pg_temp.holds (
    'the district pays',
    $q$select pg_temp.webhook_write ('sub_d17_district', 'd1700000-0000-4000-8000-0000000000a1', 'academy',
           'active', now() + interval '1 year', 'send_invoice', now() - interval '50 minutes') = 'written'$q$
);

select pg_temp.act_as_user ('d1700000-0000-4000-8000-0000000000b6');

select pg_temp.holds ('b6 is not read-only any more', $q$select not public.caller_seat_read_only ()$q$);

select pg_temp.allowed (
    'b6 marks the shared score again',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a65', 'd1700000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6')$q$
);

select pg_temp.allowed (
    'and their own score',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('d1700000-0000-4000-8000-000000000a68', 'd1700000-0000-4000-8000-0000000000d6', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'd1700000-0000-4000-8000-0000000000b6')$q$
);

select pg_temp.allowed (
    'and renames it',
    $q$update public.documents set title = 'Renamed' where id = 'd1700000-0000-4000-8000-0000000000d6'$q$
);

select pg_temp.allowed (
    'and replaces its PDF through Storage again',
    $q$insert into storage.objects (bucket_id, name, owner, metadata)
       values ('scores', 'd1700000-0000-4000-8000-0000000000d6/original.pdf',
               'd1700000-0000-4000-8000-0000000000b6', '{"size": 4}')
       on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata$q$
);

-- ===========================================================================
-- Nobody asks about anyone else
-- ===========================================================================
select pg_temp.refused (
    'a signed-in user cannot ask whether another user is read-only',
    $q$select public.seat_read_only ('d1700000-0000-4000-8000-0000000000b5')$q$,
    '42501'
);

select pg_temp.act_as ('anon');

select pg_temp.refused (
    'nor can anon ask about itself',
    $q$select public.caller_seat_read_only ()$q$,
    '42501'
);

select pg_temp.act_as_server ();

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
