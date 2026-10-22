-- Behaviour proof for 20261022110100_account_deletion_pending.sql and
-- 20261022110400_account_deletion_attempts.sql: while an account's deletion is
-- pending, nothing can add a score or a roster row to it, whoever inserts. An
-- account is pending while an attempt is active (not ended, lease not run out)
-- or once destructive cleanup began. So two attempts that both abandon clear
-- it, a crashed attempt stops restricting when its lease runs out, and an
-- attempt that crashed after it started deleting keeps it (the runbook case)
-- until a retry completes and the marker cascades away with the auth user.
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
create temp table t_attempts (label text primary key, attempt uuid);
grant all on t_attempts to anon, authenticated, service_role;
-- Begin a deletion attempt for `user`, remembered under `label`.
create function pg_temp.begin(p_label text, p_user int) returns uuid language plpgsql as $f$
declare v uuid;
begin
v := public.begin_account_deletion_attempt (pg_temp.u(p_user));
insert into t_attempts values (p_label, v) on conflict (label) do update set attempt = excluded.attempt;
return v;
end $f$;
create function pg_temp.att(p_label text) returns uuid language sql as $f$ select attempt from t_attempts where label = p_label $f$;
-- A crash: the attempt never settles, and its lease runs out.
create function pg_temp.crash(p_label text) returns void language sql as $f$
update public.account_deletion_attempts set lease_until = now() - interval '1 second' where attempt = pg_temp.att(p_label)
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
       (pg_temp.u(13), 'authenticated', 'authenticated', 'st-pending-13@students.cleffy.app', '{"user_type":"student"}'),
       (pg_temp.u(14), 'authenticated', 'authenticated', 'st-pending-14@students.cleffy.app', '{"user_type":"student"}'),
       (pg_temp.u(15), 'authenticated', 'authenticated', 'st-pending-15@students.cleffy.app', '{"user_type":"student"}');

select pg_temp.as_service();

-- ===========================================================================
-- 1. Before the deletion: nothing is refused
-- ===========================================================================
select pg_temp.ran('01 a score can be added to an account that is not being deleted', pg_temp.doc_sql(101, 1));
select pg_temp.ran('02 ... and so can a roster row', pg_temp.student_sql(201, 1, 11));

