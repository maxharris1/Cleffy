-- A teacher vouches for a student's age, and the record of it is kept.
--
-- A roster student never sees the age screen: their account is made by their
-- teacher through student-provision. So the teacher answers for them instead.
-- Adding a student, and restoring an archived one, now needs the student's
-- country and a ticked statement that the student is at least the consent age
-- there (consent_age(), 20261021120000_consent_age.sql). student-provision
-- refuses either action without both, and writes:
--
--  * managed_students.country / age_attested_at / age_attested_min_age — the
--    current state, on the row the teacher already reads;
--  * one teacher_attestations row per create or restore — the history: who
--    attested, for which student, which country and age, the exact sentence
--    they ticked and its wording version, and when.
--
-- Nothing about the student's birthday is asked or stored, here or anywhere.
--
-- Existing rows predate this and carry nulls; the restore flow asks the
-- teacher for them the next time it runs, and nothing reads a null as "old
-- enough".

alter table public.managed_students
    add column if not exists country text,
    add column if not exists age_attested_at timestamptz,
    add column if not exists age_attested_min_age int;

alter table public.managed_students
    drop constraint if exists managed_students_country_shape;

alter table public.managed_students
    add constraint managed_students_country_shape check (country is null or country ~ '^[A-Z]{2}$');

alter table public.managed_students
    drop constraint if exists managed_students_attestation_complete;

-- All three or none: an attestation without its country (or age) is no record at all.
alter table public.managed_students
    add constraint managed_students_attestation_complete check (
        (country is null and age_attested_at is null and age_attested_min_age is null)
        or (country is not null and age_attested_at is not null and age_attested_min_age is not null)
    );

-- The teacher reads their own roster with a column-level grant
-- (20260826194426_roster.sql, 20260827150000_student_credentials.sql); the new
-- columns join it. Writes stay the service role's alone.
grant select (country, age_attested_at, age_attested_min_age) on table public.managed_students to authenticated;

create table if not exists public.teacher_attestations (
    id uuid primary key default gen_random_uuid(),
    teacher_id uuid not null references auth.users (id) on delete cascade,
    -- Survives the student: a deleted roster row leaves the attestation that
    -- was given for it, with the link cleared.
    managed_student_id uuid references public.managed_students (id) on delete set null,
    action text not null check (action in ('create', 'restore')),
    country text not null check (country ~ '^[A-Z]{2}$'),
    min_age int not null check (min_age between 13 and 21),
    wording text not null check (length(wording) between 1 and 500),
    wording_version text not null check (length(wording_version) between 1 and 40),
    attested_at timestamptz not null default now()
);

create index if not exists teacher_attestations_teacher on public.teacher_attestations (teacher_id, attested_at desc);

create index if not exists teacher_attestations_student on public.teacher_attestations (managed_student_id);

alter table public.teacher_attestations enable row level security;

revoke all on table public.teacher_attestations from public, anon, authenticated;

grant all on table public.teacher_attestations to service_role;

-- A teacher may read what they attested; nobody but the service role writes.
drop policy if exists teacher_attestations_select on public.teacher_attestations;

create policy teacher_attestations_select on public.teacher_attestations for select to authenticated
using (teacher_id = (select auth.uid()));

grant select on table public.teacher_attestations to authenticated;
