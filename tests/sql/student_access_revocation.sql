-- Archiving or resetting a student ends the sessions they already have open
-- (migrations 20261010120300_student_access_revocation and
-- 20261010120302_library_hides_revoked_student_scores).
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.
--
-- Cast: T teaches and owns score D; S is T's roster student with an edit
-- assignment and two signed-in devices (sessions A and B); O is an ordinary
-- share-link editor on D (not a student, so none of this may touch them).
--
-- Each identity carries the claims GoTrue puts in an access token, session_id
-- included. A student's token whose session row is gone is what a device still
-- holding a pre-reset or pre-archive token looks like.

begin;

-- ---------------------------------------------------------------------------
-- Harness (the column_integrity.sql helpers, restated: pg_temp is per file)
-- ---------------------------------------------------------------------------
create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

create temp table integrity_fixtures (k text primary key, v text);

grant all on integrity_results, integrity_fixtures to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as (p_uid uuid, p_session uuid default null, p_student boolean default false)
returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_strip_nulls(jsonb_build_object(
            'sub', p_uid,
            'role', 'authenticated',
            'session_id', p_session,
            'app_metadata', case when p_student then jsonb_build_object('user_type', 'student') end
        ))::text,
        true
    );
end;
$$;

create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default null) returns void language plpgsql as $$
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
    values (
        p_name,
        p_rows is null or v_rows = p_rows,
        v_rows || ' row(s)' || case when p_rows is null then '' else ', expected ' || p_rows end
    );
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_like text default null) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state and (p_like is null or v_msg like p_like), v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
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

-- end_student_sessions' answer, recorded so a later check can read it.
create function pg_temp.end_sessions (p_key text, p_student uuid) returns void language plpgsql as $$
begin
    insert into integrity_fixtures
    values (p_key, public.end_student_sessions (p_student)::text)
    on conflict (k) do update set v = excluded.v;
end;
$$;

-- What S can do on D right now, as one row of facts.
create function pg_temp.student_view () returns jsonb language sql as $$
    select jsonb_build_object(
        'role', public.document_role ('c1ef0000-0000-4000-8000-00000000ad01'),
        'documents', (select count(*) from public.documents where id = 'c1ef0000-0000-4000-8000-00000000ad01'),
        'marks', (select count(*) from public.annotations where document_id = 'c1ef0000-0000-4000-8000-00000000ad01'),
        'assignments', (select count(*) from public.assignments),
        'notes', (select count(*) from public.practice_notes),
        'members', (select count(*) from public.document_members where document_id = 'c1ef0000-0000-4000-8000-00000000ad01'),
        'topic', public.topic_document_role ('doc:c1ef0000-0000-4000-8000-00000000ad01'),
        -- The library RPCs are SECURITY DEFINER and read document_members
        -- themselves (20261010120302), so they are checked on their own.
        'library', (select count(*) from jsonb_array_elements(public.library_documents () -> 'documents') e
                    where e ->> 'id' = 'c1ef0000-0000-4000-8000-00000000ad01'),
        'bootstrap', (select count(*) from jsonb_array_elements(public.library_bootstrap () -> 'documents') e
                      where e ->> 'id' = 'c1ef0000-0000-4000-8000-00000000ad01'),
        'revoked', public.student_access_revoked ()
    )
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
-- A local harness without GoTrue's tables gets a stand-in; on Supabase they
-- already exist (where refresh_tokens.session_id cascades from its session).
do $$
begin
    if to_regclass('auth.sessions') is null then
        create table auth.sessions (
            id uuid primary key,
            user_id uuid not null references auth.users (id)
        );
    end if;
    if to_regclass('auth.refresh_tokens') is null then
        create table auth.refresh_tokens (
            id bigserial primary key,
            token varchar(255),
            user_id varchar(255),
            session_id uuid references auth.sessions (id)
        );
    end if;
end;
$$;

insert into auth.users (id, aud, role, email)
values
    ('c1ef0000-0000-4000-8000-00000000a7e1', 'authenticated', 'authenticated', 'revoke-teacher@example.invalid'),
    ('c1ef0000-0000-4000-8000-00000000a7e3', 'authenticated', 'authenticated', 'revoke-editor@example.invalid');

insert into auth.users (id, aud, role, email, raw_app_meta_data)
values
    ('c1ef0000-0000-4000-8000-00000000a7e2', 'authenticated', 'authenticated', 'revoke-student@example.invalid',
     '{"user_type":"student"}'),
    -- A student account whose roster row is gone (deleted with their teacher).
    ('c1ef0000-0000-4000-8000-00000000a7e4', 'authenticated', 'authenticated', 'revoke-orphan@example.invalid',
     '{"user_type":"student"}');

