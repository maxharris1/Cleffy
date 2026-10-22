-- Behaviour proof for 20261022110100_account_deletion_pending.sql and
-- 20261022110400_account_deletion_attempts.sql: while an account's deletion is
-- pending, nothing can add a score or a roster row to it, whoever inserts. An
-- account is pending while an attempt is active (not ended, lease not run out)
-- or once destructive cleanup began. So two attempts that both abandon clear
-- it, a crashed attempt stops restricting when its lease runs out, and an
-- attempt that crashed after it started deleting keeps it (the runbook case)
-- until a retry completes and the marker cascades away with the auth user.
--
-- And for 20261022110600_account_deletion_barrier.sql, section 7: the same
-- predicate refuses Storage uploads into an existing score (both buckets),
-- joins (share-link redemption), checkout leases and staging, and a new
-- provisioning intent; a checkout lease taken before the marker is reported
-- live; provisioning intents name the Auth account to clean up, and outlive
-- the teacher.
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
insert into auth.users (id, aud, role, email)
values (pg_temp.u(3), 'authenticated', 'authenticated', 'barrier-teacher@example.invalid'),
       (pg_temp.u(4), 'authenticated', 'authenticated', 'barrier-member@example.invalid'),
       (pg_temp.u(5), 'authenticated', 'authenticated', 'barrier-buyer@example.invalid');
insert into storage.buckets (id, name, public) values ('scores', 'scores', false), ('thumbnails', 'thumbnails', false)
on conflict (id) do nothing;

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
-- 7. The barrier beyond scores and roster rows (20261022110600)
-- ===========================================================================
select pg_temp.ran('70 before: u3 owns a score with a file', pg_temp.doc_sql(301, 3));
select pg_temp.ran('70a ... and a bystander (u2) owns one too', pg_temp.doc_sql(302, 2));
insert into storage.objects (bucket_id, name, owner)
values ('scores', pg_temp.u(301) || '/original.pdf', pg_temp.u(3));
-- A second score of u3's with no file yet: its folder takes check 73's
-- upload. Object names follow 20261022100400 (only {id}/original.pdf and
-- {id}/pre-import-original.pdf in scores), so the barrier, not the name
-- rule, is what refuses it.
do $d$ begin execute pg_temp.doc_sql(303, 3); end $d$;
insert into public.share_links (token, document_id, role, created_by)
values ('barrier-link-301', pg_temp.u(301), 'viewer', pg_temp.u(3)),
       ('barrier-link-302', pg_temp.u(302), 'viewer', pg_temp.u(2));
select pg_temp.as_user(3);
select pg_temp.ran('71 before the deletion the owner can upload into their score',
$q$insert into storage.objects (bucket_id, name, owner) values ('scores', pg_temp.u(301) || '/pre-import-original.pdf', pg_temp.u(3))$q$);
select pg_temp.chk('71a ... and is told nothing is pending for them',
$q$select not public.caller_account_deletion_pending ()$q$);
select pg_temp.as_service();
select pg_temp.begin('b3', 3);
select pg_temp.as_user(3);
select pg_temp.chk('72 once deletion begins, the caller is pending', $q$select public.caller_account_deletion_pending ()$q$);
select pg_temp.refused('73 an upload into the score that already exists is refused (scores)',
$q$insert into storage.objects (bucket_id, name, owner) values ('scores', pg_temp.u(303) || '/original.pdf', pg_temp.u(3))$q$, '42501');
select pg_temp.refused('74 ... and a cover into thumbnails',
$q$insert into storage.objects (bucket_id, name, owner) values ('thumbnails', pg_temp.u(301) || '/0.jpg', pg_temp.u(3))$q$, '42501');
select pg_temp.refused('75 ... and an overwrite (upload with upsert)',
$q$insert into storage.objects (bucket_id, name, owner, metadata) values ('scores', pg_temp.u(301) || '/original.pdf', pg_temp.u(3), '{"size": 2}')
   on conflict (bucket_id, name collate "C") where archived_at is null do update set metadata = excluded.metadata$q$, '42501');
select pg_temp.chk('76 removing files is not restricted (the sweep, or the owner''s own delete, through the Storage API)',
$q$select not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                      and policyname like 'storage_refuse_during_account_deletion%' and cmd = 'DELETE')
      and (select count(*) = 2 from pg_policies where schemaname = 'storage' and tablename = 'objects'
           and policyname like 'storage_refuse_during_account_deletion%' and permissive = 'RESTRICTIVE')$q$);
