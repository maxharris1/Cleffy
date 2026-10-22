-- Behaviour proof for 20261022110000_student_claim_reservation.sql: a student
-- claim reserves the roster row, bound to its code hash, before any password
-- is written, and commits only while the hash and the holder still match.
--
-- The interleavings are written out statement by statement -- each call is what
-- one request does at that moment -- so every ordering the Edge Functions can
-- produce is pinned, not sampled:
--
--   1. one claim, start to finish, and the card is spent;
--   2. two claims on one card: the second is told to wait and never reaches
--      the password write; the first commits;
--   3. a claim against a teacher's reset, both ways round: whichever comes
--      second waits, and a rotated code can never be committed with the old one;
--   4. expiry: a holder that died is taken over, and its late commit is lost;
--   5. archive blocks a claim's commit but keeps its reservation until the
--      claim lets go; release hands back only its own;
--   6. no client role can call any of it or read the table;
--   7. (20261022110500_student_code_reset_holder.sql) a reset carries a holder
--      token: a second reset cannot take a live one over, only the holder
--      completes or releases it, and the paused reset / reset / claim
--      interleaving can no longer scramble a password the student just chose.
--   8. (20261022110700_student_code_reset_worker.sql) every attempt takes its
--      own worker lease (worker + fencing epoch): two paused retries of one
--      token -- B completes, the student claims, A resumes and gets 'lost' at
--      its fence and its completion; a worker inside an Auth call cannot be
--      taken over or released under; a claim since the reservation fences the
--      reset out.
--   9. (20261022110800_student_code_reset_quarantine.sql) a password write
--      whose outcome is unknown quarantines the attempt: the worker does not
--      report back, so a retry and a claim both wait until the write is
--      confirmed (the retry, holding the token, is handed the worker's lease
--      and reports it back) or the hold runs out; and the session revocation
--      checks the lease in its own transaction (end_student_sessions_fenced).
--
-- Runs inside one transaction and ROLLS BACK -- nothing persists. Same harness
-- and reading as tests/sql/launch_checkout_fixes.sql:
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/student_claim_reservation.sql
--
-- Every row of the result table should read `t`; the last line is
-- `failures | total`. Run it against a local or branch database.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_res (label text primary key, reservation uuid);
grant all on t_res to anon, authenticated, service_role;
create temp table t_lease (label text primary key, worker uuid, epoch bigint);
grant all on t_lease to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('c1a10000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
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
-- Take a claim reservation and remember it under `label`; true when reserved.
create function pg_temp.reserve(p_label text, p_hash text) returns boolean language plpgsql as $f$
declare v jsonb;
begin
v := public.reserve_student_claim (p_hash);
if v ->> 'status' = 'reserved' then
    insert into t_res values (p_label, (v ->> 'reservation')::uuid)
    on conflict (label) do update set reservation = excluded.reservation;
    return true;
end if;
return false;
end $f$;
create function pg_temp.res(p_label text) returns uuid language sql as $f$ select reservation from t_res where label = p_label $f$;
-- A teacher's reset of student `n`, presenting the token remembered under
-- `p_token` (if any); its own token is remembered under `label`. The status.
create function pg_temp.reset(p_label text, p_n int, p_token text default null) returns text language plpgsql as $f$
declare v jsonb;
begin
v := public.reserve_student_code_reset (pg_temp.u(200 + p_n), pg_temp.res(p_token));
if v ->> 'status' = 'reserved' then
    insert into t_res values (p_label, (v ->> 'reservation')::uuid)
    on conflict (label) do update set reservation = excluded.reservation;
    insert into t_lease values (p_label, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
    on conflict (label) do update set worker = excluded.worker, epoch = excluded.epoch;
end if;
return v ->> 'status';
end $f$;
-- The worker lease remembered under `label`, acting on student `n`.
create function pg_temp.fence(p_label text, p_n int) returns text language sql as $f$
select public.fence_student_code_reset (pg_temp.u(200 + p_n), pg_temp.res(p_label),
    (select worker from t_lease where label = p_label), (select epoch from t_lease where label = p_label)) $f$;
create function pg_temp.complete_reset(p_label text, p_n int, p_hash text) returns text language sql as $f$
select public.complete_student_code_reset (pg_temp.u(200 + p_n), pg_temp.res(p_label),
    (select worker from t_lease where label = p_label), (select epoch from t_lease where label = p_label), p_hash) $f$;
create function pg_temp.stop(p_label text, p_n int) returns boolean language sql as $f$
select public.stop_student_code_reset_worker (pg_temp.u(200 + p_n), pg_temp.res(p_label),
    (select worker from t_lease where label = p_label), (select epoch from t_lease where label = p_label)) $f$;
create function pg_temp.end_sessions(p_label text, p_n int) returns int language sql as $f$
select public.end_student_sessions_fenced (pg_temp.u(200 + p_n), pg_temp.res(p_label),
    (select worker from t_lease where label = p_label), (select epoch from t_lease where label = p_label)) $f$;
-- reserve_student_code_reset's raw answer for student `n`, presenting the token under `p_token`.
create function pg_temp.reset_answer(p_n int, p_token text default null) returns jsonb language sql as $f$
select public.reserve_student_code_reset (pg_temp.u(200 + p_n), pg_temp.res(p_token)) $f$;
create function pg_temp.epoch(p_label text) returns bigint language sql as $f$ select epoch from t_lease where label = p_label $f$;
create function pg_temp.reset_kind(p_n int) returns text language sql as $f$ select public.reserve_student_code_reset (pg_temp.u(200 + p_n)) ->> 'kind' $f$;
create function pg_temp.status(p_hash text) returns text language sql as $f$ select public.reserve_student_claim (p_hash) ->> 'status' $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres): one teacher, seven code students, all Invited.
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values (pg_temp.u(1), 'authenticated', 'authenticated', 'claim-teacher@example.invalid');
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.u(100 + n), 'authenticated', 'authenticated', 'st-claim-' || n || '@students.cleffy.app', '{"user_type":"student"}'
from generate_series (1, 17) n;
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method)
select pg_temp.u(200 + n), pg_temp.u(1), pg_temp.u(100 + n), 'Student ' || n, 'hash-' || n, 'code'
from generate_series (1, 17) n;

