-- PDF export claim ids and the entitlement cancel flag (migrations
-- 20261009120100 and 20261009120101).
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.
--
-- Cast: F is a free account (one PDF export a month) who owns scores D1 and D2;
-- G is a share-link guest on both (an anonymous session); P pays for Personal (unlimited
-- exports) and has cancelled at period end; T is seated in A's Academy, which A
-- is also cancelling; S is a provisioned student.

begin;

-- ---------------------------------------------------------------------------
-- Harness (the column_integrity.sql helpers, restated: pg_temp is per file)
-- ---------------------------------------------------------------------------
create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

create temp table integrity_fixtures (k text primary key, v text);

grant all on integrity_results, integrity_fixtures to public;

grant usage on sequence integrity_results_n_seq to public;

create function pg_temp.act_as (p_uid uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated')::text,
        true
    );
end;
$$;

-- A share-link guest: Supabase anonymous sign-in, same role, is_anonymous set.
create function pg_temp.act_as_guest (p_uid uuid) returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', true)::text,
        true
    );
end;
$$;

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.allowed (p_name text, p_sql text, p_rows int default null) returns void language plpgsql as $$
declare
    v_rows int;
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
        get diagnostics v_rows = row_count;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, false, 'refused: ' || v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (
        p_name,
        p_rows is null or v_rows = p_rows,
        v_rows || ' row(s)' || case when p_rows is null then '' else ', expected ' || p_rows end
    );
end;
$$;

create function pg_temp.refused (p_name text, p_sql text, p_state text, p_like text default null) returns void language plpgsql as $$
declare
    v_state text;
    v_msg text;
begin
    begin
        execute p_sql;
    exception when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        insert into integrity_results (check_name, passed, detail)
        values (p_name, v_state = p_state and (p_like is null or v_msg like p_like), v_state || ' ' || v_msg);
        return;
    end;
    insert into integrity_results (check_name, passed, detail)
    values (p_name, false, 'statement succeeded but should have been refused');
end;
$$;

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

-- The claim answer, recorded so a later check can read it as postgres.
create function pg_temp.claim (p_key text, p_document uuid, p_claim uuid) returns void language plpgsql as $$
begin
    insert into integrity_fixtures
    values (p_key, public.claim_pdf_export (p_document, p_claim)::text)
    on conflict (k) do update set v = excluded.v;
end;
$$;

create function pg_temp.answer (p_key text) returns jsonb language sql as $$
    select v::jsonb from integrity_fixtures where k = p_key
$$;

create function pg_temp.exports_used (p_user uuid) returns int language sql as $$
    select coalesce((
        select uc.count from public.usage_counters uc
        where uc.user_id = p_user and uc.metric = 'pdf_exports' and uc.month = date_trunc('month', now())::date
    ), 0)
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values
    ('c1ef0000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 'claims-free@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', 'claims-guest@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000f3', 'authenticated', 'authenticated', 'claims-personal@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000f4', 'authenticated', 'authenticated', 'claims-free-two@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000f5', 'authenticated', 'authenticated', 'claims-academy@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000f6', 'authenticated', 'authenticated', 'claims-seated@example.invalid');

insert into auth.users (id, aud, role, email, raw_app_meta_data)
values (
    'c1ef0000-0000-4000-8000-0000000000f7', 'authenticated', 'authenticated', 'claims-student@example.invalid',
    '{"user_type":"student"}'
);

insert into public.documents (id, owner_id, title, storage_path)
values
    ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000f1',
     'Claims D1', 'c1ef0000-0000-4000-8000-0000000000d1/original.pdf'),
    ('c1ef0000-0000-4000-8000-0000000000d2', 'c1ef0000-0000-4000-8000-0000000000f1',
     'Claims D2', 'c1ef0000-0000-4000-8000-0000000000d2/original.pdf');

insert into public.document_members (document_id, user_id, role)
values
    ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000f2', 'viewer'),
    ('c1ef0000-0000-4000-8000-0000000000d2', 'c1ef0000-0000-4000-8000-0000000000f2', 'viewer');

insert into public.subscriptions (stripe_subscription_id, user_id, mode, tier, status, current_period_end, cancel_at_period_end)
values
    ('sub_claims_personal', 'c1ef0000-0000-4000-8000-0000000000f3', 'test', 'personal', 'active',
     now() + interval '20 days', true),
    ('sub_claims_academy', 'c1ef0000-0000-4000-8000-0000000000f5', 'test', 'academy', 'active',
     now() + interval '40 days', true);

insert into public.studios (id, owner_id, name)
values ('c1ef0000-0000-4000-8000-0000000000e1', 'c1ef0000-0000-4000-8000-0000000000f5', 'Claims Academy');

insert into public.studio_members (studio_id, user_id)
values ('c1ef0000-0000-4000-8000-0000000000e1', 'c1ef0000-0000-4000-8000-0000000000f6');

