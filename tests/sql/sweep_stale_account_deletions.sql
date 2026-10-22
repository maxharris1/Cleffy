-- sweep_stale_account_deletions() (20261022141000, decision 49(6)'s cron
-- sweep), against a real database. LOCAL STACK or the dev branch project only.
-- One transaction, ROLLED BACK; the last line is `failures | total`.
--
-- Cast, each with an account_deletions marker:
--   a  no cleanup began; its one attempt crashed (lease ran out, never ended)
--   b  no cleanup began; an attempt is live
--   c  half-deleted (destructive cleanup began); its attempt crashed
--   d  no cleanup began; its attempt ended (abandoned) but the marker stayed
--   e  half-deleted; an attempt is live (a retry finishing it)
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create temp table t_ran (k text primary key, v jsonb);
grant all on t_ran to service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('5a130000-0c13-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
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
create function pg_temp.marked(n int) returns boolean language sql as $f$
    select exists (select 1 from public.account_deletions where user_id = pg_temp.u(n)) $f$;
create function pg_temp.open_attempts(n int) returns bigint language sql as $f$
    select count(*) from public.account_deletion_attempts where user_id = pg_temp.u(n) and ended_at is null $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Whatever stale markers this database already had go first (rolled back with
-- the rest), so the counts below are this proof's own.
select public.sweep_stale_account_deletions (1000000);
create temp table t_baseline as select (public.sweep_stale_account_deletions (0) ->> 'half_deleted')::int as half_deleted;

insert into auth.users (id, email)
select pg_temp.u(n), 'sad-' || n || '@example.invalid' from generate_series(1, 5) n;
insert into public.account_deletions (user_id, started_at, destructive_started_at) values
(pg_temp.u(1), now() - interval '2 hours', null),
(pg_temp.u(2), now() - interval '2 minutes', null),
(pg_temp.u(3), now() - interval '3 hours', now() - interval '3 hours'),
(pg_temp.u(4), now() - interval '1 day', null),
(pg_temp.u(5), now() - interval '4 hours', now() - interval '4 hours');
insert into public.account_deletion_attempts (user_id, started_at, lease_until, ended_at, outcome) values
(pg_temp.u(1), now() - interval '2 hours', now() - interval '110 minutes', null, null),
(pg_temp.u(2), now() - interval '2 minutes', now() + interval '8 minutes', null, null),
(pg_temp.u(3), now() - interval '3 hours', now() - interval '170 minutes', null, null),
(pg_temp.u(4), now() - interval '1 day', now() - interval '1 day' + interval '10 minutes', now() - interval '1 day', 'abandoned'),
(pg_temp.u(5), now() - interval '1 minute', now() + interval '9 minutes', null, null);

select pg_temp.chk('01 control: b, c and e restrict their accounts; a and d do not', $q$
    select public.account_deletion_pending (pg_temp.u(2)) and public.account_deletion_pending (pg_temp.u(3))
       and public.account_deletion_pending (pg_temp.u(5))
       and not public.account_deletion_pending (pg_temp.u(1)) and not public.account_deletion_pending (pg_temp.u(4))$q$);

set local role service_role;
insert into t_ran select 'first', public.sweep_stale_account_deletions ();
reset role;

select pg_temp.chk('02 the crashed attempts (a, c) are closed as abandoned, lease_expired', $q$
    select (select (v ->> 'attempts_closed')::int = 2 from t_ran where k = 'first')
       and (select bool_and(ended_at is not null and outcome = 'abandoned' and error = 'lease_expired')
            from public.account_deletion_attempts where user_id = pg_temp.u(3))$q$);
select pg_temp.chk('03 the markers no cleanup ever touched and no attempt holds (a, d) are gone, with their attempts', $q$
    select (select (v ->> 'markers_cleared')::int = 2 from t_ran where k = 'first')
       and not pg_temp.marked(1) and not pg_temp.marked(4)
       and not exists (select 1 from public.account_deletion_attempts where user_id in (pg_temp.u(1), pg_temp.u(4)))$q$);
select pg_temp.chk('04 b''s live attempt and its marker are untouched', $q$
    select pg_temp.marked(2) and pg_temp.open_attempts(2) = 1 and public.account_deletion_pending (pg_temp.u(2))$q$);
select pg_temp.chk('05 the half-deleted c is kept, still restricted, and reported (oldest without a live attempt)', $q$
    select pg_temp.marked(3) and public.account_deletion_pending (pg_temp.u(3))
       and (select (v ->> 'half_deleted')::int = (select half_deleted from t_baseline) + 1
                   and v ->> 'oldest_half_deleted' is not null from t_ran where k = 'first')$q$);
select pg_temp.chk('06 the half-deleted e, with a live attempt finishing it, is untouched and not reported', $q$
    select pg_temp.marked(5) and pg_temp.open_attempts(5) = 1 and public.account_deletion_pending (pg_temp.u(5))$q$);

set local role service_role;
insert into t_ran select 'again', public.sweep_stale_account_deletions ();
reset role;
select pg_temp.chk('07 idempotent: a second run closes and clears nothing', $q$
    select (v ->> 'attempts_closed')::int = 0 and (v ->> 'markers_cleared')::int = 0 from t_ran where k = 'again'$q$);

-- b's attempt crashes too: the next run clears its marker as well.
update public.account_deletion_attempts set lease_until = now() - interval '1 second' where user_id = pg_temp.u(2);
set local role service_role;
insert into t_ran select 'later', public.sweep_stale_account_deletions ();
reset role;
select pg_temp.chk('08 once b''s attempt has crashed as well, the next run closes it and clears b', $q$
    select (v ->> 'attempts_closed')::int = 1 and (v ->> 'markers_cleared')::int = 1 and not pg_temp.marked(2)
    from t_ran where k = 'later'$q$);

set local role authenticated;
select pg_temp.refused('09 no client may run it', $q$select public.sweep_stale_account_deletions ()$q$, '42501');
reset role;
select pg_temp.chk('10 it is the service role''s alone', $q$
    select has_function_privilege('service_role', 'public.sweep_stale_account_deletions(integer)', 'execute')
       and not has_function_privilege('anon', 'public.sweep_stale_account_deletions(integer)', 'execute')
       and not has_function_privilege('authenticated', 'public.sweep_stale_account_deletions(integer)', 'execute')$q$);

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
