-- Behaviour proof for 20261022100000_explicit_service_role_grants.sql (launch
-- re-audit BL-3) and 20261022100100_billing_lock_tables_client_revoke.sql
-- (decision 20): every public table's grants, for every role the API uses.
--
--   * service_role holds SELECT on every public table, and SELECT, INSERT,
--     UPDATE and DELETE on all but five whose narrowing is deliberate (their
--     writes go through definer functions); the narrowed five are pinned.
--   * anon and authenticated hold exactly the pinned list below, column
--     grants included -- a privilege added or lost anywhere fails here. It is
--     20261022100700_client_table_privileges.sql's reduced set (Codex round 1
--     on #69, MAJOR 4): no TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
--     public table, nothing at all for anon, nothing for either client on
--     omr_jobs, score_cache, imslp_category_sync and imslp_file_licenses, and
--     no client privilege an RLS policy does not let that role use.
--   * A table created now gives anon and authenticated nothing: the default
--     ACL for `postgres` in `public` no longer grants them anything.
--   * With no default grants (the default ACL for `postgres` in `public`
--     revoked in this transaction, as Supabase's announced change would leave a
--     fresh project), the fifteen tables BL-3 names, stripped of what the
--     default ACL gave the service role, get it back from the migration alone
--     -- and the client roles' grants come out of it unchanged.
--
-- Pinned against the local stack (supabase CLI 2.121.0, Postgres 17.11.0.004
-- -- the image CI runs). A hosted project's default ACL may differ (it can only
-- have given less), so run this against the local stack.
--
-- Runs in one transaction and ROLLS BACK. psql only (it `\ir`s the migration):
--
--     psql "$DATABASE_URL" -q -t -A -F ' | ' -f tests/sql/explicit_grants.sql
--
-- Every row should read `t`; the last line is `failures | total`.
\set ON_ERROR_STOP on
begin;
create temp table t_results (name text, ok boolean, detail text);
create function pg_temp.chk(p_name text, p_sql text) returns void language plpgsql as $f$
declare v boolean;
begin execute p_sql into v; insert into t_results values (p_name, coalesce(v, false), null);
exception when others then insert into t_results values (p_name, false, sqlstate || ' ' || sqlerrm); end $f$;
-- Fails with the differing rows as its detail.
create function pg_temp.same(p_name text, p_actual text, p_expected text) returns void language plpgsql as $f$
declare v_extra text; v_missing text;
begin
execute format('select string_agg(x::text, E''\n'') from ((%s) except (%s)) x', p_actual, p_expected) into v_extra;
execute format('select string_agg(x::text, E''\n'') from ((%s) except (%s)) x', p_expected, p_actual) into v_missing;
insert into t_results values (p_name, v_extra is null and v_missing is null,
    nullif(concat_ws(' ', 'unexpected: ' || v_extra, 'missing: ' || v_missing), ''));
end $f$;

-- Every table privilege a client role holds -- SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER and (PostgreSQL 17+) MAINTAIN -- with the
-- columns where only some are granted: `INSERT(id,name,owner_id)`.
create function pg_temp.privs() returns text[] language sql stable as $f$
select array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    || case when current_setting('server_version_num')::int >= 170000 then array['MAINTAIN'] else array[]::text[] end
$f$;
create function pg_temp.client_acl() returns table (tbl text, role text, privs text) language sql stable as $f$
with t as (
    select c.oid, c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
), r as (select unnest(array['anon', 'authenticated']) as role),
p as (select unnest(pg_temp.privs()) as priv),
cells as (
    select t.relname, r.role, p.priv,
        case when has_table_privilege(r.role, t.oid, p.priv) then p.priv
             when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') then (
                select case when count(*) > 0 then p.priv || '(' || string_agg(a.attname::text, ',' order by a.attname) || ')' end
                from pg_attribute a
                where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege(r.role, t.oid, a.attnum, p.priv))
        end as granted
    from t, r, p
)
select relname::text, role, string_agg(granted, ' ' order by array_position(pg_temp.privs(), priv))
from cells where granted is not null group by relname, role
$f$;