select pg_temp.as_service();

-- ===========================================================================
-- 1. One claim, start to finish
-- ===========================================================================
select pg_temp.chk('01 a claim reserves the row its code selects',
$q$select pg_temp.reserve ('a1', 'hash-1')$q$);
select pg_temp.chk('02 ... bound to that code hash, as a claim, for longer than a function can run',
$q$select kind = 'claim' and login_code_hash = 'hash-1' and reserved_until > now() + interval '400 seconds'
   from public.student_claim_reservations where student_id = pg_temp.u(201)$q$);
select pg_temp.chk('03 a code that selects nothing is not_found, and reserves nothing',
$q$select pg_temp.status ('hash-nobody') = 'not_found'
      and not exists (select 1 from public.student_claim_reservations where login_code_hash = 'hash-nobody')$q$);
select pg_temp.chk('04 completing with someone else''s reservation is lost',
$q$select public.complete_student_claim (pg_temp.u(201), gen_random_uuid(), 'hash-1', 'ada_one') = 'lost'$q$);
select pg_temp.chk('05 completing with the right reservation but another hash is lost',
$q$select public.complete_student_claim (pg_temp.u(201), pg_temp.res('a1'), 'hash-2', 'ada_one') = 'lost'$q$);
select pg_temp.chk('06 ... and neither touched the row',
$q$select claimed_at is null and login_code_hash = 'hash-1' and username is null
   from public.managed_students where id = pg_temp.u(201)$q$);
select pg_temp.chk('07 the holder completes',
$q$select public.complete_student_claim (pg_temp.u(201), pg_temp.res('a1'), 'hash-1', 'ada_one') = 'claimed'$q$);
select pg_temp.chk('08 ... spending the card, storing the name, and handing the row back',
$q$select claimed_at is not null and login_code_hash is null and username = 'ada_one'
      and not exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(201))
   from public.managed_students where id = pg_temp.u(201)$q$);
select pg_temp.chk('09 the spent card selects nothing any more',
$q$select pg_temp.status ('hash-1') = 'not_found'$q$);
select pg_temp.chk('10 a replay of the same completion is lost',
$q$select public.complete_student_claim (pg_temp.u(201), pg_temp.res('a1'), 'hash-1', 'ada_one') = 'lost'$q$);

-- ===========================================================================
-- 2. Two claims on one card
-- ===========================================================================
select pg_temp.chk('20 claim A reserves the card',
$q$select pg_temp.reserve ('2a', 'hash-2')$q$);
select pg_temp.chk('21 claim B, on the same card, is told it is busy (and so never writes a password)',
$q$select (v ->> 'status') = 'busy' and (v ->> 'retry_after_seconds')::int between 1 and 600
   from (select public.reserve_student_claim ('hash-2') as v) x$q$);
