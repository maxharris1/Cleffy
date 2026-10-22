-- Behaviour proof for 20261022110100_account_deletion_pending.sql: while an
-- account's deletion is pending, nothing can add a score or a roster row to it,
-- whoever inserts; the marker is cleared when an attempt deleted nothing, kept
-- (with its error) when one stopped part-way, and cascades away with the auth
-- user when the deletion completes.
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/launch_checkout_fixes.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/account_deletion_pending.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('de1e0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.ran(p_name text, p_sql text) returns void language plpgsql as $f$
begin execute p_sql; insert into t_results values (p_name, true, null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
create function pg_temp.refused(p_name text, p_sql text, p_state text) returns void language plpgsql as $f$
declare v_state text; v_message text;
begin
execute p_sql;
insert into t_results values (p_name, false, 'no error raised');
exception when others then
get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
insert into t_results values (p_name, v_state = p_state, v_state || ' ' || v_message);
end $f$;
create function pg_temp.as_service() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
perform set_config('role', 'service_role', true);
end $f$;
create function pg_temp.as_user(n int) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(n), 'role', 'authenticated')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
-- A score row for `owner`, as an upload or an import writes it.
create function pg_temp.doc_sql(p_id int, p_owner int) returns text language sql as $f$
select format(
    $s$insert into public.documents (id, owner_id, title, storage_path) values (%L, %L, 'Deletion proof', %L)$s$,
    pg_temp.u(p_id), pg_temp.u(p_owner), pg_temp.u(p_id) || '/original.pdf')
$f$;
-- A roster row for `teacher`, as student-provision writes it.
create function pg_temp.student_sql(p_id int, p_teacher int, p_user int) returns text language sql as $f$
select format(
    $s$insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
       values (%L, %L, %L, 'Pending', 'hash-' || %L, 'code')$s$,
    pg_temp.u(p_id), pg_temp.u(p_teacher), pg_temp.u(p_user), p_id)
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): a teacher being deleted, a bystander, two students.
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values (pg_temp.u(1), 'authenticated', 'authenticated', 'deleting-teacher@example.invalid'),
       (pg_temp.u(2), 'authenticated', 'authenticated', 'bystander@example.invalid');
insert into auth.users (id, aud, role, email, raw_app_meta_data)
values (pg_temp.u(11), 'authenticated', 'authenticated', 'st-pending-11@students.cleffy.app', '{"user_type":"student"}'),
       (pg_temp.u(12), 'authenticated', 'authenticated', 'st-pending-12@students.cleffy.app', '{"user_type":"student"}'),
       (pg_temp.u(13), 'authenticated', 'authenticated', 'st-pending-13@students.cleffy.app', '{"user_type":"student"}');

select pg_temp.as_service();

-- ===========================================================================
-- 1. Before the deletion: nothing is refused
-- ===========================================================================
select pg_temp.ran('01 a score can be added to an account that is not being deleted', pg_temp.doc_sql(101, 1));
select pg_temp.ran('02 ... and so can a roster row', pg_temp.student_sql(201, 1, 11));

-- ===========================================================================
-- 2. The marker, and what it refuses
-- ===========================================================================
select pg_temp.chk('10 beginning the deletion writes the marker (first attempt)',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 1$q$);
select pg_temp.chk('11 ... while holding the account''s lock exclusively until it commits',
$q$select exists (select 1 from pg_locks where locktype = 'advisory' and mode = 'ExclusiveLock' and granted
    and pid = pg_backend_pid()
    and ((classid::bigint << 32) | objid::bigint) = public.account_deletion_lock_key (pg_temp.u(1)))$q$);
select pg_temp.refused('12 a new score for that account is refused (service role: an import)',
pg_temp.doc_sql(102, 1), '55000');
select pg_temp.refused('13 ... and so is a new roster row (student-provision mid-delete)',
pg_temp.student_sql(202, 1, 12), '55000');
select pg_temp.as_user(1);
select pg_temp.refused('14 ... and a score from the owner''s own tab', pg_temp.doc_sql(103, 1), '55000');
select pg_temp.as_service();
select pg_temp.ran('15 another account is not affected', pg_temp.doc_sql(104, 2));
select pg_temp.ran('16 an insert takes the shared lock (so a deletion starting now waits for it)',
pg_temp.doc_sql(105, 2));
select pg_temp.chk('17 ... visible in pg_locks for the inserting account',
$q$select exists (select 1 from pg_locks where locktype = 'advisory' and mode = 'ShareLock' and granted
    and pid = pg_backend_pid()
    and ((classid::bigint << 32) | objid::bigint) = public.account_deletion_lock_key (pg_temp.u(2)))$q$);
