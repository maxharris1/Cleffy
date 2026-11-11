-- Behaviour proof for 20261022100200_deployment_config.sql (launch re-audit
-- BL-2): which Stripe account's subscriptions entitle is read from
-- public.deployment_config, not from a function body a replay restores.
--
--   * Unset, a test-mode and a live-mode subscription both entitle (today's
--     answer, right for every database but production) -- an Academy seat
--     under either too.
--   * With the config at {live}, a test-mode active subscription no longer
--     entitles (get_entitlements answers free, for the service role and for
--     the signed-in user alike) and neither does a seat under a test-mode
--     Academy, while the live ones do. Clearing it (null, or no row) brings
--     both back -- in the same session, which is what IMMUTABLE would not
--     have guaranteed.
--   * The table is one row, takes only a non-empty subset of {live,test},
--     has RLS on and no client grant.
--   * entitling_billing_modes() is STABLE, SECURITY DEFINER with a pinned
--     search_path, and nothing indexes on it or calls it from a constraint,
--     default or policy.
--   * Applied over a body narrowed by hand -- production's
--     `select array['live']` -- the migration carries {live} into the table
--     before replacing the body; a rerun leaves an existing row alone; and
--     over the stock body it writes no row.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the migration):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/deployment_config.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
grant all on t_results to anon, authenticated, service_role;
create function pg_temp.u(n int) returns uuid language sql immutable as $f$ select ('dc0f1000-5ac0-4000-8000-00000000000' || n)::uuid $f$;
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
-- The tier the service role is told for user n.
create function pg_temp.tier(n int) returns text language sql as $f$ select public.get_entitlements (pg_temp.u(n)) ->> 'tier' $f$;
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

-- Whatever this database has configured is put aside for the proof.
delete from public.deployment_config;

-- 1 Teacher on a test-mode subscription, 2 Teacher on a live one,
-- 3 Academy owner on test with 4 seated, 5 Academy owner on live with 6 seated.
insert into auth.users (id, email) values
(pg_temp.u(1), 'test-teacher@deploycfg.test'),
(pg_temp.u(2), 'live-teacher@deploycfg.test'),
(pg_temp.u(3), 'test-owner@deploycfg.test'),
(pg_temp.u(4), 'test-seat@deploycfg.test'),
(pg_temp.u(5), 'live-owner@deploycfg.test'),
(pg_temp.u(6), 'live-seat@deploycfg.test');
insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode) values
('sub_dc_1', pg_temp.u(1), 'teacher', 'active', now() + interval '30 days', 'test'),
('sub_dc_2', pg_temp.u(2), 'teacher', 'active', now() + interval '30 days', 'live'),
('sub_dc_3', pg_temp.u(3), 'academy', 'active', now() + interval '30 days', 'test'),
('sub_dc_5', pg_temp.u(5), 'academy', 'active', now() + interval '30 days', 'live');
insert into public.studios (id, owner_id, name) values
(pg_temp.u(7), pg_temp.u(3), 'Test academy'),
(pg_temp.u(8), pg_temp.u(5), 'Live academy');
insert into public.studio_members (studio_id, user_id) values
(pg_temp.u(7), pg_temp.u(4)),
(pg_temp.u(8), pg_temp.u(6));

-- ---- unset: both accounts entitle
select pg_temp.chk('01 unset, the modes are {live,test}', $q$select public.entitling_billing_modes () = array['live', 'test']$q$);
select pg_temp.chk('02 unset, a test-mode Teacher subscription entitles', $q$select pg_temp.tier(1) = 'teacher'$q$);
select pg_temp.chk('03 ... and a live one', $q$select pg_temp.tier(2) = 'teacher'$q$);
select pg_temp.chk('04 ... and a seat under a test-mode Academy, and under a live one', $q$select pg_temp.tier(4) = 'academy' and pg_temp.tier(6) = 'academy'$q$);

-- ---- {live}: production's configuration
select pg_temp.as_service();
select pg_temp.chk('10 the service role sets the config to {live}', $q$with ins as (
    insert into public.deployment_config (id, entitling_billing_modes, updated_by) values (true, array['live'], 'proof')
    returning 1) select count(*) = 1 from ins$q$);
reset role;
select pg_temp.chk('11 the modes are now {live}, in the same session', $q$select public.entitling_billing_modes () = array['live']$q$);
select pg_temp.chk('12 a test-mode active subscription no longer entitles', $q$select pg_temp.tier(1) = 'free'$q$);
select pg_temp.chk('13 a live one still does', $q$select pg_temp.tier(2) = 'teacher'$q$);
select pg_temp.chk('14 a seat under a test-mode Academy gets nothing, one under a live Academy keeps it', $q$select pg_temp.tier(4) = 'free' and pg_temp.tier(6) = 'academy'$q$);
select pg_temp.chk('15 the Academy owners resolve the same way', $q$select pg_temp.tier(3) = 'free' and pg_temp.tier(5) = 'academy'$q$);
select pg_temp.as_user(1);
select pg_temp.chk('16 the signed-in test-mode buyer is told free by get_entitlements()', $q$select public.get_entitlements () ->> 'tier' = 'free'$q$);
reset role;
select pg_temp.as_user(2);
select pg_temp.chk('17 ... and the live buyer teacher', $q$select public.get_entitlements () ->> 'tier' = 'teacher'$q$);
reset role;
select pg_temp.chk('18 subscription_is_live() follows: false for the test row, true for the live one', $q$
    select not public.subscription_is_live (s1) and public.subscription_is_live (s2)
    from public.subscriptions s1, public.subscriptions s2
    where s1.stripe_subscription_id = 'sub_dc_1' and s2.stripe_subscription_id = 'sub_dc_2'$q$);