select pg_temp.chk('22 ... and B''s attempt did not replace A''s reservation',
$q$select reservation = pg_temp.res('2a') from public.student_claim_reservations where student_id = pg_temp.u(202)$q$);
select pg_temp.refused('23 a username another row holds is refused by the unique index',
$q$select public.complete_student_claim (pg_temp.u(202), pg_temp.res('2a'), 'hash-2', 'ada_one')$q$, '23505');
select pg_temp.chk('24 ... leaving A''s reservation in place for A to release or retry',
$q$select reservation = pg_temp.res('2a') from public.student_claim_reservations where student_id = pg_temp.u(202)$q$);
select pg_temp.chk('25 A completes with a free name',
$q$select public.complete_student_claim (pg_temp.u(202), pg_temp.res('2a'), 'hash-2', 'ben_two') = 'claimed'$q$);
select pg_temp.chk('26 B, trying again afterwards, finds the card spent',
$q$select pg_temp.status ('hash-2') = 'not_found'$q$);

-- ===========================================================================
-- 3. A claim against a teacher's reset, both ways round
-- ===========================================================================
-- 3a. The claim first.
select pg_temp.chk('30 a claim reserves the card',
$q$select pg_temp.reserve ('3a', 'hash-3')$q$);
select pg_temp.chk('31 the teacher''s reset is told to wait: it must not scramble a password the claim is setting',
$q$select pg_temp.reset ('3r', 3) = 'busy' and pg_temp.reset_kind (3) = 'claim'$q$);
select pg_temp.refused('32 rotating the code under a live claim by any other path is refused',
$q$update public.managed_students set login_code_hash = 'hash-3-new' where id = pg_temp.u(203)$q$, '55006');
select pg_temp.chk('33 the claim commits (the card was valid when it was presented)',
$q$select public.complete_student_claim (pg_temp.u(203), pg_temp.res('3a'), 'hash-3', 'cat_three') = 'claimed'$q$);
select pg_temp.chk('34 the reset, retried, now goes ahead',
$q$select pg_temp.reset ('3r', 3) = 'reserved'$q$);
select pg_temp.chk('35 ... the holder writes the new code',
$q$select pg_temp.complete_reset ('3r', 3, 'hash-3-new') = 'reset'$q$);
select pg_temp.chk('35a ... which hands the row back, Invited with the new card',
$q$select not exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(203))
      and (select login_code_hash = 'hash-3-new' and claimed_at is null from public.managed_students where id = pg_temp.u(203))$q$);

-- 3b. The reset first.
select pg_temp.chk('36 a reset reserves the row before it scrambles',
$q$select pg_temp.reset ('4r', 4) = 'reserved'$q$);
select pg_temp.chk('37 a claim with the card the reset is replacing is told to wait',
$q$select pg_temp.status ('hash-4') = 'busy'$q$);
select pg_temp.chk('38 a reset retried after a partial failure, with its token, resumes its own reservation',
$q$with t as (select pg_temp.res('4r') as before)
   select pg_temp.reset ('4r', 4, '4r') = 'reserved' and pg_temp.res('4r') = (select before from t)$q$);
select pg_temp.chk('38a ... a reset without that token is told another reset holds the row',
$q$select pg_temp.reset ('4x', 4) = 'busy' and pg_temp.reset_kind (4) = 'reset'$q$);
select pg_temp.chk('38b ... and so is one with a wrong token',
$q$select (public.reserve_student_code_reset (pg_temp.u(204), gen_random_uuid()) ->> 'status') = 'busy'$q$);
select pg_temp.chk('38c the holder writes the new code',
$q$select pg_temp.complete_reset ('4r', 4, 'hash-4-new') = 'reset'$q$);
select pg_temp.chk('39 once the new code is written, the old card selects nothing',
$q$select pg_temp.status ('hash-4') = 'not_found'$q$);
select pg_temp.chk('40 ... and the new card can be claimed',
$q$select pg_temp.reserve ('3b', 'hash-4-new')$q$);
select pg_temp.chk('41 a claim holding the OLD hash can never commit against the new one',
$q$select public.complete_student_claim (pg_temp.u(204), pg_temp.res('3b'), 'hash-4', 'dee_four') = 'lost'$q$);
select pg_temp.chk('42 the new card''s holder commits',
$q$select public.complete_student_claim (pg_temp.u(204), pg_temp.res('3b'), 'hash-4-new', 'dee_four') = 'claimed'$q$);