select pg_temp.as_user(2);
select pg_temp.ran('77 another account''s uploads are not affected',
$q$insert into storage.objects (bucket_id, name, owner) values ('scores', pg_temp.u(302) || '/original.pdf', pg_temp.u(2))$q$);
select pg_temp.as_user(4);
select pg_temp.refused('78 redeeming a share link to the deleting owner''s score is refused',
$q$select * from public.redeem_share_link ('barrier-link-301')$q$, '55000');
select pg_temp.ran('78a ... a link to anyone else''s score still works',
$q$select * from public.redeem_share_link ('barrier-link-302')$q$);
select pg_temp.as_user(3);
select pg_temp.refused('79 the deleting account cannot join a score by link either',
$q$select * from public.redeem_share_link ('barrier-link-302')$q$, '55000');
select pg_temp.as_service();
select pg_temp.refused('79a ... nor be added to one by any other insert',
$q$insert into public.document_members (document_id, user_id, role) values (pg_temp.u(302), pg_temp.u(3), 'viewer')$q$, '55000');
select pg_temp.refused('80 a checkout lease is refused for the deleting account',
$q$select * from public.begin_checkout_attempt (pg_temp.u(3), 'live', interval '5 minutes')$q$, '55000');
select pg_temp.chk('80a ... and none is in flight for it',
$q$select not public.checkout_attempt_in_flight (pg_temp.u(3))$q$);
-- u5 starts a checkout, THEN asks to delete their account.
select pg_temp.chk('81 a checkout lease taken before the deletion',
$q$select count(*) = 1 from public.begin_checkout_attempt (pg_temp.u(5), 'live', interval '5 minutes')$q$);
select pg_temp.begin('b5', 5);
select pg_temp.chk('82 ... is reported in flight to the deletion, which must not go on',
$q$select public.checkout_attempt_in_flight (pg_temp.u(5))$q$);
select pg_temp.refused('83 ... and cannot stage a Stripe create any more',
$q$select public.stage_checkout_attempt (pg_temp.u(5), 'live',
    (select holder from public.checkout_attempts where user_id = pg_temp.u(5) and mode = 'live'),
    gen_random_uuid(), 'price_x')$q$, '55000');
select pg_temp.chk('84 ... but can still let go of its lease, after which nothing is in flight',
$q$with r as (update public.checkout_attempts set holder = null where user_id = pg_temp.u(5) returning 1)
   select count(*) = 1 from r$q$);
select pg_temp.chk('84a ...', $q$select not public.checkout_attempt_in_flight (pg_temp.u(5))$q$);
select pg_temp.chk('85 a provisioning for the deleting teacher records nothing and is refused',
$q$select public.begin_student_provision (pg_temp.u(3), pg_temp.u(401), 'st-x@students.cleffy.app') = 'deletion_pending'
      and not exists (select 1 from public.student_provision_intents where teacher_id = pg_temp.u(3))$q$);
select pg_temp.chk('86 a provisioning for a teacher not being deleted records its intent first',
$q$select public.begin_student_provision (pg_temp.u(2), pg_temp.u(402), 'St-' || pg_temp.u(402) || '@Students.Cleffy.App') = 'ok'$q$);
select pg_temp.chk('86a ... live, with no account yet, its address normalized',
$q$select student_user_id is null and live from public.student_provision_intents_for (pg_temp.u(2)) where roster_id = pg_temp.u(402)$q$);
reset role;
-- GoTrue stamps created_at on every account it creates.
insert into auth.users (id, aud, role, email, raw_app_meta_data, created_at)
values (pg_temp.u(16), 'authenticated', 'authenticated', 'st-' || pg_temp.u(402) || '@students.cleffy.app',
        json_build_object('user_type', 'student', 'teacher_id', pg_temp.u(2))::jsonb, now());
-- An account at the address the next intent uses, created a day before it.
update auth.users set created_at = now() - interval '1 day' where id = pg_temp.u(4);
select pg_temp.as_service();
select pg_temp.chk('87 a crash between the Auth create and the attach: the intent still finds the account by address',
$q$select student_user_id = pg_temp.u(16) from public.student_provision_intents_for (pg_temp.u(2)) where roster_id = pg_temp.u(402)$q$);
select pg_temp.chk('88 the attach records it',
$q$select public.attach_student_provision (pg_temp.u(402), pg_temp.u(16))$q$);
select pg_temp.ran('89 the roster row is the success ...',
$q$insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
   values (pg_temp.u(402), pg_temp.u(2), pg_temp.u(16), 'Provisioned', 'hash-402', 'code')$q$);
select pg_temp.chk('89a ... and clears the intent in the same transaction',
$q$select not exists (select 1 from public.student_provision_intents where roster_id = pg_temp.u(402))$q$);
select pg_temp.chk('90 an intent at an address that already had an account ...',
$q$select public.begin_student_provision (pg_temp.u(2), pg_temp.u(403), 'barrier-member@example.invalid') = 'ok'$q$);
select pg_temp.chk('90a ... never matches that older account (it is not the provisioning''s)',
$q$select student_user_id is null from public.student_provision_intents_for (pg_temp.u(2)) where roster_id = pg_temp.u(403)$q$);
select pg_temp.chk('91 a provisioning that undid its account finishes its intent; a late attach then fails',
$q$select public.finish_student_provision (pg_temp.u(403)) and not public.attach_student_provision (pg_temp.u(403), pg_temp.u(4))$q$);
select pg_temp.chk('92 an intent outlives its teacher (no foreign key), so a crash around a deletion stays on record',
$q$select public.begin_student_provision (pg_temp.u(4), pg_temp.u(404), 'st-' || pg_temp.u(404) || '@students.cleffy.app') = 'ok'$q$);
reset role;
delete from auth.users where id = pg_temp.u(4);
select pg_temp.chk('92a ...', $q$select exists (select 1 from public.student_provision_intents where roster_id = pg_temp.u(404))$q$);
select pg_temp.as_user(2);
select pg_temp.refused('93 a client cannot register a provisioning',
$q$select public.begin_student_provision (pg_temp.u(2), gen_random_uuid(), 'x@example.invalid')$q$, '42501');
select pg_temp.refused('93a ... or read the intents', $q$select count(*) from public.student_provision_intents$q$, '42501');
select pg_temp.refused('93b ... or list them', $q$select count(*) from public.student_provision_intents_for (pg_temp.u(2))$q$, '42501');
select pg_temp.refused('93c ... or ask about another account''s checkout', $q$select public.checkout_attempt_in_flight (pg_temp.u(3))$q$, '42501');
select pg_temp.as_service();

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
