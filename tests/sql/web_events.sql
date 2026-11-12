-- Behaviour proof for 20261112120000_web_events.sql: first-party web_events,
-- signup_attribution, the record_web_events RPC, the sign-up attribution
-- trigger on auth.users and the 13-month retention job.
--
-- Roster students, guests (anonymous accounts) and anonymous JWTs are kept out
-- server-side; nobody but the service role can read or write either table
-- directly; a bad campaign tag never blocks a sign-up.
--
-- The GoTrue-shaped inserts (checks 38-39) go over dblink as
-- supabase_auth_admin, as in tests/sql/age_gate_admin_backstop.sql: that
-- session is its own transaction, begun and rolled back here. Pass
-- -v peer_password=... for a stack whose password is not `postgres`.
--
-- One transaction, ROLLED BACK. psql only (it `\ir`s the migration):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/web_events.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
\if :{?peer_password}
\else
\set peer_password postgres
\endif
\o /dev/null
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;

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

-- Runs p_sql and records whether it raised nothing.
create function pg_temp.runs(p_name text, p_sql text) returns void language plpgsql as $f$
begin
execute p_sql;
insert into t_results values (p_name, true, null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;

create function pg_temp.u(n int) returns uuid language sql immutable as $f$
select ('e7e70000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
create function pg_temp.k(n int) returns uuid language sql immutable as $f$
select ('5e550000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;

-- Acting as a caller: the claims PostgREST would set from the JWT, and its role.
create function pg_temp.as_anon() returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
perform set_config('role', 'anon', true);
end $f$;
create function pg_temp.as_jwt(p_claims jsonb) returns void language plpgsql as $f$
begin
perform set_config('request.jwt.claims', (p_claims || '{"role":"authenticated"}')::text, true);
perform set_config('role', 'authenticated', true);
end $f$;
-- A registered teacher's JWT, a guest's (signInAnonymously), and a roster student's.
create function pg_temp.as_teacher(n int) returns void language sql as $f$
select pg_temp.as_jwt(jsonb_build_object('sub', pg_temp.u(n), 'is_anonymous', false,
    'app_metadata', jsonb_build_object('provider', 'email')))
$f$;
create function pg_temp.as_guest(n int) returns void language sql as $f$
select pg_temp.as_jwt(jsonb_build_object('sub', pg_temp.u(n), 'is_anonymous', true,
    'app_metadata', jsonb_build_object('provider', 'anonymous')))
$f$;
create function pg_temp.as_student(n int) returns void language sql as $f$
select pg_temp.as_jwt(jsonb_build_object('sub', pg_temp.u(n), 'is_anonymous', false,
    'app_metadata', jsonb_build_object('provider', 'email', 'user_type', 'student')))
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- One valid event, with p_extra merged in.
create function pg_temp.ev(p_key uuid, p_extra jsonb default '{}') returns jsonb language sql immutable as $f$
select jsonb_build_object('event', 'demo_visit', 'path', '/try', 'session_key', p_key,
    'utm_source', 'newsletter', 'utm_medium', 'email', 'utm_campaign', 'launch_v1',
    'utm_content', 'hero_a', 'utm_term', 'sight-reading', 'referrer_host', 'mail.example.com',
    'device_class', 'mobile') || p_extra
$f$;
create function pg_temp.rows_for(p_key uuid) returns bigint language sql as $f$
select count(*) from public.web_events where session_key = p_key
$f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- 1 a teacher, 2 a guest, 3 a roster student, 4 a student whose JWT predates
-- the flag (the database row is what says so), 5 a guest likewise.
insert into auth.users (id, aud, role, email, is_anonymous, raw_app_meta_data) values
(pg_temp.u(1), 'authenticated', 'authenticated', 'we-teacher@example.invalid', false, '{"provider":"email"}'),
(pg_temp.u(2), 'authenticated', 'authenticated', null, true, '{"provider":"anonymous"}'),
(pg_temp.u(3), 'authenticated', 'authenticated', 'we-student@example.invalid', false, '{"provider":"email","user_type":"student"}'),
(pg_temp.u(4), 'authenticated', 'authenticated', 'we-student2@example.invalid', false, '{"provider":"email","user_type":"student"}'),
(pg_temp.u(5), 'authenticated', 'authenticated', null, true, '{"provider":"anonymous"}');

-- ---- the shape: RLS on, no policy, nothing for the client roles
select pg_temp.chk('01 both tables have RLS on and no policy at all', $q$
    select bool_and(c.relrowsecurity) and not exists (
        select 1 from pg_policy p where p.polrelid in ('public.web_events'::regclass, 'public.signup_attribution'::regclass))
    from pg_class c where c.oid in ('public.web_events'::regclass, 'public.signup_attribution'::regclass)$q$);
select pg_temp.chk('02 anon and authenticated hold no privilege on either table; the service role holds all four', $q$
    select bool_and(not has_any_column_privilege(r, t, 'SELECT, INSERT, UPDATE, REFERENCES')
                    and not has_table_privilege(r, t, 'DELETE, TRUNCATE, TRIGGER'))
       and bool_and(has_table_privilege('service_role', t, 'SELECT, INSERT, UPDATE, DELETE'))
    from unnest(array['anon', 'authenticated', 'public']) r,
         unnest(array['public.web_events'::regclass, 'public.signup_attribution'::regclass]) t$q$);

select pg_temp.as_anon();
select pg_temp.refused('03 anon cannot select web_events', $q$select count(*) from public.web_events$q$, '42501');
select pg_temp.refused('04 anon cannot insert into web_events', $q$insert into public.web_events (event, session_key) values ('page_view', gen_random_uuid())$q$, '42501');
select pg_temp.refused('05 anon cannot select signup_attribution', $q$select count(*) from public.signup_attribution$q$, '42501');
select pg_temp.as_teacher(1);
select pg_temp.refused('06 authenticated cannot select web_events', $q$select count(*) from public.web_events$q$, '42501');
select pg_temp.refused('07 authenticated cannot insert into web_events', $q$insert into public.web_events (event, session_key, user_id) values ('page_view', gen_random_uuid(), auth.uid())$q$, '42501');
select pg_temp.refused('08 authenticated cannot select signup_attribution', $q$select count(*) from public.signup_attribution$q$, '42501');
select pg_temp.refused('09 authenticated cannot insert into signup_attribution', $q$insert into public.signup_attribution (user_id, utm_campaign) values (auth.uid(), 'x')$q$, '42501');
reset role;

select pg_temp.chk('10 record_web_events: definer, empty search_path, anon and authenticated only', $q$
    select p.prosecdef and p.proconfig = array['search_path=""']
       and has_function_privilege('anon', p.oid, 'execute')
       and has_function_privilege('authenticated', p.oid, 'execute')
       and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
    from pg_proc p where p.oid = 'public.record_web_events(jsonb)'::regprocedure$q$);

-- ---- the RPC accepts valid events, user_id only from auth.uid()
select pg_temp.as_anon();
select pg_temp.runs('11 anon records a valid batch of two', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(1)),
        pg_temp.ev(pg_temp.k(1), '{"event":"page_view","path":"/join/:token","utm_term":null}')))$q$);