-- ===========================================================================
-- claim_pdf_export: an id is counted once, replayed free, never twice
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f1');

select pg_temp.allowed (
    'claim: a free account claims its one export with an id',
    $q$select pg_temp.claim ('f1_first', null, 'c1ef0000-0000-4000-8000-00000000c001')$q$
);

select pg_temp.holds (
    'claim: ... answered ok and counted once',
    $q$select (pg_temp.answer ('f1_first') ->> 'ok')::boolean
          and pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f1') = 1$q$
);

select pg_temp.allowed (
    'claim: the same id again (a lost answer, a dismissed share sheet)',
    $q$select pg_temp.claim ('f1_replay', null, 'c1ef0000-0000-4000-8000-00000000c001')$q$
);

select pg_temp.holds (
    'claim: ... is ok again, marked replayed, and NOT counted again',
    $q$select (pg_temp.answer ('f1_replay') ->> 'ok')::boolean
          and (pg_temp.answer ('f1_replay') ->> 'replayed')::boolean
          and pg_temp.answer ('f1_replay') ->> 'tier' = 'free'
          and pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f1') = 1$q$
);

select pg_temp.allowed (
    'claim: a fresh id once the month is spent',
    $q$select pg_temp.claim ('f1_second', null, 'c1ef0000-0000-4000-8000-00000000c002')$q$
);

select pg_temp.holds (
    'claim: ... is refused, with the plan to word it for, and counts nothing',
    $q$select not (pg_temp.answer ('f1_second') ->> 'ok')::boolean
          and (pg_temp.answer ('f1_second') ->> 'limit')::int = 1
          and pg_temp.answer ('f1_second') ->> 'tier' = 'free'
          and pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f1') = 1$q$
);

select pg_temp.allowed (
    'claim: the refused id asked again',
    $q$select pg_temp.claim ('f1_second_again', null, 'c1ef0000-0000-4000-8000-00000000c002')$q$
);

select pg_temp.holds (
    'claim: ... is still refused: a refused id is never remembered as ok',
    $q$select not (pg_temp.answer ('f1_second_again') ->> 'ok')::boolean
          and pg_temp.answer ('f1_second_again') ->> 'replayed' is null$q$
);

select pg_temp.allowed (
    'claim: no id at all (bundles already in the field)',
    $q$select pg_temp.claim ('f1_legacy', null, null)$q$
);

select pg_temp.holds (
    'claim: ... behaves as before: refused once the month is spent',
    $q$select not (pg_temp.answer ('f1_legacy') ->> 'ok')::boolean$q$
);

select pg_temp.holds (
    'claim: the legacy consume_pdf_export still answers through the same function',
    $q$select not (public.consume_pdf_export () ->> 'ok')::boolean$q$
);

-- Another account cannot borrow F's id to export for nothing.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f4');

select pg_temp.refused (
    'claim: someone else replaying F''s id is refused, not answered ok',
    $q$select public.claim_pdf_export (null, 'c1ef0000-0000-4000-8000-00000000c001')$q$,
    '22023',
    '%already been used%'
);

select pg_temp.holds (
    'claim: ... and spends nothing of theirs',
    $q$select pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f4') = 0$q$
);

-- An id older than the replay window is spent for good.
select pg_temp.act_as_server ();