insert into auth.sessions (id, user_id)
values
    ('c1ef0000-0000-4000-8000-00000000a5a1', 'c1ef0000-0000-4000-8000-00000000a7e2'),
    ('c1ef0000-0000-4000-8000-00000000a5b2', 'c1ef0000-0000-4000-8000-00000000a7e2'),
    ('c1ef0000-0000-4000-8000-00000000a5e1', 'c1ef0000-0000-4000-8000-00000000a7e1'),
    ('c1ef0000-0000-4000-8000-00000000a5e3', 'c1ef0000-0000-4000-8000-00000000a7e3');

insert into auth.refresh_tokens (token, user_id, session_id)
values
    ('revoke-rt-a', 'c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5a1'),
    ('revoke-rt-b', 'c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5b2'),
    -- From before sessions existed: no session to cascade from.
    ('revoke-rt-legacy', 'c1ef0000-0000-4000-8000-00000000a7e2', null),
    ('revoke-rt-teacher', 'c1ef0000-0000-4000-8000-00000000a7e1', 'c1ef0000-0000-4000-8000-00000000a5e1');

insert into public.documents (id, owner_id, title, storage_path)
values ('c1ef0000-0000-4000-8000-00000000ad01', 'c1ef0000-0000-4000-8000-00000000a7e1',
        'Revoke D', 'c1ef0000-0000-4000-8000-00000000ad01/original.pdf');

insert into public.document_members (document_id, user_id, role)
values
    ('c1ef0000-0000-4000-8000-00000000ad01', 'c1ef0000-0000-4000-8000-00000000a7e2', 'editor'),
    ('c1ef0000-0000-4000-8000-00000000ad01', 'c1ef0000-0000-4000-8000-00000000a7e3', 'editor');

insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash)
values ('c1ef0000-0000-4000-8000-00000000a501', 'c1ef0000-0000-4000-8000-00000000a7e1',
        'c1ef0000-0000-4000-8000-00000000a7e2', 'Revoke Student', 'hash');

insert into public.assignments (id, document_id, student_user_id, assigned_by, access)
values ('c1ef0000-0000-4000-8000-00000000a551', 'c1ef0000-0000-4000-8000-00000000ad01',
        'c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a7e1', 'edit');

insert into public.practice_notes (id, document_id, student_user_id, author_id, body, shared)
values ('c1ef0000-0000-4000-8000-00000000a561', 'c1ef0000-0000-4000-8000-00000000ad01',
        'c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a7e1', 'Bars 1-8', true);

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values ('c1ef0000-0000-4000-8000-00000000a5c1', 'c1ef0000-0000-4000-8000-00000000ad01', 0, 'stroke', '#1f2937',
        '{"pts":[0.1,0.1,0.5,0.2,0.2,0.5],"w":0.005,"sp":1}', 'c1ef0000-0000-4000-8000-00000000a7e1');

insert into integrity_fixtures
select 'live_partition', exists (
    select 1 from pg_class
    where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD')
)::text;

-- ===========================================================================
-- Before anything happens: a signed-in student is an ordinary editor
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5a1', true);

select pg_temp.holds (
    'live student: editor, sees the score, marks, assignment, shared note, channel and library entry',
    $q$select pg_temp.student_view () = jsonb_build_object(
           'role', 'editor', 'documents', 1, 'marks', 1, 'assignments', 1, 'notes', 1,
           'members', 3, 'topic', 'editor', 'library', 1, 'bootstrap', 1, 'revoked', false)$q$
);

select pg_temp.allowed (
    'live student: may add a mark',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-00000000a5c2', 'c1ef0000-0000-4000-8000-00000000ad01', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000a7e2')$q$,
    1
);

-- A token naming no session (not something GoTrue issues) cannot be matched to
-- a sign-in, so it is not one.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', null, true);

select pg_temp.holds (
    'student token with no session_id: refused',
    $q$select public.document_role ('c1ef0000-0000-4000-8000-00000000ad01') is null
          and public.student_access_revoked ()$q$
);

-- Not students: the session is never consulted, with or without one.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e3');