-- ===========================================================================
-- 4. Expiry: a holder that died is taken over
-- ===========================================================================
select pg_temp.chk('50 claim A reserves',
$q$select pg_temp.reserve ('4a', 'hash-5')$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(205);
select pg_temp.chk('51 once A''s reservation has expired, claim B takes the row over',
$q$select pg_temp.reserve ('4b', 'hash-5') and pg_temp.res('4a') <> pg_temp.res('4b')$q$);
select pg_temp.chk('52 A''s late commit is lost',
$q$select public.complete_student_claim (pg_temp.u(205), pg_temp.res('4a'), 'hash-5', 'eve_five') = 'lost'$q$);
select pg_temp.chk('53 ... and A''s late release cannot hand back B''s reservation',
$q$select not public.release_student_claim (pg_temp.u(205), pg_temp.res('4a'))
      and exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(205)
                  and reservation = pg_temp.res('4b'))$q$);
select pg_temp.chk('54 B commits',
$q$select public.complete_student_claim (pg_temp.u(205), pg_temp.res('4b'), 'hash-5', 'eve_five') = 'claimed'$q$);
select pg_temp.chk('55 an expired claim does not block a reset',
$q$select pg_temp.reserve ('4c', 'hash-6')$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(206);
select pg_temp.chk('56 ... the reset takes the row',
$q$select pg_temp.reset ('6r', 6) = 'reserved'$q$);
select pg_temp.chk('57 ... and the expired claim''s commit is lost',
$q$select public.complete_student_claim (pg_temp.u(206), pg_temp.res('4c'), 'hash-6', 'fay_six') = 'lost'$q$);
select pg_temp.chk('58 the reset completes',
$q$select pg_temp.complete_reset ('6r', 6, 'hash-6-new') = 'reset'$q$);

-- ===========================================================================
-- 5. Archive and release
-- ===========================================================================
select pg_temp.chk('60 a claim reserves',
$q$select pg_temp.reserve ('5a', 'hash-7')$q$);
select pg_temp.chk('61 releasing someone else''s reservation does nothing',
$q$select not public.release_student_claim (pg_temp.u(207), gen_random_uuid())
      and exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(207))$q$);
select pg_temp.chk('62 the holder releases its own',
$q$select public.release_student_claim (pg_temp.u(207), pg_temp.res('5a'))$q$);
select pg_temp.chk('63 ... and the card can be reserved again at once',
$q$select pg_temp.reserve ('5b', 'hash-7')$q$);
update public.managed_students set archived_at = now() where id = pg_temp.u(207);
select pg_temp.chk('64 archiving blocks the claim in flight: its commit is lost',
$q$select public.complete_student_claim (pg_temp.u(207), pg_temp.res('5b'), 'hash-7', 'gus_seven') = 'lost'$q$);
select pg_temp.chk('65 ... but its reservation stays until it lets go, so a reset of the archived row waits for it',
$q$select exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(207))
      and pg_temp.reset ('7r', 7) = 'busy'$q$);
select pg_temp.chk('66 an archived student''s card reserves nothing',
$q$select pg_temp.status ('hash-7') = 'not_found'$q$);
select pg_temp.chk('67 once the stale claim releases, the reset goes ahead',
$q$select public.release_student_claim (pg_temp.u(207), pg_temp.res('5b'))
      and pg_temp.reset ('7r', 7) = 'reserved'$q$);

-- ===========================================================================
-- 7. Reset / reset / claim: a paused reset can never scramble the student's
--    freshly chosen password (Codex r1 Part B finding 2)
-- ===========================================================================
-- Reset A reserves student 8 and pauses before its scramble.
select pg_temp.chk('80 reset A reserves',
$q$select pg_temp.reset ('8a', 8) = 'reserved'$q$);
select pg_temp.chk('81 reset B (another tab) cannot take A''s live reservation over',
$q$select pg_temp.reset ('8b', 8) = 'busy' and pg_temp.reset_kind (8) = 'reset'$q$);
select pg_temp.chk('82 ... nor can B write a code or release A''s hold without A''s token',
$q$select public.complete_student_code_reset (pg_temp.u(208), gen_random_uuid(), gen_random_uuid(), 0, 'hash-8-b') = 'lost'
      and not public.release_student_code_reset (pg_temp.u(208), gen_random_uuid())
      and exists (select 1 from public.student_claim_reservations where student_id = pg_temp.u(208)
                  and reservation = pg_temp.res('8a'))$q$);