select pg_temp.chk('18 the account''s existing rows can still be changed and swept',
$q$with u as (update public.documents set title = 'Renamed' where id = pg_temp.u(101) returning 1)
   select count(*) = 1 from u$q$);
select pg_temp.chk('19 nothing new was written for the account being deleted',
$q$select (select count(*) from public.documents where owner_id = pg_temp.u(1)) = 1
      and (select count(*) from public.managed_students where teacher_id = pg_temp.u(1)) = 1$q$);

-- ===========================================================================
-- 3. Failure: kept with its error (retry), or cleared (nothing deleted)
-- ===========================================================================
select pg_temp.chk('20 a retry counts its attempt',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 2$q$);
select pg_temp.ran('21 an attempt that stopped part-way is settled as failed',
$q$select public.settle_account_deletion (pg_temp.u(1), 'failed', 'document_delete_failed')$q$);
select pg_temp.chk('22 ... which keeps the marker, with the error',
$q$select attempts = 2 and last_error = 'document_delete_failed' from public.account_deletions where user_id = pg_temp.u(1)$q$);
select pg_temp.refused('23 ... so the half-deleted account still cannot grow', pg_temp.doc_sql(106, 1), '55000');
select pg_temp.ran('24 a retry that then deletes nothing (billing could not be stopped) is abandoned',
$q$select public.settle_account_deletion (pg_temp.u(1), 'abandoned')$q$);
select pg_temp.chk('25 ... but the marker an earlier attempt left stays: the account is half-deleted',
$q$select attempts = 2 and last_error = 'document_delete_failed' from public.account_deletions where user_id = pg_temp.u(1)$q$);
-- A fresh account, one attempt, nothing else running.
reset role;
delete from public.account_deletions where user_id = pg_temp.u(1);
select pg_temp.as_service();
select pg_temp.chk('26a a first attempt begins',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 1$q$);
select pg_temp.chk('26b a second tab begins on the same account',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 2$q$);
select pg_temp.ran('26c the first tab''s billing fails, and it abandons',
$q$select public.settle_account_deletion (pg_temp.u(1), 'abandoned')$q$);
select pg_temp.chk('26d ... which cannot clear the marker the second tab is sweeping under',
$q$select exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);
reset role;
delete from public.account_deletions where user_id = pg_temp.u(1);
select pg_temp.as_service();
select pg_temp.chk('26e a lone first attempt begins',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 1$q$);
select pg_temp.ran('26f ... deletes nothing (billing could not be stopped) and abandons',
$q$select public.settle_account_deletion (pg_temp.u(1), 'abandoned')$q$);
select pg_temp.chk('26g ... which clears the marker',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.ran('26h ... and the account works as before', pg_temp.student_sql(203, 1, 13));
select pg_temp.refused('27 an unknown outcome is refused',
$q$select public.settle_account_deletion (pg_temp.u(1), 'whatever')$q$, '22023');

-- ===========================================================================
-- 4. Completion: the marker goes with the auth user
-- ===========================================================================
select pg_temp.chk('30 a final attempt begins',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 1$q$);
reset role;
delete from auth.users where id = pg_temp.u(1);
select pg_temp.chk('31 deleting the auth user cascades the marker away',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.as_service();
select pg_temp.chk('32 a retry for an account already gone has nothing to guard: 0, and no marker',
$q$select public.begin_account_deletion (pg_temp.u(1)) = 0$q$);
select pg_temp.chk('33 ... none written',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);

-- ===========================================================================
-- 5. Service role only
-- ===========================================================================
select pg_temp.as_user(2);
select pg_temp.refused('40 a signed-in client cannot begin a deletion marker',
$q$select public.begin_account_deletion (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('41 ... or settle one', $q$select public.settle_account_deletion (pg_temp.u(2), 'abandoned')$q$, '42501');
select pg_temp.refused('42 ... or read the markers', $q$select count(*) from public.account_deletions$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('43 anon cannot begin one', $q$select public.begin_account_deletion (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('44 ... or read them', $q$select count(*) from public.account_deletions$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
