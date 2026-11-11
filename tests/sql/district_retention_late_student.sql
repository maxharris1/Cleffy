-- District retention: a student provisioned while the district's purge is
-- running (decision 53(4); fixed by 20261022130300, decision 67). LOCAL STACK
-- or the dev branch project only. Same harness as
-- district_retention_reattribution.sql: one transaction ending in ROLLBACK,
-- time moved by the functions' p_now; the last line is `failures | total`
-- (scripts/ci/sql-proof.sh reads it), after any failing checks.
--
-- The soft delete lists the district's students once (INSERT ... SELECT from
-- retention_district_students()), and the hard delete works from that list.
-- A student provisioned into the district while the soft delete runs -- a
-- roster insert that commits after the soft delete's statement snapshot -- is,
-- to every later run, the same as one provisioned just after it: in the
-- district, not on the list. A single session cannot interleave two
-- transactions, so this proof provisions the late student right after the soft
-- delete, before the next run, and asks whether that run catches them.
--
-- Since 20261022130300 the roster trigger refuses that insert outright
-- (district_deletion_pending, 55000; tests/sql/district_provision_barrier.sql),
-- and the district's lock keeps a provision from committing under a running
-- soft delete (tests/sql/district_retention_late_student_race.sql). So e2 is
-- written here with that one trigger disabled for its one insert: a row that
-- got past the barrier anyway (written before 20261022130300, or loaded with
-- triggers off). This proof's question is unchanged: whether the next run and
-- the hard delete catch a student attributed to the district who is not on
-- its list. Everything else is the verification proof as it first ran (3 of 6
-- failing before the fix).
--
-- Cast: O owns district L (contract ended 17 days ago). e1 is provisioned for
-- L before the purge began (the control); e2 is provisioned for L after the
-- soft delete. Each has a mark on O's score.

begin;

create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

grant all on integrity_results to public;

grant usage on sequence integrity_results_n_seq to public;

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

create temp table ran (k text primary key, v jsonb);

grant all on ran to public;