select pg_temp.allowed (
    'claim: (age F''s claim past the hour)',
    $q$update public.pdf_export_claims set created_at = now() - interval '2 hours'
       where id = 'c1ef0000-0000-4000-8000-00000000c001'$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f1');

select pg_temp.refused (
    'claim: replaying an id after the hour is refused, never counted afresh',
    $q$select public.claim_pdf_export (null, 'c1ef0000-0000-4000-8000-00000000c001')$q$,
    '22023',
    '%already been used%'
);

-- ===========================================================================
-- Share-link guests: billed to the owner, replay scoped to the same score
-- ===========================================================================
select pg_temp.act_as_server ();

select pg_temp.allowed (
    'guest: (give F a fresh month)',
    $q$update public.usage_counters set count = 0
       where user_id = 'c1ef0000-0000-4000-8000-0000000000f1' and metric = 'pdf_exports'$q$,
    1
);

select pg_temp.act_as_guest ('c1ef0000-0000-4000-8000-0000000000f2');

select pg_temp.allowed (
    'guest: a guest claims with an id, naming the score',
    $q$select pg_temp.claim ('g_first', 'c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-00000000c101')$q$
);

select pg_temp.allowed (
    'guest: ... and replays it',
    $q$select pg_temp.claim ('g_replay', 'c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-00000000c101')$q$
);

-- Read as postgres: RLS shows a guest only its own usage rows.
select pg_temp.act_as_server ();

select pg_temp.holds (
    'guest: both ok, billed to the owner once, the owner''s tier never named',
    $q$select (pg_temp.answer ('g_first') ->> 'ok')::boolean
          and (pg_temp.answer ('g_replay') ->> 'replayed')::boolean
          and pg_temp.answer ('g_first') ->> 'billed_to' = 'owner'
          and pg_temp.answer ('g_replay') ->> 'billed_to' = 'owner'
          and not (pg_temp.answer ('g_first') ? 'tier')
          and not (pg_temp.answer ('g_replay') ? 'tier')
          and not (pg_temp.answer ('g_first') ? 'count')
          and pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f1') = 1
          and pg_temp.exports_used ('c1ef0000-0000-4000-8000-0000000000f2') = 0$q$
);

select pg_temp.act_as_guest ('c1ef0000-0000-4000-8000-0000000000f2');

select pg_temp.refused (
    'guest: an id is not replayable for another score of the same owner',
    $q$select public.claim_pdf_export ('c1ef0000-0000-4000-8000-0000000000d2', 'c1ef0000-0000-4000-8000-00000000c101')$q$,
    '22023',
    '%already been used%'
);

-- ===========================================================================
-- Unlimited and exempt callers record nothing
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f3');

select pg_temp.holds (
    'unlimited: a Personal subscriber''s claim is ok and unlimited',
    $q$select (public.claim_pdf_export (null, 'c1ef0000-0000-4000-8000-00000000c201') ->> 'unlimited')::boolean$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f7');

select pg_temp.holds (
    'unlimited: a student''s claim is exempt',
    $q$select public.claim_pdf_export (null, 'c1ef0000-0000-4000-8000-00000000c202') ->> 'exempt' = 'student'$q$
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'unlimited: ... and neither left a claim row behind',
    $q$select not exists (
           select 1 from public.pdf_export_claims
           where id in ('c1ef0000-0000-4000-8000-00000000c201', 'c1ef0000-0000-4000-8000-00000000c202'))$q$
);

-- ===========================================================================
-- pdf_export_claims is server bookkeeping
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f1');

select pg_temp.refused (
    'table: a client cannot read the claims',
    $q$select count(*) from public.pdf_export_claims$q$,
    '42501'
);

select pg_temp.refused (
    'table: a client cannot write a claim of its own',
    $q$insert into public.pdf_export_claims (id, claimed_by, billed_to)
       values (gen_random_uuid(), 'c1ef0000-0000-4000-8000-0000000000f1', 'c1ef0000-0000-4000-8000-0000000000f1')$q$,
    '42501'
);

select pg_temp.act_as_server ();

select pg_temp.holds (
    'grants: claim_pdf_export(uuid, uuid) runs for authenticated, never anon',
    $q$select has_function_privilege('authenticated', 'public.claim_pdf_export(uuid, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.claim_pdf_export(uuid, uuid)', 'execute')$q$
);

select pg_temp.holds (
    'grants: the one-argument claim_pdf_export is gone (no ambiguous overload)',
    $q$select to_regprocedure('public.claim_pdf_export(uuid)') is null$q$
);

-- ===========================================================================
-- Entitlements carry cancel_at_period_end
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f3');

select pg_temp.holds (
    'entitlements: a cancelling subscriber sees cancel_at_period_end and the end date',
    $q$select (public.get_entitlements () ->> 'cancel_at_period_end')::boolean
          and public.get_entitlements () ->> 'tier' = 'personal'
          and public.get_entitlements () ->> 'current_period_end' is not null$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f6');

select pg_temp.holds (
    'entitlements: a seated teacher sees that their academy is ending',
    $q$select (public.get_entitlements () ->> 'cancel_at_period_end')::boolean
          and public.get_entitlements () ->> 'source' = 'studio_member'$q$
);

select pg_temp.holds (
    'entitlements: ... and still cannot read the owner''s subscription row',
    $q$select not exists (select 1 from public.subscriptions)$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f1');

select pg_temp.holds (
    'entitlements: a free account reads false, not null',
    $q$select public.get_entitlements () -> 'cancel_at_period_end' = 'false'::jsonb$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f7');

select pg_temp.holds (
    'entitlements: a student reads false',
    $q$select public.get_entitlements () -> 'cancel_at_period_end' = 'false'::jsonb$q$
);

select pg_temp.act_as_server ();

select pg_temp.allowed (
    'entitlements: (P resumes the subscription)',
    $q$update public.subscriptions set cancel_at_period_end = false
       where stripe_subscription_id = 'sub_claims_personal'$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000f3');

select pg_temp.holds (
    'entitlements: a resumed subscription reads false again',
    $q$select public.get_entitlements () -> 'cancel_at_period_end' = 'false'::jsonb$q$
);

select pg_temp.holds (
    'entitlements: library_bootstrap carries the same key',
    $q$select (public.library_bootstrap () -> 'entitlements') ? 'cancel_at_period_end'$q$
);

-- ---------------------------------------------------------------------------
-- Report
-- ---------------------------------------------------------------------------
select pg_temp.act_as_server ();

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
