-- content_strikes' grants (launch-fix follow-up 13), against a real database.
-- LOCAL STACK or the dev branch project only. One transaction, ROLLED BACK;
-- the last line is `failures | total`.
--
-- 20261020150000 created content_strikes revoking every client privilege;
-- launchfix P1 (20261022100000, BL-3) gave service_role an explicit grant
-- instead of the default ACL, and 20261022130100 added columns and functions
-- relying on it ("launchfix P1 grants content_strikes explicitly"). Checked
-- here, all of it: the table's ACL names postgres and service_role only;
-- anon, authenticated and PUBLIC hold no privilege of any kind on the table or
-- on any of its columns, the later ones included, and no policy would admit
-- them anyway; the strike functions are the service role's, and the pepper
-- and key helpers (which read the Vault secret) nobody's but their owner's.
-- The audit found no gap; this keeps it that way. That a migration names
-- service_role in a grant (not only the default ACL) is checked statically by
-- tests/security/explicitServiceRoleGrants.test.ts.
\set ON_ERROR_STOP on
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
grant execute on all functions in schema pg_temp to anon, authenticated, service_role;

select pg_temp.chk('01 the table''s ACL names exactly postgres and service_role', $q$
    select (select array_agg(distinct g order by g)
            from (select (aclexplode(c.relacl)).grantee::regrole::text as g
                  from pg_class c where c.oid = 'public.content_strikes'::regclass) a) = array['postgres', 'service_role']$q$);
select pg_temp.chk('02 service_role reads and writes it', $q$
    select bool_and(has_table_privilege('service_role', 'public.content_strikes', p))
    from unnest(array['select', 'insert', 'update', 'delete']) p$q$);
select pg_temp.chk('03 anon, authenticated and PUBLIC hold no table privilege of any kind', $q$
    select not bool_or(has_table_privilege(r, 'public.content_strikes', p))
    from unnest(array['anon', 'authenticated', 'public']) r,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p$q$);
select pg_temp.chk('04 ... nor any column privilege, on every column (subject_key and subject_key_version included)', $q$
    select not bool_or(has_column_privilege(r, 'public.content_strikes', a.attname, p))
       and bool_or(a.attname = 'subject_key') and bool_or(a.attname = 'subject_key_version')
    from pg_attribute a,
         unnest(array['anon', 'authenticated', 'public']) r,
         unnest(array['select', 'insert', 'update', 'references']) p
    where a.attrelid = 'public.content_strikes'::regclass and a.attnum > 0 and not a.attisdropped$q$);
select pg_temp.chk('05 RLS is on, with no policy for any client role', $q$
    select (select relrowsecurity from pg_class where oid = 'public.content_strikes'::regclass)
       and not exists (select 1 from pg_policy where polrelid = 'public.content_strikes'::regclass)$q$);
select pg_temp.chk('06 the strike functions are service_role''s, no client''s', $q$
    select bool_and(has_function_privilege('service_role', f, 'execute')
                    and not has_function_privilege('anon', f, 'execute')
                    and not has_function_privilege('authenticated', f, 'execute'))
    from unnest(array['public.active_content_strikes(uuid)', 'public.retention_purge_content_strikes(interval, integer)']) f$q$);
select pg_temp.chk('07 the pepper and key helpers (the Vault secret) are their owner''s alone, not even service_role''s', $q$
    select bool_and(not has_function_privilege(r, f, 'execute'))
    from unnest(array['public.content_strike_pepper(smallint)', 'public.content_strike_subject_key(text, smallint)']) f,
         unnest(array['service_role', 'anon', 'authenticated']) r$q$);
select pg_temp.chk('08 the trigger functions are no client''s', $q$
    select bool_and(not has_function_privilege(r, f, 'execute'))
    from unnest(array['public.content_strikes_set_subject_key()', 'public.content_strikes_key_on_account_delete()']) f,
         unnest(array['anon', 'authenticated']) r$q$);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
select pg_temp.refused('09 a signed-in client reading strikes is refused', $q$select count(*) from public.content_strikes$q$, '42501');
select pg_temp.refused('10 ... and writing one', $q$
    insert into public.content_strikes (user_id, takedown_id) values (gen_random_uuid(), gen_random_uuid())$q$, '42501');
reset role;
set local role anon;
select pg_temp.refused('11 so is anon', $q$select count(*) from public.content_strikes$q$, '42501');
reset role;

select name, ok, coalesce(detail, '') from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
