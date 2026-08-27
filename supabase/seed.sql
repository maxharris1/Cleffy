-- Local / Cloud Agent seed for the current Cleffy schema only.
-- Applied after migrations by `supabase db reset` / first `supabase start`
-- when [db.seed] is enabled in config.toml.
--
-- LOCAL DEVELOPMENT ONLY — never run against hosted Supabase.
-- No billing / plans / subscriptions tables (those are not on current `dev`).
--
-- Test accounts (password for all: cleffy-local-test):
--   teacher@cleffy.local  — owns the sample library documents
--   student@cleffy.local  — second account for share / RLS checks

-- ---------------------------------------------------------------------------
-- Storage: private scores bucket (also declared in config.toml, keep in sync)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'scores',
    'scores',
    false,
    52428800, -- 50 MiB; matches SETUP_SUPABASE.md / config.toml file_size_limit
    array['application/pdf']::text[]
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Auth users + identities (email/password sign-in)
-- ---------------------------------------------------------------------------
-- pgcrypto is preinstalled on local Supabase (extensions schema).
-- Token columns must be '' not NULL or GoTrue fails on sign-in.

with new_users as (
    insert into auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        confirmation_token,
        email_change,
        email_change_token_new,
        email_change_token_current,
        recovery_token,
        phone_change,
        phone_change_token,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    values
        (
            '00000000-0000-0000-0000-000000000000',
            'a0000000-0000-4000-8000-000000000001',
            'authenticated',
            'authenticated',
            'teacher@cleffy.local',
            extensions.crypt('cleffy-local-test', extensions.gen_salt('bf')),
            now(),
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"full_name":"Cleffy Teacher"}'::jsonb,
            now(),
            now()
        ),
        (
            '00000000-0000-0000-0000-000000000000',
            'a0000000-0000-4000-8000-000000000002',
            'authenticated',
            'authenticated',
            'student@cleffy.local',
            extensions.crypt('cleffy-local-test', extensions.gen_salt('bf')),
            now(),
            '',
            '',
            '',
            '',
            '',
            '',
            '',
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"full_name":"Cleffy Student"}'::jsonb,
            now(),
            now()
        )
    returning id, email
)
insert into auth.identities (
    id,
    user_id,
    provider,
    provider_id,
    identity_data,
    last_sign_in_at,
    created_at,
    updated_at
)
select
    extensions.gen_random_uuid(),
    id,
    'email',
    id::text,
    jsonb_build_object('sub', id::text, 'email', email),
    now(),
    now(),
    now()
from new_users;

-- ---------------------------------------------------------------------------
-- Sample library for teacher@cleffy.local (current documents schema only)
-- document_members owner rows are created by documents_owner_membership.
-- ---------------------------------------------------------------------------
insert into public.documents (id, owner_id, title, storage_path, page_count, content_rev)
values
    (
        'b0000000-0000-4000-8000-000000000001',
        'a0000000-0000-4000-8000-000000000001',
        'Bach — Invention No. 1 (seed)',
        'b0000000-0000-4000-8000-000000000001/original.pdf',
        2,
        0
    ),
    (
        'b0000000-0000-4000-8000-000000000002',
        'a0000000-0000-4000-8000-000000000001',
        'Clementi — Sonatina Op. 36 No. 1 (seed)',
        'b0000000-0000-4000-8000-000000000002/original.pdf',
        4,
        0
    ),
    (
        'b0000000-0000-4000-8000-000000000003',
        'a0000000-0000-4000-8000-000000000001',
        'Czerny — Op. 599 Excerpt (seed)',
        'b0000000-0000-4000-8000-000000000003/original.pdf',
        1,
        0
    );

insert into public.document_favorites (document_id, user_id)
values (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001'
);
