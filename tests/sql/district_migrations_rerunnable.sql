-- The district migrations are rerunnable, whole (Codex round-3 review of #61:
-- not only the canonical district_billing block). Applies
-- 20261020180400_district_seat_overrides.sql,
-- 20261020180500_district_seat_cap_and_grace.sql,
-- 20261020180600_read_only_seats_enforced.sql,
-- 20261020180700_read_only_seats_storage.sql,
-- 20261020180800_read_only_seats_live_ink.sql,
-- 20261020180900_district_paying_status.sql,
-- 20261020181000_district_contract_end_clamp.sql,
-- 20261020181100_read_only_seats_grace_deadline.sql and
-- 20261020181200_district_contract_end_automatic_retry.sql, in order, TWICE on top of a
-- database that already has them, inside one transaction ending in ROLLBACK,
-- then checks that the second run changed nothing it should not: every table,
-- column, index, trigger, constraint, policy and cron job exists once, the
-- latest definition of each redefined function wins, and rows written before
-- the rerun (an override, its log, a billing record, a kept seat) are still
-- there, unchanged.
--
-- psql only: the migrations are included with \ir, relative to this file, so
-- it cannot be pasted into the MCP's execute_sql. Run from the repository root
-- against the local stack (npm run cloud:up):
--
--     psql "postgresql://postgres:postgres@127.0.0.1:54422/postgres" \
--         -v ON_ERROR_STOP=1 -f tests/sql/district_migrations_rerunnable.sql
--
-- A migration that is not rerunnable stops the run with its error (ON_ERROR_STOP)
-- and psql exits non-zero. A clean run ends in one row, 'ALL n CHECKS PASSED'.

\set ON_ERROR_STOP 1

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

create function pg_temp.holds (p_name text, p_sql text) returns void language plpgsql as $$
declare
    v boolean;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql into v;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'error: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, coalesce(v, false), 'got ' || coalesce(v::text, 'null'));
end;
$$;

-- Rows from before the rerun, which it must keep: a district with an override
-- (and so its log and billing record) and a member the owner kept active.
insert into auth.users (id, aud, role, email)
select ('d1900000-0000-4000-8000-0000000000' || suffix)::uuid, 'authenticated', 'authenticated',
       'd19-' || suffix || '@example.invalid'
from unnest(array['a1', 'b1']) as suffix;

insert into public.studios (id, owner_id, name)
values ('d1900000-0000-4000-8000-00000000c001', 'd1900000-0000-4000-8000-0000000000a1', 'Rerun district');

set local role service_role;

select public.write_subscription_under_lock (
    public.claim_subscription_write ('sub_d19_district', interval '5 minutes'),
    'sub_d19_district', 'd1900000-0000-4000-8000-0000000000a1', 'test', 'academy', 'active',
    'price_district_custom', now() + interval '1 year', false, now() - interval '1 hour', 'send_invoice'
);

select public.admin_set_studio_seat_override (
    'd1900000-0000-4000-8000-00000000c001', 10, 'sub_d19_district', 'test', 'Contract #19'
);

reset role;

insert into public.studio_members (studio_id, user_id, kept_active)
values ('d1900000-0000-4000-8000-00000000c001', 'd1900000-0000-4000-8000-0000000000b1', true);

create temp table before_rerun as
select
    (select count(*) from public.studio_seat_override_log where studio_id = 'd1900000-0000-4000-8000-00000000c001') as log_rows,
    (select count(*) from public.district_billing_log where studio_id = 'd1900000-0000-4000-8000-00000000c001') as billing_log_rows,
    (select seat_limit from public.studio_seat_overrides where studio_id = 'd1900000-0000-4000-8000-00000000c001') as seat_limit;

-- ===========================================================================
-- Apply them all, twice
-- ===========================================================================
\ir ../../supabase/migrations/20261020180400_district_seat_overrides.sql
\ir ../../supabase/migrations/20261020180500_district_seat_cap_and_grace.sql
\ir ../../supabase/migrations/20261020180600_read_only_seats_enforced.sql
\ir ../../supabase/migrations/20261020180700_read_only_seats_storage.sql
\ir ../../supabase/migrations/20261020180800_read_only_seats_live_ink.sql
\ir ../../supabase/migrations/20261020180900_district_paying_status.sql
\ir ../../supabase/migrations/20261020181000_district_contract_end_clamp.sql
\ir ../../supabase/migrations/20261020181100_read_only_seats_grace_deadline.sql
\ir ../../supabase/migrations/20261020181200_district_contract_end_automatic_retry.sql

