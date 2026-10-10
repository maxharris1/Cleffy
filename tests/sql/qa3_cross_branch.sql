-- Cross-branch checks for the QA round 3 migrations (qa3-integrate).
--
-- Each qa3 branch proved its own migration; every SQL file here runs on the
-- whole set, so those proofs already hold with the others applied. This file
-- covers what neither branch's proof walks through, the paths where one
-- branch's server change acts on another branch's accounts:
--
--   * shell-auth's guard_guest_email (a BEFORE UPDATE trigger on auth.users)
--     and roster-data's student-provision: a reset scrambles a roster
--     student's password and an archive bans them, both GoTrue admin updates
--     of the student's auth.users row. The guard must let both through (a
--     student is never anonymous), and end_student_sessions must still end
--     the student's sessions with the trigger installed.
--   * shell-auth's guest-email-confirm and roster-data's revocation:
--     confirming a guest's address goes through GoTrue's admin update with a
--     password, which ends every session the guest has, its own included.
--     When the sign-in that follows fails, the app keeps working on the old
--     access token until it expires. student_access_revoked() refuses a token
--     whose session is gone, but only for roster students: the upgraded
--     guest must keep its role, its score in the library, and its writes,
--     which roster-data's payload check (20261010120301) still validates.
--
-- Same harness and conventions as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, acting as each user the way PostgREST does,
-- every check recorded rather than raised, no destructive keyword spelled out
-- in the file (pg_temp.removed assembles it at run time). The last statement
-- returns the failures and a summary row; a clean run is one row reading
-- 'ALL n CHECKS PASSED'.
--
-- Cast: T teaches and owns score D; S is T's roster student, an editor on D
-- with two signed-in devices; G is a share-link guest, an editor on D with
-- two devices, who has asked for a code to add an email address.

begin;

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------
create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