reset role;
select pg_temp.chk('12 ... both stored, with no user_id and every field as sent', $q$
    select count(*) = 2
       and bool_and(user_id is null)
       and bool_and(utm_campaign = 'launch_v1' and utm_content = 'hero_a' and device_class = 'mobile'
                    and referrer_host = 'mail.example.com' and occurred_at = now())
       and count(*) filter (where event = 'page_view' and path = '/join/:token' and utm_term is null) = 1
    from public.web_events where session_key = pg_temp.k(1)$q$);

select pg_temp.as_teacher(1);
select pg_temp.runs('13 a registered teacher records an event', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(2), '{"event":"signup_completed"}')))$q$);
reset role;
select pg_temp.chk('14 ... stored with user_id = auth.uid()', $q$
    select count(*) = 1 and bool_and(user_id = pg_temp.u(1))
    from public.web_events where session_key = pg_temp.k(2)$q$);

select pg_temp.as_teacher(1);
select pg_temp.refused('15 a client-sent user_id is refused, not trusted', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3),
        jsonb_build_object('user_id', pg_temp.u(3)))))$q$, '22023');
select pg_temp.refused('16 a client-sent occurred_at is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"occurred_at":"2020-01-01T00:00:00Z"}')))$q$, '22023');

-- ---- bad input is refused, and a refused batch writes nothing
select pg_temp.as_anon();
select pg_temp.refused('20 a utm with a space is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"utm_campaign":"launch v1"}')))$q$, '22023');
select pg_temp.refused('21 a utm over 100 characters is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3),
        jsonb_build_object('utm_source', repeat('a', 101)))))$q$, '22023');