select pg_temp.holds (
    'ordinary editor (no session_id claim at all): unaffected',
    $q$select public.document_role ('c1ef0000-0000-4000-8000-00000000ad01') = 'editor'
          and not public.student_access_revoked ()$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e1', 'c1ef0000-0000-4000-8000-00000000a5ff');

select pg_temp.holds (
    'teacher whose session row is missing: still the owner',
    $q$select public.document_role ('c1ef0000-0000-4000-8000-00000000ad01') = 'owner'
          and not public.student_access_revoked ()$q$
);

-- ===========================================================================
-- end_student_sessions: who may call it
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e1', 'c1ef0000-0000-4000-8000-00000000a5e1');

select pg_temp.refused (
    'end_student_sessions: a teacher (authenticated) has no execute grant',
    $q$select public.end_student_sessions ('c1ef0000-0000-4000-8000-00000000a7e2')$q$,
    '42501'
);

select pg_temp.act_as_service ();

select pg_temp.refused (
    'end_student_sessions: refuses an account that is not a roster student',
    $q$select public.end_student_sessions ('c1ef0000-0000-4000-8000-00000000a7e1')$q$,
    'P0002'
);

select pg_temp.act_as_server ();

select pg_temp.refused (
    'end_student_sessions: refuses a caller without the service role claim',
    $q$select public.end_student_sessions ('c1ef0000-0000-4000-8000-00000000a7e2')$q$,
    '42501'
);

-- ===========================================================================
-- Reset: student-provision ends every session the student has
-- ===========================================================================
select pg_temp.act_as_service ();

select pg_temp.allowed (
    'reset: the service role ends the student''s sessions',
    $q$select pg_temp.end_sessions ('ended', 'c1ef0000-0000-4000-8000-00000000a7e2')$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'reset: both sessions ended, and reported',
    $q$select (select v from integrity_fixtures where k = 'ended') = '2'
          and not exists (select 1 from auth.sessions where user_id = 'c1ef0000-0000-4000-8000-00000000a7e2')$q$
);

select pg_temp.holds (
    'reset: every refresh token gone, the session-less legacy one included',
    $q$select not exists (
           select 1 from auth.refresh_tokens where user_id = 'c1ef0000-0000-4000-8000-00000000a7e2'
       )$q$
);

select pg_temp.holds (
    'reset: the teacher''s own sessions and tokens untouched',
    $q$select exists (select 1 from auth.sessions where id = 'c1ef0000-0000-4000-8000-00000000a5e1')
          and exists (select 1 from auth.refresh_tokens where token = 'revoke-rt-teacher')$q$
);

select pg_temp.holds (
    'reset: open viewers get the membership hint for the student on doc:{id}',
    $q$select exists (
           select 1 from realtime.messages
           where topic = 'doc:c1ef0000-0000-4000-8000-00000000ad01'
             and event = 'membership'
             and private
             and payload ->> 'table' = 'document_members'
             and payload ->> 'document_id' = 'c1ef0000-0000-4000-8000-00000000ad01'
             and payload ->> 'user_id' = 'c1ef0000-0000-4000-8000-00000000a7e2'
             and payload -> 'role' = 'null'::jsonb
       ) or not (select v from integrity_fixtures where k = 'live_partition')::boolean
         and to_regclass('realtime.messages') is not null
         and pg_get_functiondef('public.end_student_sessions'::regproc) like '%''membership''%'$q$
);

-- The device that was signed in before the reset still holds a valid JWT.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5a1', true);

select pg_temp.holds (
    'reset: the pre-reset token sees nothing: no role, score, marks, assignment, note, channel or library entry',
    $q$select pg_temp.student_view () = jsonb_build_object(
           'role', null, 'documents', 0, 'marks', 0, 'assignments', 0, 'notes', 0,
           'members', 0, 'topic', null, 'library', 0, 'bootstrap', 0, 'revoked', true)$q$
);

select pg_temp.refused (
    'reset: the pre-reset token cannot add a mark',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-00000000a5c3', 'c1ef0000-0000-4000-8000-00000000ad01', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000a7e2')$q$,
    '42501'
);

select pg_temp.allowed (
    'reset: ... nor change one (no row matches)',
    $q$update public.annotations set color = '#dc2626'
       where id = 'c1ef0000-0000-4000-8000-00000000a5c1'$q$,
    0
);

select pg_temp.allowed (
    'reset: ... nor erase one through patch_annotations_batch (no row matches)',
    $q$select public.patch_annotations_batch (jsonb_build_array(jsonb_build_object(
           'id', 'c1ef0000-0000-4000-8000-00000000a5c1',
           'document_id', 'c1ef0000-0000-4000-8000-00000000ad01',
           'deleted_at', now())))$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'reset: the teacher''s mark is still live',
    $q$select deleted_at is null and color = '#1f2937'
       from public.annotations where id = 'c1ef0000-0000-4000-8000-00000000a5c1'$q$
);

-- The student signs in again (claims the new code): a new session.
insert into auth.sessions (id, user_id)
values ('c1ef0000-0000-4000-8000-00000000a5c3', 'c1ef0000-0000-4000-8000-00000000a7e2');

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5c3', true);