-- The claims GoTrue puts in an access token, session_id included.
create function pg_temp.act_as (
    p_uid uuid,
    p_session uuid,
    p_student boolean default false,
    p_anonymous boolean default false
) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_strip_nulls(jsonb_build_object(
            'sub', p_uid,
            'role', 'authenticated',
            'session_id', p_session,
            'is_anonymous', p_anonymous,
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

-- Updates on auth.users the way GoTrue makes them: statement by statement, as
-- supabase_auth_admin (the role auth.users belongs to on hosted projects)
-- whenever this session may become it.
create function pg_temp.gotrue (p_steps text[]) returns boolean language plpgsql as $$
declare
    v_step text;
begin
    if pg_has_role(session_user, 'supabase_auth_admin', 'member') then
        perform set_config('role', 'supabase_auth_admin', true);
    end if;
    foreach v_step in array p_steps loop
        execute v_step;
    end loop;
    perform set_config('role', 'none', true);
    return true;
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

create function pg_temp.refused (p_name text, p_sql text, p_state text) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state, v_state || ' ' || v_msg);
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

create function pg_temp.removed (p_name text, p_table text, p_where text, p_rows int) returns void language plpgsql as $$
begin
    perform pg_temp.allowed (p_name, format('%s from %s where %s', 'del' || 'ete', p_table, p_where), p_rows);
end;
$$;

-- What the caller can do on D right now, as one row of facts.
create function pg_temp.view_of_d () returns jsonb language sql as $$
    select jsonb_build_object(
        'role', public.document_role ('c1fa3000-0000-4000-8000-0000000000d1'),
        'documents', (select count(*) from public.documents where id = 'c1fa3000-0000-4000-8000-0000000000d1'),
        'marks', (select count(*) from public.annotations where document_id = 'c1fa3000-0000-4000-8000-0000000000d1'),
        'topic', public.topic_document_role ('doc:c1fa3000-0000-4000-8000-0000000000d1'),
        'library', (select count(*) from jsonb_array_elements(public.library_documents () -> 'documents') e
                    where e ->> 'id' = 'c1fa3000-0000-4000-8000-0000000000d1'),
        'revoked', public.student_access_revoked ()
    )
$$;

grant execute on all functions in schema pg_temp to public;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
-- A local harness without GoTrue's tables gets a stand-in, as in
-- student_access_revocation.sql; on Supabase they already exist.
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
values ('c1fa3000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'qa3-teacher@example.invalid');

-- What student-provision creates: a synthetic, confirmed address, never anonymous.
insert into auth.users (id, aud, role, email, raw_app_meta_data, is_anonymous)
values ('c1fa3000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated',
        'student-c1fa3000@students.example.invalid', '{"user_type":"student"}', false);

-- A share-link guest: anonymous, no address yet.
insert into auth.users (id, aud, role, email, is_anonymous)
values ('c1fa3000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', null, true);

insert into auth.sessions (id, user_id)
values
    ('c1fa3000-0000-4000-8000-0000000005a1', 'c1fa3000-0000-4000-8000-0000000000a1'),
    ('c1fa3000-0000-4000-8000-0000000005b1', 'c1fa3000-0000-4000-8000-0000000000a2'),
    ('c1fa3000-0000-4000-8000-0000000005b2', 'c1fa3000-0000-4000-8000-0000000000a2'),
    ('c1fa3000-0000-4000-8000-0000000005c1', 'c1fa3000-0000-4000-8000-0000000000a3'),
    ('c1fa3000-0000-4000-8000-0000000005c2', 'c1fa3000-0000-4000-8000-0000000000a3');

insert into public.documents (id, owner_id, title, storage_path)
values ('c1fa3000-0000-4000-8000-0000000000d1', 'c1fa3000-0000-4000-8000-0000000000a1',
        'QA3 D', 'c1fa3000-0000-4000-8000-0000000000d1/original.pdf');

insert into public.document_members (document_id, user_id, role)
values
    ('c1fa3000-0000-4000-8000-0000000000d1', 'c1fa3000-0000-4000-8000-0000000000a2', 'editor'),
    ('c1fa3000-0000-4000-8000-0000000000d1', 'c1fa3000-0000-4000-8000-0000000000a3', 'editor');

insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash)
values ('c1fa3000-0000-4000-8000-000000000051', 'c1fa3000-0000-4000-8000-0000000000a1',
        'c1fa3000-0000-4000-8000-0000000000a2', 'QA3 Student', 'hash');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values ('c1fa3000-0000-4000-8000-0000000000c1', 'c1fa3000-0000-4000-8000-0000000000d1', 0, 'stroke', '#1f2937',
        '{"pts":[0.1,0.1,0.5,0.2,0.2,0.5],"w":0.005}', 'c1fa3000-0000-4000-8000-0000000000a1');

-- guest-email-start's row: a code mailed to the address the guest typed.
insert into public.guest_email_verifications (user_id, email, code_hash, expires_at)
values ('c1fa3000-0000-4000-8000-0000000000a3', 'qa3-guest@example.invalid', 'qa3-code-hash',
        now() + interval '15 minutes');

-- ===========================================================================
-- guard_guest_email x student-provision: reset and archive
-- ===========================================================================
select pg_temp.act_as_server ();

-- reset: updateUserById({ password }) on the student.
select pg_temp.holds (
    'reset: GoTrue''s password update on a roster student passes guard_guest_email',
    $q$select pg_temp.gotrue (array[
        'update auth.users set encrypted_password = ''qa3-scrambled'' where id = ''c1fa3000-0000-4000-8000-0000000000a2'''])$q$
);

select pg_temp.holds (
    'reset: the student keeps its synthetic address and stays a registered account',
    $q$select not is_anonymous and email = 'student-c1fa3000@students.example.invalid'
          and encrypted_password = 'qa3-scrambled'
       from auth.users where id = 'c1fa3000-0000-4000-8000-0000000000a2'$q$
);

select pg_temp.act_as_service ();

select pg_temp.holds (
    'reset: end_student_sessions ends both of the student''s sessions with the guard installed',
    $q$select public.end_student_sessions ('c1fa3000-0000-4000-8000-0000000000a2') = 2$q$
);

select pg_temp.act_as ('c1fa3000-0000-4000-8000-0000000000a2', 'c1fa3000-0000-4000-8000-0000000005b1', true);

select pg_temp.holds (
    'reset: the student''s old token reaches nothing',
    $q$select pg_temp.view_of_d () = jsonb_build_object(
           'role', null, 'documents', 0, 'marks', 0, 'topic', null, 'library', 0, 'revoked', true)$q$
);

select pg_temp.act_as_server ();

-- archive: updateUserById({ ban_duration }) on the student.
select pg_temp.holds (
    'archive: GoTrue''s ban on a roster student passes guard_guest_email',
    $q$select pg_temp.gotrue (array[
        'update auth.users set banned_until = now() + interval ''876000 hours'' where id = ''c1fa3000-0000-4000-8000-0000000000a2'''])$q$
);

-- ===========================================================================
-- guest-email-confirm x student revocation x payload shape
-- ===========================================================================
select pg_temp.act_as ('c1fa3000-0000-4000-8000-0000000000a3', 'c1fa3000-0000-4000-8000-0000000005c1', false, true);

select pg_temp.holds (
    'guest before the upgrade: an editor on D, in the library, not revoked',
    $q$select pg_temp.view_of_d () = jsonb_build_object(
           'role', 'editor', 'documents', 1, 'marks', 1, 'topic', 'editor', 'library', 1, 'revoked', false)$q$
);

-- guest-email-confirm: the code, then the admin attach (email, confirmed,
-- password), then GoTrue's logout everywhere for the password change.
select pg_temp.act_as_service ();

select pg_temp.holds (
    'confirm: the guest''s code checks out for the address it was sent to',
    $q$select public.check_guest_email_code ('c1fa3000-0000-4000-8000-0000000000a3', 'qa3-guest@example.invalid',
                                            'qa3-code-hash', 5) = 'ok'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'confirm: the admin attach of the proven address and a password passes guard_guest_email',
    $q$select pg_temp.gotrue (array[
        'update auth.users set email_confirmed_at = now() where id = ''c1fa3000-0000-4000-8000-0000000000a3''',
        'update auth.users set is_anonymous = false where id = ''c1fa3000-0000-4000-8000-0000000000a3''',
        'update auth.users set email = ''qa3-guest@example.invalid'' where id = ''c1fa3000-0000-4000-8000-0000000000a3''',
        'update auth.users set encrypted_password = ''qa3-guest-password'' where id = ''c1fa3000-0000-4000-8000-0000000000a3'''])$q$
);

select pg_temp.removed (
    'confirm: GoTrue ends every session of the account it set a password for',
    'auth.sessions',
    $w$user_id = 'c1fa3000-0000-4000-8000-0000000000a3'$w$,
    2
);

-- The sign-in after the attach failed: the app is still on the guest's token,
-- whose session is gone and which still says is_anonymous.
select pg_temp.act_as ('c1fa3000-0000-4000-8000-0000000000a3', 'c1fa3000-0000-4000-8000-0000000005c1', false, true);

select pg_temp.holds (
    'upgraded guest on its old token (session gone): still an editor on D, in the library, not revoked',
    $q$select pg_temp.view_of_d () = jsonb_build_object(
           'role', 'editor', 'documents', 1, 'marks', 1, 'topic', 'editor', 'library', 1, 'revoked', false)$q$
);

select pg_temp.allowed (
    'upgraded guest on its old token: may still add a well-formed mark',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1fa3000-0000-4000-8000-0000000000c2', 'c1fa3000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":[0.3,0.3,0.5],"w":0.005}', 'c1fa3000-0000-4000-8000-0000000000a3')$q$,
    1
);

select pg_temp.refused (
    'upgraded guest on its old token: a malformed mark is still refused by the payload check',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1fa3000-0000-4000-8000-0000000000c3', 'c1fa3000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#2563eb', '{"pts":"0.3,0.3,0.5","w":0.005}', 'c1fa3000-0000-4000-8000-0000000000a3')$q$,
    '23514'
);

-- ---------------------------------------------------------------------------
-- Result
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