-- ===========================================================================
-- 2. The marker, and what it refuses
-- ===========================================================================
-- One statement sees one snapshot, so each begin is its own statement and
-- the checks after it read what it wrote.
select pg_temp.begin('a1', 1);
select pg_temp.chk('10 beginning the deletion writes the marker and returns the attempt',
$q$select pg_temp.att('a1') is not null
      and (select attempts = 1 and destructive_started_at is null from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.chk('11 ... while holding the account''s lock exclusively until it commits',
$q$select exists (select 1 from pg_locks where locktype = 'advisory' and mode = 'ExclusiveLock' and granted
    and pid = pg_backend_pid()
    and ((classid::bigint << 32) | objid::bigint) = public.account_deletion_lock_key (pg_temp.u(1)))$q$);
select pg_temp.chk('11a ... the attempt is active, under a lease longer than an Edge Function can run',
$q$select ended_at is null and lease_until > now() + interval '400 seconds'
   from public.account_deletion_attempts where attempt = pg_temp.att('a1')$q$);
select pg_temp.chk('11b the account is pending', $q$select public.account_deletion_pending (pg_temp.u(1))$q$);
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
-- 3. Attempts that delete nothing: abandoned, or crashed
-- ===========================================================================
select pg_temp.begin('a2', 1);
select pg_temp.chk('20 a second tab begins on the same account: history counts 2',
$q$select pg_temp.att('a2') <> pg_temp.att('a1')
      and (select attempts = 2 from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.ran('21 the first tab''s billing fails, and it abandons',
$q$select public.settle_account_deletion_attempt (pg_temp.u(1), pg_temp.att('a1'), 'abandoned', 'billing_cancel_failed')$q$);
select pg_temp.chk('22 ... which leaves the marker the second tab is still working under',
$q$select public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.refused('22a ... so the account is still restricted', pg_temp.doc_sql(106, 1), '55000');
select pg_temp.ran('23 the second tab abandons too',
$q$select public.settle_account_deletion_attempt (pg_temp.u(1), pg_temp.att('a2'), 'abandoned', 'billing_unavailable')$q$);
select pg_temp.chk('24 two abandoned attempts clear the marker: no active attempt, nothing was deleted',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))
      and not public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.ran('25 ... and the account works as before', pg_temp.doc_sql(107, 1));
select pg_temp.chk('26 an attempt begins again', $q$select pg_temp.begin('crash', 1) is not null$q$);
select pg_temp.refused('26a ... and restricts the account while it runs', pg_temp.student_sql(203, 1, 13), '55000');
select pg_temp.crash('crash');
select pg_temp.chk('27 it crashes before deleting anything: once its lease runs out it restricts nothing',
$q$select not public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.ran('27a ... with no settle and no sweep: the account works again', pg_temp.student_sql(204, 1, 13));
select pg_temp.begin('after-crash', 1);
select pg_temp.chk('27b the row stays as history, and the next attempt reuses it',
$q$select pg_temp.att('after-crash') is not null
      and (select attempts = 2 from public.account_deletions where user_id = pg_temp.u(1))
      and public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.ran('27c ... which abandons, and clears it',
$q$select public.settle_account_deletion_attempt (pg_temp.u(1), pg_temp.att('after-crash'), 'abandoned', 'billing_cancel_failed')$q$);
select pg_temp.chk('27d ... the crashed attempt does not hold the marker in place',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.refused('28 an unknown outcome is refused',
$q$select public.settle_account_deletion_attempt (pg_temp.u(1), gen_random_uuid(), 'whatever')$q$, '22023');

-- ===========================================================================
-- 4. Destructive cleanup began: the restriction stays until it completes
-- ===========================================================================
select pg_temp.begin('d1', 1);
select pg_temp.chk('30 an attempt begins and records that it is about to delete',
$q$select public.mark_account_deletion_destructive (pg_temp.u(1), pg_temp.att('d1'))$q$);
select pg_temp.chk('30a ... destructive_started_at is set',
$q$select destructive_started_at is not null from public.account_deletions where user_id = pg_temp.u(1)$q$);
select pg_temp.crash('d1');
select pg_temp.chk('31 it crashes part-way: with its lease run out, the account is STILL pending',
$q$select public.account_deletion_pending (pg_temp.u(1))
      and not exists (select 1 from public.account_deletion_attempts
                      where user_id = pg_temp.u(1) and ended_at is null and lease_until > now())$q$);
select pg_temp.refused('31a ... so the half-deleted account cannot grow', pg_temp.student_sql(205, 1, 14), '55000');
select pg_temp.chk('31b ... and it is the runbook''s case: destructive cleanup began, no live attempt',
$q$select count(*) = 1 from public.account_deletions d
   where d.destructive_started_at is not null
     and not exists (select 1 from public.account_deletion_attempts a
                     where a.user_id = d.user_id and a.ended_at is null and a.lease_until > now())
     and d.user_id = pg_temp.u(1)$q$);
select pg_temp.begin('d2', 1);
select pg_temp.chk('32 a retry that then deletes nothing (billing down) abandons ...',
$q$select pg_temp.att('d2') is not null$q$);
select pg_temp.ran('32a ...', $q$select public.settle_account_deletion_attempt (pg_temp.u(1), pg_temp.att('d2'), 'abandoned', 'billing_unavailable')$q$);
select pg_temp.chk('33 ... but cannot clear a marker whose cleanup began',
$q$select public.account_deletion_pending (pg_temp.u(1))$q$);
select pg_temp.begin('d3', 1);
select public.mark_account_deletion_destructive (pg_temp.u(1), pg_temp.att('d3'));
select public.settle_account_deletion_attempt (pg_temp.u(1), pg_temp.att('d3'), 'failed', 'document_delete_failed');
select pg_temp.chk('34 a retry that stops part-way is settled failed, and the error recorded',
$q$select (select last_error = 'document_delete_failed' and attempts = 3 from public.account_deletions where user_id = pg_temp.u(1))
      and (select outcome = 'failed' and ended_at is not null from public.account_deletion_attempts where attempt = pg_temp.att('d3'))$q$);
select pg_temp.chk('35 an attempt that has ended, or run out its lease, may not start deleting',
$q$select not public.mark_account_deletion_destructive (pg_temp.u(1), pg_temp.att('d3'))
      and not public.mark_account_deletion_destructive (pg_temp.u(1), pg_temp.att('d1'))
      and not public.mark_account_deletion_destructive (pg_temp.u(1), gen_random_uuid())$q$);
update public.account_deletions set destructive_started_at = now() - interval '1 hour' where user_id = pg_temp.u(1);
select pg_temp.begin('d4', 1);
select pg_temp.chk('36 marking again keeps the first time cleanup began',
$q$select public.mark_account_deletion_destructive (pg_temp.u(1), pg_temp.att('d4'))$q$);
select pg_temp.chk('36a ... (an hour ago, not now)',
$q$select destructive_started_at < now() - interval '59 minutes' from public.account_deletions where user_id = pg_temp.u(1)$q$);

-- ===========================================================================
-- 5. Completion: the marker and its attempts go with the auth user
-- ===========================================================================
reset role;
delete from auth.users where id = pg_temp.u(1);
select pg_temp.chk('40 deleting the auth user cascades the marker and its attempts away',
$q$select not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))
      and not exists (select 1 from public.account_deletion_attempts where user_id = pg_temp.u(1))$q$);
select pg_temp.as_service();
select pg_temp.chk('41 a retry for an account already gone has nothing to guard: null, and no marker',
$q$select public.begin_account_deletion_attempt (pg_temp.u(1)) is null
      and not exists (select 1 from public.account_deletions where user_id = pg_temp.u(1))$q$);
select pg_temp.chk('42 the old single-counter functions are gone',
$q$select not exists (select 1 from pg_proc where proname in ('begin_account_deletion', 'settle_account_deletion')
                      and pronamespace = 'public'::regnamespace)$q$);

-- ===========================================================================
-- 6. Service role only
-- ===========================================================================
select pg_temp.as_user(2);
select pg_temp.refused('50 a signed-in client cannot begin a deletion attempt',
$q$select public.begin_account_deletion_attempt (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('51 ... or mark one destructive',
$q$select public.mark_account_deletion_destructive (pg_temp.u(2), gen_random_uuid())$q$, '42501');
select pg_temp.refused('52 ... or settle one',
$q$select public.settle_account_deletion_attempt (pg_temp.u(2), gen_random_uuid(), 'abandoned')$q$, '42501');
select pg_temp.refused('53 ... or ask whether an account is pending',
$q$select public.account_deletion_pending (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('54 ... or read the markers', $q$select count(*) from public.account_deletions$q$, '42501');
select pg_temp.refused('55 ... or the attempts', $q$select count(*) from public.account_deletion_attempts$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('56 anon cannot begin one', $q$select public.begin_account_deletion_attempt (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('57 ... or read them', $q$select count(*) from public.account_deletions$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
