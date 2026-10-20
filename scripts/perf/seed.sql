-- Benchmark seed: a production-shaped dataset, on the LOCAL stack only —
-- never run this against hosted Supabase.
--   psql postgresql://postgres:postgres@127.0.0.1:54422/postgres -f scripts/perf/seed.sql
--
-- On top of supabase/seed.sql: 400 other accounts with 40,000 scores between
-- them, and for teacher@cleffy.local 600 more scores (every one with a
-- published cover), 50 shared with them, six tags, favorites and 2,000 strokes
-- on the newest score. Triggers are bypassed (session_replication_role =
-- replica), so owner membership rows are inserted by hand.
set session_replication_role = replica;

-- 400 other accounts, 100 scores each: the rest of the table a real
-- library query has to ignore.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, email_change, email_change_token_new, email_change_token_current,
    recovery_token, phone_change, phone_change_token, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', ('c0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
    'authenticated', 'authenticated', 'bench' || g || '@cleffy.local', '', now(), '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
from generate_series(1, 400) g
on conflict do nothing;

insert into public.documents (id, owner_id, title, storage_path, page_count, content_rev, created_at, updated_at)
select d.id, d.owner, 'Background score ' || d.n, d.id::text || '/original.pdf', 12, 0,
    now() - (d.n % 700) * interval '1 day', now() - (d.n % 700) * interval '1 day' - (d.n % 997) * interval '1 second'
from (
    select ('d' || lpad(to_hex(g), 7, '0') || '-0000-4000-8000-000000000000')::uuid as id,
        ('c0000000-0000-4000-8000-' || lpad(to_hex(1 + (g % 400)), 12, '0'))::uuid as owner, g as n
    from generate_series(1, 40000) g
) d
on conflict do nothing;

insert into public.document_members (document_id, user_id, role)
select id, owner_id, 'owner' from public.documents where title like 'Background score %'
on conflict do nothing;

-- The teacher: 600 scores of their own, spread over two years, every one
-- with a published cover (thumb_rev 0).
with composers(i, name) as (
    values (0, 'Bach'), (1, 'Beethoven'), (2, 'Chopin'), (3, 'Mozart'), (4, 'Schumann'), (5, 'Debussy'),
           (6, 'Clementi'), (7, 'Czerny'), (8, 'Haydn'), (9, 'Schubert'), (10, 'Brahms'), (11, 'Grieg')
)
insert into public.documents (id, owner_id, title, storage_path, page_count, content_rev, thumb_rev, created_at, updated_at)
select ('e0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
    'a0000000-0000-4000-8000-000000000001',
    'Study No. ' || g || ' in ' || (array['C','D','E','F','G','A','B'])[1 + g % 7] || ' (' || c.name || ')',
    ('e0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0')) || '/original.pdf',
    24, 0, 0,
    now() - g * interval '29 hours', now() - g * interval '29 hours'
from generate_series(1, 600) g
join composers c on c.i = g % 12
on conflict do nothing;

insert into public.document_members (document_id, user_id, role)
select id, owner_id, 'owner' from public.documents where id::text like 'e0000000-%'
on conflict do nothing;

-- 50 scores other teachers shared with this one.
insert into public.document_members (document_id, user_id, role)
select ('d' || lpad(to_hex(g * 7), 7, '0') || '-0000-4000-8000-000000000000')::uuid,
    'a0000000-0000-4000-8000-000000000001', 'viewer'
from generate_series(1, 50) g
on conflict do nothing;

-- Tags + favorites.
insert into public.library_tags (id, user_id, name)
select ('f0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'a0000000-0000-4000-8000-000000000001',
    (array['Recital','Grade 3','Grade 5','Sight-reading','Duets','Warm-ups'])[g]
from generate_series(1, 6) g
on conflict do nothing;

insert into public.document_tags (document_id, tag_id)
select ('e0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
    ('f0000000-0000-4000-8000-' || lpad(to_hex(1 + g % 6), 12, '0'))::uuid
from generate_series(1, 600, 3) g
on conflict do nothing;

insert into public.document_favorites (document_id, user_id)
select ('e0000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'a0000000-0000-4000-8000-000000000001'
from generate_series(1, 600, 20) g
on conflict do nothing;

-- 2000 strokes on the newest score (the one the viewer benchmark opens).
insert into public.annotations (id, document_id, page, kind, color, payload, created_by, created_at, updated_at, seq)
select extensions.gen_random_uuid(), 'e0000000-0000-4000-8000-000000000001', g % 24, 'stroke', '#e11d48',
    jsonb_build_object('w', 0.004, 'pts', (
        select jsonb_agg(v) from (
            select unnest(array[0.1 + (k * 0.01), 0.1 + ((g % 40) * 0.02), 0.5]) as v
            from generate_series(1, 24) k
        ) pts
    )),
    'a0000000-0000-4000-8000-000000000001', now(), now(), g
from generate_series(1, 2000) g
on conflict do nothing;

-- The stock seed's three scores get published covers too (seed-storage.mjs).
update public.documents set thumb_rev = 0 where id::text like 'b0000000-%';

set session_replication_role = origin;
analyze public.documents;
analyze public.document_members;
analyze public.annotations;