select pg_temp.refused('22 a utm that is not a string is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"utm_source":7}')))$q$, '22023');
select pg_temp.refused('23 an unknown event name is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"event":"purchase"}')))$q$, '22023');
select pg_temp.refused('24 a batch of 21 is refused', $q$
    select public.record_web_events((select jsonb_agg(pg_temp.ev(pg_temp.k(3))) from generate_series(1, 21)))$q$, '22023');
select pg_temp.refused('25 something other than an array is refused', $q$
    select public.record_web_events(pg_temp.ev(pg_temp.k(3)))$q$, '22023');
select pg_temp.refused('26 a path with a query string is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"path":"/try?utm_source=x"}')))$q$, '22023');
select pg_temp.refused('27 a path over 200 characters is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3),
        jsonb_build_object('path', '/' || repeat('a', 200)))))$q$, '22023');
select pg_temp.refused('28 a device class outside the three is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"device_class":"Mozilla/5.0"}')))$q$, '22023');
select pg_temp.refused('29 a referrer that is a full URL, not a host, is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3), '{"referrer_host":"https://mail.example.com/x?u=1"}')))$q$, '22023');
select pg_temp.refused('30 an event with no session_key is refused', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3)) - 'session_key'))$q$, '22023');
select pg_temp.refused('31 a batch with one bad event among good ones is refused whole', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(3)), pg_temp.ev(pg_temp.k(3), '{"utm_term":"a b"}')))$q$, '22023');
reset role;
select pg_temp.chk('32 ... and none of the refused batches wrote a row', $q$select pg_temp.rows_for(pg_temp.k(3)) = 0$q$);

-- ---- guests, roster students and anonymous JWTs are dropped
select pg_temp.as_guest(2);
select pg_temp.runs('40 a guest''s (anonymous JWT) batch raises nothing', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(4)), pg_temp.ev(pg_temp.k(4))))$q$);
select pg_temp.as_student(3);
select pg_temp.runs('41 a roster student''s batch raises nothing', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(5))))$q$);
-- JWTs without the flags: the auth.users row still says student / anonymous.
select pg_temp.as_teacher(4);
select pg_temp.runs('42 a student whose JWT lacks user_type raises nothing', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(6))))$q$);
select pg_temp.as_teacher(5);
select pg_temp.runs('43 a guest whose JWT lacks is_anonymous raises nothing', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(7))))$q$);
-- The flag alone, with no auth.users row behind it, is enough.
select pg_temp.as_jwt(jsonb_build_object('sub', gen_random_uuid(), 'is_anonymous', true));
select pg_temp.runs('44 an anonymous JWT for no known user raises nothing', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(8))))$q$);
reset role;
select pg_temp.chk('45 ... and every one of those events was dropped', $q$
    select pg_temp.rows_for(pg_temp.k(4)) + pg_temp.rows_for(pg_temp.k(5)) + pg_temp.rows_for(pg_temp.k(6))
         + pg_temp.rows_for(pg_temp.k(7)) + pg_temp.rows_for(pg_temp.k(8)) = 0
       and not exists (select 1 from public.web_events where user_id in (pg_temp.u(2), pg_temp.u(3), pg_temp.u(4), pg_temp.u(5)))$q$);

-- ---- 500 rows per session_key per day
insert into public.web_events (event, path, session_key, occurred_at)
select 'page_view', '/', pg_temp.k(9), now() - interval '1 hour' from generate_series(1, 499);
insert into public.web_events (event, path, session_key, occurred_at)
select 'page_view', '/', pg_temp.k(10), now() - interval '25 hours' from generate_series(1, 500);
select pg_temp.as_anon();
select pg_temp.runs('50 a session at 499 today sends three', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(9)), pg_temp.ev(pg_temp.k(9)), pg_temp.ev(pg_temp.k(9))))$q$);
select pg_temp.runs('51 a session whose 500 are all older than a day sends one', $q$
    select public.record_web_events(jsonb_build_array(pg_temp.ev(pg_temp.k(10))))$q$);
reset role;
select pg_temp.chk('52 ... the first stops at 500, the second is not capped', $q$
    select pg_temp.rows_for(pg_temp.k(9)) = 500 and pg_temp.rows_for(pg_temp.k(10)) = 501$q$);

-- ---- the sign-up trigger
select pg_temp.chk('60 the trigger is an enabled AFTER INSERT ROW trigger on auth.users', $q$
    select t.tgenabled = 'O' and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 4) = 4
    from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and t.tgname = 'record_signup_attribution' and not t.tgisinternal$q$);