select pg_temp.chk('83 a claim on the old card waits for A too (so no password is chosen under it)',
$q$select pg_temp.status ('hash-8') = 'busy'$q$);
select pg_temp.refused('84 no other path can rotate the code under A''s live reset',
$q$update public.managed_students set login_code_hash = 'hash-8-sneak' where id = pg_temp.u(208)$q$, '55006');
select pg_temp.chk('85 A resumes and completes: only now does a new card exist',
$q$select pg_temp.complete_reset ('8a', 8, 'hash-8-a') = 'reset'$q$);
select pg_temp.chk('86 the student claims A''s card and commits their own password',
$q$select pg_temp.reserve ('8c', 'hash-8-a')
      and public.complete_student_claim (pg_temp.u(208), pg_temp.res('8c'), 'hash-8-a', 'ivy_eight') = 'claimed'$q$);
select pg_temp.chk('87 A''s late replay of its completion is lost: it writes nothing over the claim',
$q$select pg_temp.complete_reset ('8a', 8, 'hash-8-a') = 'lost'
      and (select username = 'ivy_eight' and claimed_at is not null and login_code_hash is null
           from public.managed_students where id = pg_temp.u(208))$q$);
-- A reset that crashed: its hold runs out, and a new reset may take the row.
select pg_temp.chk('88 a reset that died holds the row only until its TTL',
$q$select pg_temp.reset ('9a', 9) = 'reserved'$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(209);
select pg_temp.chk('89 ... then another reset takes it, under a new token',
$q$select pg_temp.reset ('9b', 9) = 'reserved' and pg_temp.res('9a') <> pg_temp.res('9b')$q$);
select pg_temp.chk('89a ... and the dead one can neither complete nor release',
$q$select pg_temp.complete_reset ('9a', 9, 'hash-9-a') = 'lost'
      and not public.release_student_code_reset (pg_temp.u(209), pg_temp.res('9a'))$q$);
select pg_temp.chk('89b the holder may release its hold (and the old card is claimable again)',
$q$select public.release_student_code_reset (pg_temp.u(209), pg_temp.res('9b')) and pg_temp.status ('hash-9') = 'reserved'$q$);
select pg_temp.chk('89c the old reset-takeover function is gone',
$q$select not exists (select 1 from pg_proc where proname = 'begin_student_code_reset' and pronamespace = 'public'::regnamespace)$q$);

-- ===========================================================================
-- 8. A worker lease per attempt: two retries of one token can never both
--    write (Codex r2 Part B MAJOR; 20261022110700_student_code_reset_worker.sql)
-- ===========================================================================
-- Student 10: a first try X fails part-way and reports back; retries A and B
-- then present X's token at once.
select pg_temp.chk('90 try X reserves, passes its fence, fails, and reports back',
$q$select pg_temp.reset ('10x', 10) = 'reserved' and pg_temp.fence ('10x', 10) = 'ok' and pg_temp.stop ('10x', 10)$q$);
select pg_temp.chk('90a ... the hold stays, with no worker and nothing in flight',
$q$select worker is null and not worker_in_auth and reserved_until > now()
   from public.student_claim_reservations where student_id = pg_temp.u(210)$q$);
insert into t_res select '10a', reservation from t_res where label = '10x';
insert into t_res select '10b', reservation from t_res where label = '10x';
select pg_temp.chk('91 retry A presents the token: resumed',
$q$select pg_temp.reset ('10a', 10, '10x') = 'reserved'$q$);
select pg_temp.chk('91a ... the same reservation, under a fresh worker and a newer epoch',
$q$select pg_temp.res('10a') = pg_temp.res('10x') and pg_temp.epoch('10a') > pg_temp.epoch('10x')$q$);
-- A pauses right before its password write. B presents the same token.
select pg_temp.chk('92 retry B presents the same token: resumed too',
$q$select pg_temp.reset ('10b', 10, '10x') = 'reserved'$q$);
select pg_temp.chk('92a ... the same reservation, another worker, a newer epoch still',
$q$select pg_temp.res('10b') = pg_temp.res('10a') and pg_temp.epoch('10b') > pg_temp.epoch('10a')
      and (select worker from t_lease where label = '10b') <> (select worker from t_lease where label = '10a')$q$);
select pg_temp.chk('93 B fences before its password write, again before the sessions, and completes',
$q$select pg_temp.fence ('10b', 10) = 'ok' and pg_temp.fence ('10b', 10) = 'ok'
      and pg_temp.complete_reset ('10b', 10, 'hash-10-b') = 'reset'$q$);
select pg_temp.chk('94 the student claims B''s card and commits their own password',
$q$select pg_temp.reserve ('10c', 'hash-10-b')
      and public.complete_student_claim (pg_temp.u(210), pg_temp.res('10c'), 'hash-10-b', 'kit_ten') = 'claimed'$q$);
select pg_temp.chk('95 A resumes: its fence is lost, so it never reaches the password write',
$q$select pg_temp.fence ('10a', 10) = 'lost'$q$);
select pg_temp.chk('96 ... nor the sessions, its completion, or a report-back',
$q$select pg_temp.fence ('10a', 10) = 'lost' and pg_temp.complete_reset ('10a', 10, 'hash-10-a') = 'lost'
      and not pg_temp.stop ('10a', 10)$q$);
select pg_temp.chk('96b ... and the student''s claim stands',
$q$select username = 'kit_ten' and claimed_at is not null and login_code_hash is null
   from public.managed_students where id = pg_temp.u(210)$q$);
-- The same race with B still working: the older epoch is fenced out at once.
select pg_temp.chk('96c with the hold still live, a newer lease fences the older worker out',
$q$select pg_temp.reset ('11x', 11) = 'reserved' and pg_temp.stop ('11x', 11)
      and pg_temp.reset ('11a', 11, '11x') = 'reserved' and pg_temp.reset ('11b', 11, '11x') = 'reserved'
      and pg_temp.fence ('11a', 11) = 'lost' and pg_temp.fence ('11b', 11) = 'ok'$q$);
-- Student 11 now: B passed a fence and has not reported back.
select pg_temp.chk('97 a worker inside an Auth call cannot be taken over by the same token',
$q$select pg_temp.reset ('11c', 11, '11x') = 'busy' and pg_temp.reset_kind (11) = 'reset'$q$);
select pg_temp.chk('97a ... nor its hold released under it, nor the old card claimed',
$q$select not public.release_student_code_reset (pg_temp.u(211), pg_temp.res('11x'))
      and pg_temp.status ('hash-11') = 'busy'$q$);
select pg_temp.chk('98 once it reports back, the token resumes at once',
$q$select pg_temp.stop ('11b', 11) and pg_temp.reset ('11c', 11, '11x') = 'reserved'$q$);
select pg_temp.chk('98a ... under a newer epoch',
$q$select pg_temp.epoch('11c') > pg_temp.epoch('11b')$q$);
select pg_temp.chk('98c ... and the worker it replaced can neither fence nor complete',
$q$select pg_temp.fence ('11b', 11) = 'lost' and pg_temp.complete_reset ('11b', 11, 'hash-11-b') = 'lost'
      and pg_temp.fence ('11c', 11) = 'ok' and pg_temp.complete_reset ('11c', 11, 'hash-11-c') = 'reset'$q$);
-- Student 12: A's hold runs out, the student claims the old card, A wakes.
select pg_temp.chk('99 a claim after the hold ran out fences the stale reset out',
$q$select pg_temp.reset ('12a', 12) = 'reserved'$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(212);
select pg_temp.chk('99a ... (the student claims the old card meanwhile)',
$q$select pg_temp.reserve ('12c', 'hash-12')
      and public.complete_student_claim (pg_temp.u(212), pg_temp.res('12c'), 'hash-12', 'lou_twelve') = 'claimed'$q$);
select pg_temp.chk('99b ... and A can neither fence nor complete',
$q$select pg_temp.fence ('12a', 12) = 'lost' and pg_temp.complete_reset ('12a', 12, 'hash-12-a') = 'lost'$q$);
select pg_temp.chk('99c ... the claim stands',
$q$select username = 'lou_twelve' and claimed_at is not null from public.managed_students where id = pg_temp.u(212)$q$);
-- Student 13: a claim's commit is the one hash change the guard lets through
-- under a live hold; the fence's own no-claim check still catches it.
select pg_temp.chk('99d a live worker whose row was claimed since its reservation is fenced out',
$q$select pg_temp.reset ('13a', 13) = 'reserved'$q$);
update public.managed_students set claimed_at = now(), login_code_hash = null, username = 'max_thirteen' where id = pg_temp.u(213);
select pg_temp.chk('99e ... at the fence and at completion',
$q$select pg_temp.fence ('13a', 13) = 'lost' and pg_temp.complete_reset ('13a', 13, 'hash-13-a') = 'lost'$q$);
select pg_temp.chk('99f the token-only completion is gone',
$q$select not exists (select 1 from pg_proc where proname = 'complete_student_code_reset' and pronamespace = 'public'::regnamespace
                     and pronargs = 3)$q$);

-- ===========================================================================
-- 9. An Auth write whose outcome is unknown quarantines the attempt (Codex r3
--    MAJOR; 20261022110800_student_code_reset_quarantine.sql)
-- ===========================================================================
-- Student 14: worker A passes its fence and sends the scramble; the transport
-- fails, so A does NOT report back. Later the write is seen to have landed.
select pg_temp.chk('100 A reserves and passes its fence; its password write comes back ambiguous',
$q$select pg_temp.reset ('14a', 14) = 'reserved' and pg_temp.fence ('14a', 14) = 'ok'$q$);
select pg_temp.chk('100a a retry with the token is told the reset is still finishing, and handed A''s lease',
$q$select v ->> 'status' = 'busy' and v ->> 'kind' = 'reset'
      and (v ->> 'worker')::uuid = (select worker from t_lease where label = '14a')
      and (v ->> 'epoch')::bigint = pg_temp.epoch('14a')
   from pg_temp.reset_answer (14, '14a') v$q$);
select pg_temp.chk('100b ... a caller without the token is refused and handed nothing',
$q$select v ->> 'status' = 'busy' and not (v ? 'worker') and not (v ? 'epoch') from pg_temp.reset_answer (14) v$q$);
select pg_temp.chk('100c ... a claim of the old card waits',
$q$select pg_temp.status ('hash-14') = 'busy'$q$);
select pg_temp.chk('100d ... and the hold cannot be released under A',
$q$select not public.release_student_code_reset (pg_temp.u(214), pg_temp.res('14a'))$q$);
-- A's write is confirmed (the marker it carried is on the Auth user): the
-- retry reports A back with A's lease, then takes a lease of its own.
select pg_temp.chk('101 once confirmed, the retry reports A back and takes a newer lease',
$q$select pg_temp.stop ('14a', 14) and pg_temp.reset ('14b', 14, '14a') = 'reserved'
      and pg_temp.res('14b') = pg_temp.res('14a') and pg_temp.epoch('14b') > pg_temp.epoch('14a')$q$);
select pg_temp.chk('101a A''s delayed steps do nothing: no fence, no session revocation, no completion',
$q$select pg_temp.fence ('14a', 14) = 'lost' and pg_temp.end_sessions ('14a', 14) is null
      and pg_temp.complete_reset ('14a', 14, 'hash-14-a') = 'lost'$q$);
select pg_temp.chk('101b B fences, ends the sessions under its own lease, and completes',
$q$select pg_temp.fence ('14b', 14) = 'ok' and pg_temp.fence ('14b', 14) = 'ok'
      and pg_temp.end_sessions ('14b', 14) is not null
      and pg_temp.complete_reset ('14b', 14, 'hash-14-b') = 'reset'$q$);
select pg_temp.chk('101c the student claims B''s card',
$q$select pg_temp.reserve ('14c', 'hash-14-b')
      and public.complete_student_claim (pg_temp.u(214), pg_temp.res('14c'), 'hash-14-b', 'ivy_fourteen') = 'claimed'$q$);
select pg_temp.chk('101d ... and neither worker''s session revocation can land after the claim',
$q$select pg_temp.end_sessions ('14a', 14) is null and pg_temp.end_sessions ('14b', 14) is null$q$);
-- Student 15: never confirmed. The hold the fence renewed is the time limit.
-- (Reads of the table are checks of their own: a subquery would see the
-- statement's snapshot, from before the calls beside it.)
select pg_temp.chk('102 an unconfirmed attempt: A reserves and passes its fence',
$q$select pg_temp.reset ('15a', 15) = 'reserved' and pg_temp.fence ('15a', 15) = 'ok'$q$);
select pg_temp.chk('102a ... and holds the row, inside its Auth call, for the full window from its fence',
$q$select reserved_until >= now() + interval '600 seconds' and worker_in_auth
   from public.student_claim_reservations where student_id = pg_temp.u(215)$q$);
select pg_temp.chk('102b ... the retry and the claim both wait meanwhile',
$q$select pg_temp.reset ('15b', 15, '15a') = 'busy' and pg_temp.status ('hash-15') = 'busy'$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(215);
select pg_temp.chk('103 once the limit passes, the retry gets a fresh reservation',
$q$select pg_temp.reset ('15b', 15, '15a') = 'reserved' and pg_temp.res('15b') <> pg_temp.res('15a')$q$);
select pg_temp.chk('103a ... and the quarantined worker can do nothing more',
$q$select pg_temp.fence ('15a', 15) = 'lost' and pg_temp.end_sessions ('15a', 15) is null
      and pg_temp.complete_reset ('15a', 15, 'hash-15-a') = 'lost'$q$);
-- Student 16: never confirmed, nobody retries; the limit passes and the
-- student claims the old card.
select pg_temp.chk('103b an unconfirmed attempt runs out, and the old card can be claimed',
$q$select pg_temp.reset ('16a', 16) = 'reserved' and pg_temp.fence ('16a', 16) = 'ok'
      and pg_temp.status ('hash-16') = 'busy'$q$);
update public.student_claim_reservations set reserved_until = now() - interval '1 second' where student_id = pg_temp.u(216);
select pg_temp.chk('103c ... (the claim)',
$q$select pg_temp.reserve ('16c', 'hash-16')
      and public.complete_student_claim (pg_temp.u(216), pg_temp.res('16c'), 'hash-16', 'ned_sixteen') = 'claimed'$q$);
select pg_temp.chk('103d ... after which the stale worker can neither fence, end sessions, nor complete',
$q$select pg_temp.fence ('16a', 16) = 'lost' and pg_temp.end_sessions ('16a', 16) is null
      and pg_temp.complete_reset ('16a', 16, 'hash-16-a') = 'lost'$q$);
-- Student 17: end_student_sessions_fenced checks the lease itself.
select pg_temp.chk('104 a worker that has not passed a fence cannot end the sessions',
$q$select pg_temp.reset ('17a', 17) = 'reserved' and pg_temp.end_sessions ('17a', 17) is null$q$);
select pg_temp.chk('104a ... so nothing was stamped',
$q$select access_revoked_at is null from public.managed_students where id = pg_temp.u(217)$q$);
select pg_temp.chk('104b after its fence it can',
$q$select pg_temp.fence ('17a', 17) = 'ok' and pg_temp.end_sessions ('17a', 17) = 0$q$);
select pg_temp.chk('104c ... and the revocation is stamped',
$q$select access_revoked_at is not null from public.managed_students where id = pg_temp.u(217)$q$);
select pg_temp.chk('104d a newer lease of the same token fences the older one out of it',
$q$select pg_temp.stop ('17a', 17) and pg_temp.reset ('17b', 17, '17a') = 'reserved'
      and pg_temp.fence ('17b', 17) = 'ok' and pg_temp.end_sessions ('17a', 17) is null$q$);
update public.managed_students set claimed_at = now(), login_code_hash = null, username = 'oz_seventeen' where id = pg_temp.u(217);
select pg_temp.chk('104e a claim since the reservation fences even the current worker out of it',
$q$select pg_temp.end_sessions ('17b', 17) is null$q$);

-- ===========================================================================
-- 6. Service role only
-- ===========================================================================
select pg_temp.as_user(1);
select pg_temp.refused('70 a signed-in client cannot reserve a claim',
$q$select public.reserve_student_claim ('hash-6-new')$q$, '42501');
select pg_temp.refused('71 ... or complete one',
$q$select public.complete_student_claim (gen_random_uuid(), gen_random_uuid(), 'x', 'x')$q$, '42501');
select pg_temp.refused('72 ... or release one',
$q$select public.release_student_claim (gen_random_uuid(), gen_random_uuid())$q$, '42501');
select pg_temp.refused('73 ... or begin a reset',
$q$select public.reserve_student_code_reset (gen_random_uuid())$q$, '42501');
select pg_temp.refused('73a ... or complete one',
$q$select public.complete_student_code_reset (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'x')$q$, '42501');
select pg_temp.refused('73b ... or release one',
$q$select public.release_student_code_reset (gen_random_uuid(), gen_random_uuid())$q$, '42501');
select pg_temp.refused('73c ... or fence one',
$q$select public.fence_student_code_reset (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)$q$, '42501');
select pg_temp.refused('73d ... or stop its worker',
$q$select public.stop_student_code_reset_worker (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)$q$, '42501');
select pg_temp.refused('73e ... or end a student''s sessions as a reset worker',
$q$select public.end_student_sessions_fenced (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)$q$, '42501');
select pg_temp.refused('74 ... or read the reservations',
$q$select count(*) from public.student_claim_reservations$q$, '42501');
select pg_temp.as_anon();
select pg_temp.refused('75 anon cannot reserve a claim',
$q$select public.reserve_student_claim ('hash-6-new')$q$, '42501');
select pg_temp.refused('75a ... or end a student''s sessions as a reset worker',
$q$select public.end_student_sessions_fenced (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)$q$, '42501');
select pg_temp.refused('76 ... or read the reservations',
$q$select count(*) from public.student_claim_reservations$q$, '42501');

reset role;
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