create temp table t_client_expected (tbl text, role text, privs text);
insert into t_client_expected values
('annotation_snapshots', 'authenticated', 'SELECT INSERT'),
('annotations', 'authenticated', 'SELECT INSERT UPDATE'),
('assignments', 'authenticated', 'SELECT'),
('billing_customers', 'authenticated', 'SELECT'),
('document_favorites', 'authenticated', 'SELECT INSERT DELETE'),
('document_imports', 'authenticated', 'SELECT INSERT UPDATE'),
('document_members', 'authenticated', 'SELECT'),
('document_storage_cleanup', 'authenticated', 'SELECT DELETE'),
('document_tags', 'authenticated', 'SELECT INSERT DELETE'),
('documents', 'authenticated', 'SELECT INSERT UPDATE DELETE'),
('library_tags', 'authenticated', 'SELECT INSERT UPDATE DELETE'),
('managed_students', 'authenticated', 'SELECT(age_attested_at,age_attested_min_age,archived_at,auth_method,claimed_at,country,created_at,display_name,id,parent_email,student_email,student_user_id,teacher_id,updated_at,username)'),
('practice_notes', 'authenticated', 'SELECT INSERT UPDATE(body,noted_on,shared) DELETE'),
('score_analyses', 'authenticated', 'SELECT INSERT UPDATE'),
('share_links', 'authenticated', 'SELECT INSERT UPDATE DELETE'),
('studio_members', 'authenticated', 'SELECT'),
('studios', 'authenticated', 'SELECT INSERT(id,name,owner_id) UPDATE(name)'),
('subscriptions', 'authenticated', 'SELECT'),
('teacher_attestations', 'authenticated', 'SELECT'),
('thumbnail_storage_cleanup', 'authenticated', 'SELECT'),
('usage_counters', 'authenticated', 'SELECT');

-- The fifteen tables BL-3 names.
create temp table t_bl3 (tbl text);
insert into t_bl3 values
('billing_customers'), ('studios'), ('studio_members'), ('usage_counters'), ('assignments'),
('practice_notes'), ('edge_rate_buckets'), ('pdf_export_claims'), ('content_moderators'),
('content_reports'), ('content_takedowns'), ('content_strikes'), ('content_notice_log'),
('content_notice_outbox'), ('document_realtime_epochs');