select pg_temp.holds (
    'reset: a fresh sign-in has everything back',
    $q$select pg_temp.student_view () = jsonb_build_object(
           'role', 'editor', 'documents', 1, 'marks', 2, 'assignments', 1, 'notes', 1,
           'members', 3, 'topic', 'editor', 'library', 1, 'bootstrap', 1, 'revoked', false)$q$
);

-- ===========================================================================
-- Archive: the stamp alone cuts a live session, before its sessions end
-- ===========================================================================
select pg_temp.act_as_service ();

select pg_temp.allowed (
    'archive: student-provision stamps the roster row',
    $q$update public.managed_students set archived_at = now()
       where id = 'c1ef0000-0000-4000-8000-00000000a501'$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5c3', true);

select pg_temp.holds (
    'archive: the still-signed-in student sees nothing on the very next request',
    $q$select pg_temp.student_view () = jsonb_build_object(
           'role', null, 'documents', 0, 'marks', 0, 'assignments', 0, 'notes', 0,
           'members', 0, 'topic', null, 'library', 0, 'bootstrap', 0, 'revoked', true)$q$
);

select pg_temp.refused (
    'archive: ... and cannot add a mark',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-00000000a5c4', 'c1ef0000-0000-4000-8000-00000000ad01', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000a7e2')$q$,
    '42501'
);

select pg_temp.refused (
    'archive: ... nor through insert_annotations_batch',
    $q$select public.insert_annotations_batch (jsonb_build_array(jsonb_build_object(
           'id', 'c1ef0000-0000-4000-8000-00000000a5c5',
           'document_id', 'c1ef0000-0000-4000-8000-00000000ad01',
           'page', 0, 'kind', 'stroke', 'color', '#2563eb',
           'payload', '{"pts":[0.3,0.3,0.5],"w":0.005}'::jsonb,
           'created_by', 'c1ef0000-0000-4000-8000-00000000a7e2')))$q$,
    '42501'
);

select pg_temp.holds (
    'archive: the student can still read their own roster row, archived (how the app knows to sign out)',
    $q$select archived_at is not null from public.managed_students
       where student_user_id = 'c1ef0000-0000-4000-8000-00000000a7e2'$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e1', 'c1ef0000-0000-4000-8000-00000000a5e1');

select pg_temp.holds (
    'archive: the teacher still sees the assignment, the note and every mark',
    $q$select (select count(*) from public.assignments) = 1
          and (select count(*) from public.practice_notes) = 1
          and (select count(*) from public.annotations
               where document_id = 'c1ef0000-0000-4000-8000-00000000ad01') = 2$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e3');

select pg_temp.holds (
    'archive: the other editor is untouched',
    $q$select public.document_role ('c1ef0000-0000-4000-8000-00000000ad01') = 'editor'$q$
);

-- Restore lifts it again (the student signs back in; the row is unstamped).
select pg_temp.act_as_service ();

select pg_temp.allowed (
    'restore: student-provision clears the stamp',
    $q$update public.managed_students set archived_at = null
       where id = 'c1ef0000-0000-4000-8000-00000000a501'$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e2', 'c1ef0000-0000-4000-8000-00000000a5c3', true);

select pg_temp.holds (
    'restore: access comes back',
    $q$select public.document_role ('c1ef0000-0000-4000-8000-00000000ad01') = 'editor'
          and not public.student_access_revoked ()$q$
);

-- ===========================================================================
-- A student whose roster row is gone reads as revoked
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000a7e4', 'c1ef0000-0000-4000-8000-00000000a5a1', true);

select pg_temp.holds (
    'orphaned student token: student_access_revoked() says so',
    $q$select public.student_access_revoked ()$q$
);

-- ===========================================================================
-- Grants and definer hygiene
-- ===========================================================================
select pg_temp.act_as_server ();

select pg_temp.holds (
    'grants: end_student_sessions is the service role''s alone',
    $q$select has_function_privilege('service_role', 'public.end_student_sessions(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.end_student_sessions(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.end_student_sessions(uuid)', 'execute')$q$
);

select pg_temp.holds (
    'grants: student_access_revoked is for signed-in callers, not anon',
    $q$select has_function_privilege('authenticated', 'public.student_access_revoked()', 'execute')
          and not has_function_privilege('anon', 'public.student_access_revoked()', 'execute')$q$
);

select pg_temp.holds (
    'definer functions pin search_path',
    $q$select bool_and(p.prosecdef and exists (
           select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
       from pg_proc p
       where p.oid in ('public.end_student_sessions'::regproc, 'public.student_access_revoked'::regproc,
                       'public.document_role'::regproc)$q$
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select pg_temp.act_as_server ();

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