-- e1, e2: roster ids d5300000...05e<n>, accounts d5300000...00e<n>, marks d5300000...a00e<n>.
create function pg_temp.roster (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000005' || p)::uuid;
$$;

create function pg_temp.account (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000000' || p)::uuid;
$$;

create function pg_temp.mark (p text) returns uuid language sql immutable as $$
    select ('d5300000-0000-4000-8000-0000000a00' || p)::uuid;
$$;

-- Gone as Delete student leaves them: no account, no roster row, the mark
-- scrubbed.
create function pg_temp.purged (p text) returns boolean language sql as $$
    select not exists (select 1 from auth.users where id = pg_temp.account (p))
       and not exists (select 1 from public.managed_students where id = pg_temp.roster (p))
       and coalesce((select deleted_at is not null and payload ->> 'text' = '' from public.annotations
                     where id = pg_temp.mark (p)), true);
$$;

create function pg_temp.archived (p text) returns boolean language sql as $$
    select archived_at is not null and access_revoked_at is not null
    from public.managed_students where id = pg_temp.roster (p);
$$;

create function pg_temp.listed (p text) returns boolean language sql as $$
    select exists (select 1 from public.district_retention_students
                   where studio_id = 'd5300000-0000-4000-8000-0000000005d1' and managed_student_id = pg_temp.roster (p));
$$;

create function pg_temp.provision (p text) returns void language sql as $$
    insert into public.managed_students
        (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at,
         district_studio_id)
    values (pg_temp.roster (p), pg_temp.account ('a1'), pg_temp.account (p), 'Student ' || p, null, 'code',
            'ls_' || p, now(), 'd5300000-0000-4000-8000-0000000005d1');
    insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
    values (pg_temp.mark (p), 'd5300000-0000-4000-8000-00000000d001', 0, 'text', '#112233',
            jsonb_build_object('x', 0.3, 'y', 0.3, 'size', 0.02, 'text', 'work of ' || p), pg_temp.account (p));
$$;

-- The same, past the barrier: the roster trigger that refuses it is off for
-- this one insert only (and back on before anything else runs).
create function pg_temp.provision_past_barrier (p text) returns void language plpgsql as $$
begin
    alter table public.managed_students disable trigger managed_students_district_attribution;
    perform pg_temp.provision (p);
    alter table public.managed_students enable trigger managed_students_district_attribution;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email, raw_app_meta_data)
select pg_temp.account ('a1'), 'authenticated', 'authenticated', 'ls-owner@example.invalid', '{}'::jsonb
union all
select pg_temp.account (s), 'authenticated', 'authenticated', 'ls-' || s || '@students.cleffy.app',
       '{"user_type":"student"}'::jsonb
from unnest(array['e1', 'e2']) as s;

insert into public.studios (id, owner_id, name)
values ('d5300000-0000-4000-8000-0000000005d1', pg_temp.account ('a1'), 'District L');

insert into public.district_billing (studio_id, contract_ends_at, contract_ends_source, updated_by)
values ('d5300000-0000-4000-8000-0000000005d1', now() - interval '17 days', 'admin', 'test');

insert into public.documents (id, owner_id, title, storage_path)
values ('d5300000-0000-4000-8000-00000000d001', pg_temp.account ('a1'), 'Score',
        'd5300000-0000-4000-8000-00000000d001/original.pdf');

select pg_temp.provision ('e1');

-- ===========================================================================
-- Notice, sent, soft delete
-- ===========================================================================
select public.retention_district_run (now());

select public.finish_district_retention_notice (id) from public.claim_district_retention_notices (20);

insert into ran select 'soft', public.retention_district_run (now() + interval '14 days 1 minute');

select pg_temp.holds (
    'control: the soft delete lists and archives e1, L''s one student',
    $q$select (select (v ->> 'soft_delete')::int = 1 and (v ->> 'students_archived')::int = 1 from ran where k = 'soft')
       and pg_temp.listed ('e1') and pg_temp.archived ('e1')$q$
);

-- ===========================================================================
-- e2 is provisioned for L while its purge is under way
-- ===========================================================================
select pg_temp.provision_past_barrier ('e2');

select pg_temp.holds (
    'e2 is provisioned into L after the soft delete, and is not on its list',
    $q$select exists (select 1 from public.managed_students
                      where id = pg_temp.roster ('e2') and district_studio_id = 'd5300000-0000-4000-8000-0000000005d1')
          and not pg_temp.listed ('e2')$q$
);

-- The next daily run, before the hard delete is due.
insert into ran select 'next', public.retention_district_run (now() + interval '15 days 1 minute');

select pg_temp.holds (
    'the next retention run catches e2: listed for L''s purge, archived and signed out like the others',
    $q$select pg_temp.listed ('e2') and coalesce(pg_temp.archived ('e2'), false)$q$
);

-- ===========================================================================
-- The hard delete
-- ===========================================================================
insert into ran select 'hard', public.retention_district_run (now() + interval '21 days 2 minutes');

select pg_temp.holds (
    'control: the hard delete scrubs and deletes e1 and removes L',
    $q$select (select (v ->> 'hard_delete')::int = 1 from ran where k = 'hard')
          and pg_temp.purged ('e1')
          and not exists (select 1 from public.studios where id = 'd5300000-0000-4000-8000-0000000005d1')$q$
);

select pg_temp.holds (
    'by L''s hard delete at the latest, e2 is scrubbed and deleted too',
    $q$select pg_temp.purged ('e2')$q$
);

select pg_temp.holds (
    'no roster student attributed to L outlives its hard delete',
    $q$select not exists (select 1 from public.managed_students
                          where district_studio_id = 'd5300000-0000-4000-8000-0000000005d1')$q$
);

-- ---------------------------------------------------------------------------
-- Report: every check, then `failures | total`
-- ---------------------------------------------------------------------------
select n, check_name, passed, detail from integrity_results order by n;

select count(*) filter (where not passed) as failures, count(*) as total from integrity_results;

rollback;
