-- The email reset is fenced like the code reset (20261022140800), against a
-- real database. LOCAL STACK or the dev branch project only. One transaction,
-- ROLLED BACK; the last line is `failures | total`.
--
-- student-provision now runs an email-method student's reset through the code
-- reset's reservation, worker lease and fences (reserve_student_code_reset,
-- fence_student_code_reset, end_student_sessions_fenced), and ends it with
-- complete_student_email_reset(): this proves those calls on an email row. A
-- second reset meanwhile is busy; a stale worker (fenced out by a newer lease)
-- can neither revoke sessions nor complete; the current one completes, which
-- drops the reservation and sends the student back to Invited; a code row is
-- refused, so its old card can never be released without a new one.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_lease (k text primary key, v jsonb);
grant all on t_lease to service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a110000-0c11-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.r(n int) returns uuid language sql immutable as $f$ select ('5a11e000-0c11-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
create function pg_temp.lease(k text) returns jsonb language sql as $f$ select v from t_lease where k = k $f$;
create function pg_temp.complete(k text) returns text language sql as $f$
    select public.complete_student_email_reset (pg_temp.r(2), (v ->> 'reservation')::uuid, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
    from t_lease l where l.k = complete.k $f$;
create function pg_temp.fence(k text) returns text language sql as $f$
    select public.fence_student_code_reset (pg_temp.r(2), (v ->> 'reservation')::uuid, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
    from t_lease l where l.k = fence.k $f$;
create function pg_temp.sessions(k text) returns int language sql as $f$
    select public.end_student_sessions_fenced (pg_temp.r(2), (v ->> 'reservation')::uuid, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
    from t_lease l where l.k = sessions.k $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Teacher 1; 2 an email-method student who has accepted their invite; 3 a code student.
insert into auth.users (id, email, raw_app_meta_data) values
(pg_temp.u(1), 'erf-teacher@example.invalid', '{}'),
(pg_temp.u(2), 'erf-student@example.invalid', jsonb_build_object('user_type', 'student', 'teacher_id', pg_temp.u(1))),
(pg_temp.u(3), 'erf-code@students.cleffy.app', jsonb_build_object('user_type', 'student', 'teacher_id', pg_temp.u(1)));
insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, student_email, claimed_at) values
(pg_temp.r(2), pg_temp.u(1), pg_temp.u(2), 'Email student', null, 'email', 'erf-student@example.invalid', now() - interval '1 day'),
(pg_temp.r(3), pg_temp.u(1), pg_temp.u(3), 'Code student', 'hash-erf-3', 'code', null, null);

select pg_temp.as_service();
insert into t_lease values ('a', public.reserve_student_code_reset (pg_temp.r(2)));
select pg_temp.chk('01 an email student''s reset takes the reservation and a worker lease', $q$
    select (select v ->> 'status' = 'reserved' and v ? 'worker' and v ? 'epoch' from t_lease where k = 'a')$q$);
select pg_temp.chk('02 a second reset meanwhile is busy: it is told the first is still finishing', $q$
    select public.reserve_student_code_reset (pg_temp.r(2)) ->> 'status' = 'busy'$q$);
select pg_temp.chk('03 the fence before the password write lets the current worker through', $q$
    select pg_temp.fence('a') = 'ok'$q$);

-- A retry of the same reset (its token), once the first worker reported back,
-- takes a newer lease: the first worker is fenced out from here.
select public.stop_student_code_reset_worker (pg_temp.r(2), (v ->> 'reservation')::uuid, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
from t_lease where k = 'a';
insert into t_lease select 'b', public.reserve_student_code_reset (pg_temp.r(2), (v ->> 'reservation')::uuid) from t_lease where k = 'a';
select pg_temp.chk('04 the retry resumes the reset with a newer lease', $q$
    select (select v ->> 'status' = 'reserved' and v ->> 'reservation' = (select v ->> 'reservation' from t_lease where k = 'a')
            and v ->> 'worker' <> (select v ->> 'worker' from t_lease where k = 'a') from t_lease where k = 'b')$q$);
select pg_temp.chk('05 the stale worker''s fence, session revocation and completion all do nothing', $q$
    select pg_temp.fence('a') = 'lost' and pg_temp.sessions('a') is null and pg_temp.complete('a') = 'lost'
       and exists (select 1 from public.student_claim_reservations where student_id = pg_temp.r(2))$q$);
select pg_temp.chk('06 the current worker passes its fences and ends the sessions', $q$
    select pg_temp.fence('b') = 'ok' and pg_temp.sessions('b') is not null$q$);
insert into t_lease select 'b_done', to_jsonb(pg_temp.complete('b'));
select pg_temp.chk('07 its completion drops the reservation and sends the student back to Invited', $q$
    select (select v = '"reset"'::jsonb from t_lease where k = 'b_done')
       and not exists (select 1 from public.student_claim_reservations where student_id = pg_temp.r(2))
       and (select claimed_at is null from public.managed_students where id = pg_temp.r(2))$q$);
select pg_temp.chk('08 a late completion of the same lease does nothing more', $q$
    select pg_temp.complete('b') = 'lost'$q$);

-- A code row is never completed this way.
insert into t_lease select 'c', public.reserve_student_code_reset (pg_temp.r(3));
select pg_temp.refused('09 a code student''s reset cannot end without a new card (22023)', $q$
    select public.complete_student_email_reset (pg_temp.r(3), (v ->> 'reservation')::uuid, (v ->> 'worker')::uuid, (v ->> 'epoch')::bigint)
    from t_lease where k = 'c'$q$, '22023');
select pg_temp.chk('10 ... and its reservation and card are untouched', $q$
    select exists (select 1 from public.student_claim_reservations where student_id = pg_temp.r(3))
       and (select login_code_hash = 'hash-erf-3' from public.managed_students where id = pg_temp.r(3))$q$);
reset role;

set local role authenticated;
select pg_temp.refused('11 no client may complete a reset', $q$
    select public.complete_student_email_reset (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)$q$, '42501');
reset role;
select pg_temp.chk('12 it is the service role''s alone', $q$
    select has_function_privilege('service_role', 'public.complete_student_email_reset(uuid, uuid, uuid, bigint)', 'execute')
       and not has_function_privilege('authenticated', 'public.complete_student_email_reset(uuid, uuid, uuid, bigint)', 'execute')
       and not has_function_privilege('anon', 'public.complete_student_email_reset(uuid, uuid, uuid, bigint)', 'execute')$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