\ir ../../supabase/migrations/20261020180400_district_seat_overrides.sql
\ir ../../supabase/migrations/20261020180500_district_seat_cap_and_grace.sql
\ir ../../supabase/migrations/20261020180600_read_only_seats_enforced.sql
\ir ../../supabase/migrations/20261020180700_read_only_seats_storage.sql
\ir ../../supabase/migrations/20261020180800_read_only_seats_live_ink.sql
\ir ../../supabase/migrations/20261020180900_district_paying_status.sql
\ir ../../supabase/migrations/20261020181000_district_contract_end_clamp.sql
\ir ../../supabase/migrations/20261020181100_read_only_seats_grace_deadline.sql
\ir ../../supabase/migrations/20261020181200_district_contract_end_automatic_retry.sql

reset role;

-- ===========================================================================
-- Everything once
-- ===========================================================================
select pg_temp.holds (
    'each district trigger exists exactly once',
    $q$select count(*) = 8 and bool_and(c = 1)
       from (
           select t.tgname, count(*) as c
           from pg_trigger t
           where not t.tgisinternal
             and t.tgname in (
                 'studio_seat_overrides_log', 'subscriptions_track_past_due', 'district_billing_log',
                 'studio_seat_overrides_reconcile', 'studio_members_release_seat', 'subscriptions_follow_district',
                 'assignments_refuse_read_only_seat', 'documents_refuse_read_only_seat'
             )
           group by t.tgname
       ) x$q$
);

select pg_temp.holds (
    'the hourly reconcile is one cron job, on its schedule',
    $q$select count(*) = 1 and min(schedule) = '41 * * * *'
       from cron.job where jobname = 'district-seat-reconcile'$q$
);

select pg_temp.holds (
    'every added column is there, once',
    $q$select count(*) = 7
       from information_schema.columns
       where table_schema = 'public'
         and (table_name, column_name) in (
             ('subscriptions', 'collection_method'), ('subscriptions', 'ended_at'),
             ('subscriptions', 'past_due_since'), ('studio_members', 'kept_active'),
             ('district_billing', 'contract_ends_at'), ('district_billing', 'contract_end_reported_at'),
             ('district_billing', 'contract_end_learned_at')
         )$q$
);

select pg_temp.holds (
    'collection_method keeps exactly one check constraint',
    $q$select count(*) = 1
       from pg_constraint
       where conrelid = 'public.subscriptions'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%collection_method%'$q$
);

select pg_temp.holds (
    'district_billing keeps each named constraint once',
    $q$select count(*) = 2
       from pg_constraint
       where conrelid = 'public.district_billing'::regclass
         and conname in ('district_billing_contract_ends_source_check', 'district_billing_contract_ends_source_matches')$q$
);

select pg_temp.holds (
    'every district index is there',
    $q$select count(*) = 6
       from pg_indexes
       where schemaname = 'public'
         and indexname in (
             'studio_seat_overrides_subscription', 'studio_seat_override_log_studio', 'district_billing_subscription',
             'district_billing_contract_ends', 'district_billing_log_studio', 'studio_members_seat_order'
         )$q$
);

select pg_temp.holds (
    'each read-only seat policy exists once',
    $q$select count(*) = 9
       from pg_policies
       where policyname in (
           'annotations_seat_read_only_insert', 'annotations_seat_read_only_update',
           'annotation_snapshots_seat_read_only_insert', 'doc_topic_seat_read_only_broadcast',
           'share_links_seat_read_only_insert', 'scores_seat_read_only_insert', 'scores_seat_read_only_update',
           'scores_seat_read_only_delete', 'doc_topic_seat_grace_broadcast'
       )$q$
);

select pg_temp.holds (
    'RLS stays on, and no client role gained anything',
    $q$select bool_and(c.relrowsecurity)
          and not has_table_privilege('authenticated', 'public.district_billing', 'select')
          and not has_table_privilege('authenticated', 'public.studio_seat_overrides', 'select')
          and not has_table_privilege('anon', 'public.district_billing_log', 'select')
          and has_table_privilege('service_role', 'public.district_billing', 'select')
       from pg_class c
       where c.oid in ('public.district_billing'::regclass, 'public.district_billing_log'::regclass,
                       'public.studio_seat_overrides'::regclass, 'public.studio_seat_override_log'::regclass)$q$
);

-- ===========================================================================
-- The latest definitions win
-- ===========================================================================
-- 20261020180400 defines studio_effective_seat_limit without the grace
-- period; 20261020180500 redefines it. Applied in order, the later one stands.
select pg_temp.holds (
    'studio_effective_seat_limit is 20261020180500''s (grace included)',
    $q$select pg_get_functiondef('public.studio_effective_seat_limit(uuid)'::regprocedure) like '%subscription_is_live%'$q$
);

select pg_temp.holds (
    'reconcile_studio_seats is 20261020180800''s (it follows each seat for live ink)',
    $q$select pg_get_functiondef('public.reconcile_studio_seats(uuid)'::regprocedure) like '%seat_live_ink_follow%'
          and pg_get_functiondef('public.studio_members_release_seat()'::regprocedure) like '%seat_live_ink_follow%'$q$
);