-- ---- cleared again
select pg_temp.as_service();
update public.deployment_config set entitling_billing_modes = null, updated_by = 'proof';
reset role;
select pg_temp.chk('20 a null column is unset: both entitle again', $q$select public.entitling_billing_modes () = array['live', 'test']
    and pg_temp.tier(1) = 'teacher' and pg_temp.tier(4) = 'academy'$q$);
select pg_temp.as_service();
update public.deployment_config set entitling_billing_modes = array['live'], updated_by = 'proof';
delete from public.deployment_config;
reset role;
select pg_temp.chk('21 no row is unset too', $q$select public.entitling_billing_modes () = array['live', 'test'] and pg_temp.tier(1) = 'teacher'$q$);

-- ---- the table
insert into public.deployment_config (id, entitling_billing_modes, updated_by) values (true, array['live'], 'proof');
select pg_temp.refused('30 it is one row: a second key is refused', $q$insert into public.deployment_config (id, entitling_billing_modes) values (false, array['live'])$q$, '23514');
select pg_temp.refused('31 ... and the one key cannot be taken twice', $q$insert into public.deployment_config (id, entitling_billing_modes) values (true, array['test'])$q$, '23505');
select pg_temp.refused('32 an empty list (nobody entitled) is refused', $q$update public.deployment_config set entitling_billing_modes = '{}'$q$, '23514');
select pg_temp.refused('33 an account name other than live or test is refused', $q$update public.deployment_config set entitling_billing_modes = array['live', 'sandbox']$q$, '23514');
select pg_temp.refused('34 a null element is refused', $q$update public.deployment_config set entitling_billing_modes = array['live', null]$q$, '23514');
select pg_temp.chk('35 RLS is on', $q$select relrowsecurity from pg_class where oid = 'public.deployment_config'::regclass$q$);

select pg_temp.as_user(1);
select pg_temp.refused('40 a signed-in user cannot read the config', $q$select count(*) from public.deployment_config$q$, '42501');
select pg_temp.refused('41 ... or change it', $q$update public.deployment_config set entitling_billing_modes = array['live', 'test']$q$, '42501');
select pg_temp.chk('42 ... and still gets their own answer from entitling_billing_modes()', $q$select public.entitling_billing_modes () = array['live']$q$);
reset role;
select pg_temp.as_anon();
select pg_temp.refused('43 anon cannot read the config', $q$select count(*) from public.deployment_config$q$, '42501');
select pg_temp.refused('44 ... or write one', $q$insert into public.deployment_config (id, entitling_billing_modes) values (true, array['test'])$q$, '42501');
reset role;

-- ---- the function
select pg_temp.chk('50 entitling_billing_modes() is STABLE, SECURITY DEFINER, search_path pinned', $q$
    select p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=public']
    from pg_proc p where p.oid = 'public.entitling_billing_modes()'::regprocedure$q$);
select pg_temp.chk('51 nothing indexes on it, or calls it from a constraint, default, policy or view', $q$
    select not exists (
        select 1 from pg_depend d
        where d.refobjid = 'public.entitling_billing_modes()'::regprocedure
          and d.classid in ('pg_class'::regclass, 'pg_constraint'::regclass, 'pg_attrdef'::regclass,
                            'pg_policy'::regclass, 'pg_rewrite'::regclass, 'pg_trigger'::regclass))
    and not exists (
        select 1 from pg_index i
        where pg_get_expr(i.indexprs, i.indrelid) ~* 'entitling_billing_modes\s*\('
           or pg_get_expr(i.indpred, i.indrelid) ~* 'entitling_billing_modes\s*\(')
    and not exists (
        select 1 from pg_policy p
        where pg_get_expr(p.polqual, p.polrelid) ~* 'entitling_billing_modes\s*\('
           or pg_get_expr(p.polwithcheck, p.polrelid) ~* 'entitling_billing_modes\s*\(')
    and not exists (select 1 from pg_constraint c where pg_get_constraintdef(c.oid) ~* 'entitling_billing_modes\s*\(')$q$);
select pg_temp.chk('52 anon cannot call it', $q$select not has_function_privilege('anon', 'public.entitling_billing_modes()', 'execute')$q$);

-- ---- applied over production's hand-narrowed body
delete from public.deployment_config;
create or replace function public.entitling_billing_modes () returns text[]
language sql immutable set search_path = public as $$
select array['live']::text[] $$;

\ir ../../supabase/migrations/20261022100200_deployment_config.sql

select pg_temp.chk('60 a hand-narrowed body is carried into the table', $q$
    select entitling_billing_modes = array['live'] and updated_by like 'migration 20261022100200%'
    from public.deployment_config$q$);
select pg_temp.chk('61 ... the body now reads it, STABLE', $q$
    select public.entitling_billing_modes () = array['live']
       and (select provolatile = 's' from pg_proc where oid = 'public.entitling_billing_modes()'::regprocedure)$q$);
select pg_temp.chk('62 ... so test mode stays out after the migration', $q$select pg_temp.tier(1) = 'free' and pg_temp.tier(2) = 'teacher'$q$);

update public.deployment_config set entitling_billing_modes = array['test'], updated_by = 'proof';
\ir ../../supabase/migrations/20261022100200_deployment_config.sql
select pg_temp.chk('63 a rerun leaves an existing row alone', $q$
    select entitling_billing_modes = array['test'] and updated_by = 'proof' from public.deployment_config$q$);

delete from public.deployment_config;
\ir ../../supabase/migrations/20261022100200_deployment_config.sql
select pg_temp.chk('64 over the stock body it writes no row', $q$select not exists (select 1 from public.deployment_config)
    and public.entitling_billing_modes () = array['live', 'test']$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