select pg_temp.chk('61 clients cannot call the trigger function', $q$
    select not has_function_privilege('anon', 'public.record_signup_attribution()', 'execute')
       and not has_function_privilege('authenticated', 'public.record_signup_attribution()', 'execute')
       and not has_function_privilege('service_role', 'public.record_signup_attribution()', 'execute')$q$);

insert into auth.users (id, aud, role, email, raw_user_meta_data) values
(pg_temp.u(20), 'authenticated', 'authenticated', 'we-signup@example.invalid',
 '{"age_gate":{"country":"US","min_age":13},"attribution":{"utm_source":"newsletter","utm_medium":"email","utm_campaign":"launch_v1","utm_content":"hero_a","utm_term":"sight-reading","landing_path":"/try","first_seen_at":"2026-11-01T10:00:00.000Z"}}');
select pg_temp.chk('62 a sign-up carrying attribution gets its row', $q$
    select count(*) = 1 and bool_and(utm_source = 'newsletter' and utm_medium = 'email' and utm_campaign = 'launch_v1'
        and utm_content = 'hero_a' and utm_term = 'sight-reading' and landing_path = '/try'
        and first_seen_at = '2026-11-01T10:00:00Z'::timestamptz)
    from public.signup_attribution where user_id = pg_temp.u(20)$q$);

select pg_temp.runs('63 a roster student carrying attribution is created', $q$
    insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
    (pg_temp.u(21), 'authenticated', 'authenticated', 'we-st@example.invalid', '{"user_type":"student"}',
     '{"attribution":{"utm_campaign":"launch_v1"}}')$q$);
select pg_temp.runs('64 a guest carrying attribution is created', $q$
    insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data) values
    (pg_temp.u(22), 'authenticated', 'authenticated', null, true, '{"attribution":{"utm_campaign":"launch_v1"}}')$q$);
select pg_temp.chk('65 ... and neither gets an attribution row', $q$
    select not exists (select 1 from public.signup_attribution where user_id in (pg_temp.u(21), pg_temp.u(22)))$q$);

select pg_temp.runs('66 a sign-up with some bad tags is created', $q$
    insert into auth.users (id, aud, role, email, raw_user_meta_data) values
    (pg_temp.u(23), 'authenticated', 'authenticated', 'we-bad@example.invalid',
     jsonb_build_object('attribution', jsonb_build_object('utm_source', 'bad value!', 'utm_medium', 7,
        'utm_campaign', 'launch_v1', 'utm_content', repeat('x', 101),
        'landing_path', '/join/abc?token=1', 'first_seen_at', 'not a date', 'extra', 'ignored')))$q$);
select pg_temp.chk('67 ... keeping only the valid tag, and nothing else', $q$
    select count(*) = 1 and bool_and(utm_campaign = 'launch_v1' and utm_source is null and utm_medium is null
        and utm_content is null and utm_term is null and landing_path is null and first_seen_at is null)
    from public.signup_attribution where user_id = pg_temp.u(23)$q$);

select pg_temp.runs('68 sign-ups whose attribution is a string, has no valid tag, or a future first_seen_at are created', $q$
    insert into auth.users (id, aud, role, email, raw_user_meta_data) values
    (pg_temp.u(24), 'authenticated', 'authenticated', 'we-str@example.invalid', '{"attribution":"launch_v1"}'),
    (pg_temp.u(25), 'authenticated', 'authenticated', 'we-none@example.invalid', '{"attribution":{"utm_campaign":"a b","landing_path":"/try"}}'),
    (pg_temp.u(26), 'authenticated', 'authenticated', 'we-future@example.invalid', '{"attribution":{"utm_campaign":"launch_v1","first_seen_at":"2999-01-01T00:00:00Z"}}'),
    (pg_temp.u(27), 'authenticated', 'authenticated', 'we-plain@example.invalid', '{"age_gate":{"country":"US","min_age":13}}')$q$);
select pg_temp.chk('69 ... the first two and the one with none get no row; the future date is dropped, the tag kept', $q$
    select not exists (select 1 from public.signup_attribution where user_id in (pg_temp.u(24), pg_temp.u(25), pg_temp.u(27)))
       and (select first_seen_at is null and utm_campaign = 'launch_v1' from public.signup_attribution where user_id = pg_temp.u(26))$q$);

