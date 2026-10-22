-- Behaviour proof for 20261022100000_explicit_service_role_grants.sql (launch
-- re-audit BL-3) and 20261022100100_billing_lock_tables_client_revoke.sql
-- (decision 20): every public table's grants, for every role the API uses.
--
--   * service_role holds SELECT on every public table, and SELECT, INSERT,
--     UPDATE and DELETE on all but five whose narrowing is deliberate (their
--     writes go through definer functions); the narrowed five are pinned.
--   * anon and authenticated hold exactly the pinned list below, column
--     grants included -- a privilege added or lost anywhere fails here.
--   * With no default grants (the default ACL for `postgres` in `public`
--     revoked in this transaction, as Supabase's announced change would leave a
--     fresh project), the fifteen tables BL-3 names, stripped of what the
--     default ACL gave the service role, get it back from the migration alone
--     -- and the client roles' grants come out of it unchanged.
--
-- The client list is the local stack's (supabase CLI 2.121.0, Postgres
-- 17.11.0.004 -- the image CI runs). Its default ACL for `postgres` in
-- `public` is permissive (arwdDxtm to anon, authenticated and service_role),
-- so a table no migration revoked on carries anon's full set here: the core
-- tables, omr_jobs, score_cache, score_analyses and the IMSLP tables. Those
-- rows record today's state, RLS still decides every row, and narrowing them is
-- for another PR -- this one keeps the client roles exactly as they were.
-- A hosted project's default ACL differs, so run this against the local stack.
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

-- Table-level SELECT/INSERT/UPDATE/DELETE/TRUNCATE for a role, with the
-- columns where only some are granted: `INSERT(id,name,owner_id)`.
create function pg_temp.client_acl() returns table (tbl text, role text, privs text) language sql stable as $f$
with t as (
    select c.oid, c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
), r as (select unnest(array['anon', 'authenticated']) as role),
p as (select unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as priv),
cells as (
    select t.relname, r.role, p.priv,
        case when has_table_privilege(r.role, t.oid, p.priv) then p.priv
             when p.priv in ('SELECT', 'INSERT', 'UPDATE') then (
                select case when count(*) > 0 then p.priv || '(' || string_agg(a.attname::text, ',' order by a.attname) || ')' end
                from pg_attribute a
                where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege(r.role, t.oid, a.attnum, p.priv))
        end as granted
    from t, r, p
)
select relname::text, role, string_agg(granted, ' ' order by array_position(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'], priv))
from cells where granted is not null group by relname, role
$f$;

create temp table t_client_expected (tbl text, role text, privs text);
insert into t_client_expected values
('annotation_snapshots', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('annotation_snapshots', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('annotations', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('annotations', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('assignments', 'authenticated', 'SELECT'),
('billing_customers', 'authenticated', 'SELECT'),
('document_favorites', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_favorites', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_imports', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_imports', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_members', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_members', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_storage_cleanup', 'authenticated', 'SELECT DELETE'),
('document_tags', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('document_tags', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('documents', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('documents', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('imslp_category_sync', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('imslp_category_sync', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('imslp_file_licenses', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('imslp_file_licenses', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('library_tags', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('library_tags', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('managed_students', 'authenticated', 'SELECT(age_attested_at,age_attested_min_age,archived_at,auth_method,claimed_at,country,created_at,display_name,id,parent_email,student_email,student_user_id,teacher_id,updated_at,username)'),
('omr_jobs', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('omr_jobs', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('practice_notes', 'authenticated', 'SELECT INSERT UPDATE(body,noted_on,shared) DELETE'),
('score_analyses', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('score_analyses', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('score_cache', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('score_cache', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('share_links', 'anon', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('share_links', 'authenticated', 'SELECT INSERT UPDATE DELETE TRUNCATE'),
('studio_members', 'authenticated', 'SELECT'),
('studios', 'authenticated', 'SELECT INSERT(id,name,owner_id) UPDATE(name)'),
('subscriptions', 'authenticated', 'SELECT'),
('teacher_attestations', 'authenticated', 'SELECT'),
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