select pg_temp.holds (
    'seat_read_only_since is there once, with RLS on and nothing for clients',
    $q$select c.relrowsecurity and not has_table_privilege('authenticated', 'public.seat_read_only_since', 'select')
       from pg_class c where c.oid = 'public.seat_read_only_since'::regclass$q$
);

select pg_temp.holds (
    'subscription_is_live and the sweep are 20261020180900''s (card past-due grace, unpaid not paying)',
    $q$select pg_get_functiondef('public.subscription_is_live(public.subscriptions)'::regprocedure) like '%s.tier = ''academy'' or s.collection_method = ''send_invoice''%'
          and pg_get_functiondef('public.subscription_is_live(public.subscriptions)'::regprocedure) not like '%unpaid%'
          and pg_get_functiondef('public.reconcile_district_seats()'::regprocedure) not like '%contract_ends_source = ''admin''%'
          and pg_get_functiondef('public.admin_extend_district_grace(uuid, timestamptz, text, text)'::regprocedure) like '%district_billing_rederive%'$q$
);

select pg_temp.holds (
    'district_billing_rederive is this round''s (no invented date)',
    $q$select pg_get_functiondef('public.district_billing_rederive(uuid)'::regprocedure) like '%v_paying%'
          and pg_get_functiondef('public.district_billing_rederive(uuid)'::regprocedure) not like '%last_event_created_at%'$q$
);

select pg_temp.holds (
    'district_billing_rederive and admin_set_district_contract_end are 20261020181000''s (clamped to learned)',
    $q$select pg_get_functiondef('public.district_billing_rederive(uuid)'::regprocedure) like '%greatest(v_end, v_learned)%'
          and pg_get_functiondef('public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)'::regprocedure)
              like '%greatest(p_contract_ends_at, v_learned)%'$q$
);

select pg_temp.holds (
    'admin_set_district_contract_end is 20261020181200''s (a hand-back clears only an admin pin), service role only',
    $q$select pg_get_functiondef('public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)'::regprocedure)
              like '%if v_row.contract_ends_source is not distinct from ''admin'' then%'
          and has_function_privilege('service_role', 'public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)', 'execute')
          and not has_function_privilege('anon', 'public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)', 'execute')
          and (select p.proconfig = array['search_path=public'] from pg_proc p
               where p.oid = 'public.admin_set_district_contract_end(uuid, timestamptz, text, text, boolean)'::regprocedure)$q$
);

-- ===========================================================================
-- Rows from before the rerun are kept
-- ===========================================================================
select pg_temp.holds (
    'the override is still there, at 10',
    $q$select seat_limit = 10 from public.studio_seat_overrides
       where studio_id = 'd1900000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'its log and the billing record''s log lost nothing',
    $q$select (select count(*) from public.studio_seat_override_log
               where studio_id = 'd1900000-0000-4000-8000-00000000c001') >= b.log_rows
          and (select count(*) from public.district_billing_log
               where studio_id = 'd1900000-0000-4000-8000-00000000c001') >= b.billing_log_rows
          and b.log_rows >= 1
       from before_rerun b$q$
);

select pg_temp.holds (
    'the billing record still links the district''s subscription',
    $q$select stripe_subscription_id = 'sub_d19_district' from public.district_billing
       where studio_id = 'd1900000-0000-4000-8000-00000000c001'$q$
);

select pg_temp.holds (
    'the owner''s kept seat is still kept (adding the column again reset nothing)',
    $q$select kept_active from public.studio_members
       where studio_id = 'd1900000-0000-4000-8000-00000000c001'
         and user_id = 'd1900000-0000-4000-8000-0000000000b1'$q$
);

-- A doubled trigger would log one change twice.
create temp table log_before as
select count(*) as c from public.studio_seat_override_log where studio_id = 'd1900000-0000-4000-8000-00000000c001';

set local role service_role;

select public.admin_set_studio_seat_override (
    'd1900000-0000-4000-8000-00000000c001', 12, 'sub_d19_district', 'test', 'Contract #19, more seats'
);

reset role;

select pg_temp.holds (
    'and the log trigger fires once per change, not twice',
    $q$select (select count(*) from public.studio_seat_override_log
               where studio_id = 'd1900000-0000-4000-8000-00000000c001') = (select c + 1 from log_before)$q$
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail
from integrity_results
where not passed
union all
select
    null,
    case
        when bool_and(passed) then 'ALL ' || count(*) || ' CHECKS PASSED'
        else count(*) filter (where not passed) || ' OF ' || count(*) || ' CHECKS FAILED'
    end,
    bool_and(passed),
    null
from integrity_results
order by n nulls last;

rollback;