-- ---- GoTrue's role: a sign-up with good or bad attribution is never blocked
create extension if not exists dblink with schema extensions;
select set_config('we.peer_password', :'peer_password', true);
create function pg_temp.gotrue_conn() returns text language sql as $f$
    select format('host=%s port=%s dbname=%s user=supabase_auth_admin password=%s',
        coalesce(nullif(host(inet_server_addr()), '127.0.0.1'), 'supabase_db_cleffy'),
        coalesce(inet_server_port(), 5432),
        current_database(),
        current_setting('we.peer_password'))
$f$;
select extensions.dblink_connect('gotrue', pg_temp.gotrue_conn());
select extensions.dblink_exec('gotrue', 'begin');
select pg_temp.chk('38 gotrue inserts a self sign-up carrying attribution', $q$
    select extensions.dblink_exec('gotrue', $i$
        insert into auth.users (id, aud, role, email, raw_user_meta_data)
        values ('e7e70000-0000-4000-8000-000000000038', 'authenticated', 'authenticated', 'we-gt@example.invalid',
                '{"age_gate":{"country":"US","min_age":13,"source":"self","v":1},"attribution":{"utm_campaign":"launch_v1"}}')
    $i$, false) = 'INSERT 0 1'$q$);
select pg_temp.chk('39 gotrue inserts a self sign-up whose attribution is garbage', $q$
    select extensions.dblink_exec('gotrue', $i$
        insert into auth.users (id, aud, role, email, raw_user_meta_data)
        values ('e7e70000-0000-4000-8000-000000000039', 'authenticated', 'authenticated', 'we-gt2@example.invalid',
                '{"age_gate":{"country":"US","min_age":13,"source":"self","v":1},"attribution":{"utm_campaign":["x"],"first_seen_at":{}}}')
    $i$, false) = 'INSERT 0 1'$q$);
select extensions.dblink_exec('gotrue', 'rollback');
select extensions.dblink_disconnect('gotrue');

-- ---- deleting the user cascades
select pg_temp.chk('70 before: the teacher and the sign-up have rows', $q$
    select exists (select 1 from public.web_events where user_id = pg_temp.u(1))
       and exists (select 1 from public.signup_attribution where user_id = pg_temp.u(20))$q$);
insert into public.web_events (event, path, session_key, user_id) values ('page_view', '/library', pg_temp.k(11), pg_temp.u(20));
delete from auth.users where id in (pg_temp.u(1), pg_temp.u(20));
select pg_temp.chk('71 deleting the accounts deletes their events and attribution', $q$
    select not exists (select 1 from public.web_events where user_id in (pg_temp.u(1), pg_temp.u(20)))
       and not exists (select 1 from public.signup_attribution where user_id = pg_temp.u(20))
       and pg_temp.rows_for(pg_temp.k(1)) = 2$q$);

-- ---- 13-month retention
select pg_temp.chk('80 a daily pg_cron job runs the purge', $q$
    select count(*) = 1 and bool_and(command = 'select public.retention_purge_web_events ()' and schedule ~ '^[0-9]+ [0-9]+ \* \* \*$')
    from cron.job where jobname = 'retention-web-events'$q$);
select pg_temp.chk('81 clients cannot run the purge', $q$
    select not has_function_privilege('anon', 'public.retention_purge_web_events(interval)', 'execute')
       and not has_function_privilege('authenticated', 'public.retention_purge_web_events(interval)', 'execute')$q$);
insert into public.web_events (event, path, session_key, occurred_at) values
('page_view', '/', pg_temp.k(12), now() - interval '13 months 1 day'),
('page_view', '/', pg_temp.k(13), now() - interval '12 months 27 days');
select pg_temp.chk('82 the purge deletes events older than 13 months and keeps younger ones', $q$
    select public.retention_purge_web_events() >= 1
       and pg_temp.rows_for(pg_temp.k(12)) = 0 and pg_temp.rows_for(pg_temp.k(13)) = 1
       and pg_temp.rows_for(pg_temp.k(9)) = 500$q$);

-- ---- rerunnable
\ir ../../supabase/migrations/20261112120000_web_events.sql
select pg_temp.chk('90 the migration reruns cleanly: one trigger, one job, the rows kept', $q$
    select (select count(*) = 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'record_signup_attribution')
       and (select count(*) = 1 from cron.job where jobname = 'retention-web-events')
       and pg_temp.rows_for(pg_temp.k(9)) = 500
       and exists (select 1 from public.signup_attribution where user_id = pg_temp.u(23))$q$);

\o
select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