-- ---- service_role, every public table
select pg_temp.chk('01 service_role can SELECT every public table', $q$select bool_and(has_table_privilege('service_role', c.oid, 'SELECT'))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')$q$);
select pg_temp.same('02 service_role holds SELECT, INSERT, UPDATE, DELETE everywhere but the five deliberately narrowed', $q$
    select c.relname::text, string_agg(p, ' ' order by array_position(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'], p))
        filter (where has_table_privilege('service_role', c.oid, p))
    from pg_class c cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    group by c.relname
    having count(*) filter (where has_table_privilege('service_role', c.oid, p)) < 4$q$, $q$
    values ('billing_cancel_token_tombstones', 'SELECT'), ('billing_cancel_tokens', 'SELECT UPDATE DELETE'),
           ('district_billing', 'SELECT'), ('district_student_evidence', 'SELECT'), ('studio_seat_tenures', 'SELECT')$q$);
select pg_temp.chk('04 the new P1 tables are the service role''s and no client''s', $q$
    select bool_and(has_table_privilege('service_role', t, 'SELECT, INSERT, UPDATE, DELETE')
                    and not has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                    and not has_table_privilege('authenticated', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'))
    from unnest(array['public.deployment_config'::regclass, 'public.studio_supersede_log'::regclass]) t$q$);

-- ---- anon and authenticated, every public table
select pg_temp.same('05 anon and authenticated hold exactly the pinned list', $q$select * from pg_temp.client_acl()$q$,
    $q$select * from t_client_expected$q$);
select pg_temp.chk('06 decision 20: no client role can read or write the three billing lock tables', $q$
    select not bool_or(has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'))
    from unnest(array['anon', 'authenticated', 'public']) r,
         unnest(array['public.checkout_attempts'::regclass, 'public.subscription_writes'::regclass, 'public.duplicate_refunds'::regclass]) t$q$);
select pg_temp.chk('07 ... while the service role keeps them', $q$
    select bool_and(has_table_privilege('service_role', t, 'SELECT, INSERT, UPDATE, DELETE'))
    from unnest(array['public.checkout_attempts'::regclass, 'public.subscription_writes'::regclass, 'public.duplicate_refunds'::regclass]) t$q$);
select pg_temp.chk('08 the studios column grants are what they were: insert (id, owner_id, name), update (name)', $q$
    select has_column_privilege('authenticated', 'public.studios', 'name', 'UPDATE')
       and not has_column_privilege('authenticated', 'public.studios', 'seat_limit', 'UPDATE')
       and not has_column_privilege('authenticated', 'public.studios', 'seat_limit', 'INSERT')
       and not has_column_privilege('authenticated', 'public.studios', 'superseded_at', 'INSERT')
       and not has_column_privilege('authenticated', 'public.studios', 'superseded_at', 'UPDATE')
       and has_column_privilege('authenticated', 'public.studios', 'owner_id', 'INSERT')$q$);

-- ---- 20261022100700: what a client can never hold, and what a policy allows
select pg_temp.chk('30 no client role holds TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any public table or column', $q$
    select not exists (
        select 1
        from pg_class c, unnest(array['anon', 'authenticated', 'public']) r,
             unnest(pg_temp.privs()) p
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
          and p in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
          and (has_table_privilege(r, c.oid, p)
               or (p = 'REFERENCES' and has_any_column_privilege(r, c.oid, 'REFERENCES'))))$q$);
select pg_temp.chk('31 anon holds nothing on any public table', $q$
    select not exists (
        select 1 from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
          and (has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
               or has_table_privilege('anon', c.oid, 'DELETE')))$q$);
select pg_temp.chk('32 omr_jobs, score_cache, imslp_category_sync and imslp_file_licenses are no client''s', $q$
    select not bool_or(has_any_column_privilege(r, t, 'SELECT, INSERT, UPDATE, REFERENCES')
                       or has_table_privilege(r, t, 'DELETE, TRUNCATE, TRIGGER'))
    from unnest(array['anon', 'authenticated', 'public']) r,
         unnest(array['public.omr_jobs'::regclass, 'public.score_cache'::regclass,
                      'public.imslp_category_sync'::regclass, 'public.imslp_file_licenses'::regclass]) t$q$);
select pg_temp.chk('33 ... while the service role keeps them', $q$
    select bool_and(has_table_privilege('service_role', t, 'SELECT, INSERT, UPDATE, DELETE'))
    from unnest(array['public.omr_jobs'::regclass, 'public.score_cache'::regclass,
                      'public.imslp_category_sync'::regclass, 'public.imslp_file_licenses'::regclass]) t$q$);
-- A privilege RLS would refuse every row of is one nobody needs. Every client
-- privilege, table or column level, on an RLS table whose permissive policies
-- give that role the command (FOR ALL included, `to public` included).
select pg_temp.same('34 every client privilege is one an RLS policy lets that role use', $q$
    select c.relname::text, r.role, p.cmd
    from pg_class c
    cross join unnest(array['anon', 'authenticated']) r(role)
    cross join (values ('SELECT', 'r'), ('INSERT', 'a'), ('UPDATE', 'w'), ('DELETE', 'd')) p(cmd, polcmd)
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (case when p.cmd = 'DELETE' then has_table_privilege(r.role, c.oid, p.cmd)
                else has_any_column_privilege(r.role, c.oid, p.cmd) end)
      and not (c.relrowsecurity and exists (
          select 1 from pg_policy pl
          where pl.polrelid = c.oid and pl.polpermissive and pl.polcmd in (p.polcmd, '*')
            and (0 = any(pl.polroles) or (select oid from pg_roles where rolname = r.role) = any(pl.polroles))))$q$,
    $q$select null::text, null::text, null::text where false$q$);

select pg_temp.chk('35 the default ACL for postgres in public gives anon and authenticated nothing on a new table', $q$
    select not exists (
        select 1 from pg_default_acl d, aclexplode(d.defaclacl) a
        where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace
          and d.defaclobjtype = 'r'
          and a.grantee in ('anon'::regrole, 'authenticated'::regrole))$q$);
create table public.p1_default_acl_probe (id int);
select pg_temp.chk('36 a table created now: nothing for anon or authenticated, the service role''s default kept', $q$
    select not has_table_privilege('anon', 'public.p1_default_acl_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       and not has_table_privilege('authenticated', 'public.p1_default_acl_probe', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       and has_table_privilege('service_role', 'public.p1_default_acl_probe', 'SELECT, INSERT, UPDATE, DELETE')$q$);
drop table public.p1_default_acl_probe;

create temp table t_client_reduced as select * from pg_temp.client_acl();
\ir ../../supabase/migrations/20261022100700_client_table_privileges.sql
select pg_temp.same('37 20261022100700 reruns cleanly and changes nothing', $q$select * from pg_temp.client_acl()$q$,
    $q$select * from t_client_reduced$q$);

-- ---- no default grants
create temp table t_client_before as select * from pg_temp.client_acl();

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
create table public.p1_no_default_grants_probe (id int);
select pg_temp.chk('10 simulated: a table created now gets no grant for any API role', $q$
    select not has_table_privilege('service_role', 'public.p1_no_default_grants_probe', 'SELECT')
       and not has_table_privilege('authenticated', 'public.p1_no_default_grants_probe', 'SELECT')
       and not has_table_privilege('anon', 'public.p1_no_default_grants_probe', 'SELECT')$q$);

-- What a fresh replay with no default grants leaves the service role on the
-- fifteen: nothing, since no migration before 20261022100000 granted it.
do $$
declare v text;
begin
    for v in select tbl from t_bl3 loop
        execute format('revoke all on table public.%I from service_role', v);
    end loop;
end $$;
select pg_temp.chk('11 stripped of the default ACL, the service role holds nothing on the fifteen', $q$
    select not bool_or(has_table_privilege('service_role', ('public.' || tbl)::regclass, 'SELECT, INSERT, UPDATE, DELETE')) from t_bl3$q$);

\ir ../../supabase/migrations/20261022100000_explicit_service_role_grants.sql

select pg_temp.chk('12 the migration alone gives it SELECT, INSERT, UPDATE and DELETE on all fifteen', $q$
    select bool_and(has_table_privilege('service_role', ('public.' || tbl)::regclass, 'SELECT, INSERT, UPDATE, DELETE')) from t_bl3$q$);
select pg_temp.same('13 ... and leaves anon and authenticated exactly as they were', $q$select * from pg_temp.client_acl() where tbl <> 'p1_no_default_grants_probe'$q$,
    $q$select * from t_client_before$q$);

\ir ../../supabase/migrations/20261022100000_explicit_service_role_grants.sql
\ir ../../supabase/migrations/20261022100100_billing_lock_tables_client_revoke.sql

select pg_temp.chk('14 both migrations rerun cleanly, the service role keeping the fifteen', $q$
    select bool_and(has_table_privilege('service_role', ('public.' || tbl)::regclass, 'SELECT, INSERT, UPDATE, DELETE')) from t_bl3$q$);
select pg_temp.same('15 ... and the client roles where they were', $q$select * from pg_temp.client_acl() where tbl <> 'p1_no_default_grants_probe'$q$,
    $q$select * from t_client_before$q$);

select pg_temp.chk('20 the service role can write what the Edge Functions write directly', $q$
    select bool_and(has_table_privilege('service_role', t, 'INSERT, UPDATE'))
    from unnest(array['public.billing_customers'::regclass, 'public.content_reports'::regclass,
                      'public.content_notice_outbox'::regclass, 'public.content_moderators'::regclass]) t$q$);

select name, ok, detail from t_results order by name;
select count(*) filter (where not ok) as failures, count(*) as total from t_results;
rollback;
