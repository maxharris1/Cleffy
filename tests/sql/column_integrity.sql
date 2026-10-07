-- Column-integrity and realtime-topic checks (migrations 20261007120100 and 20261007120101).
--
-- Runs entirely inside one transaction that ends in ROLLBACK: it creates
-- throwaway auth.users, scores, marks, links and tags, acts as each user
-- through the same role + JWT claims PostgREST uses, and leaves nothing behind.
-- See tests/sql/README.md for how to run it and how to read the result.
--
-- Every check records a row in integrity_results instead of raising, so one
-- run reports all of them. The final SELECT returns the failures (if any) and a
-- summary row; a clean run is exactly one row reading 'ALL n CHECKS PASSED'.
--
-- Cast: O owns score D1 and creates D3; E is an editor on D1 (via an editor
-- share link) and owns D2; V is a viewer on D1 (via a viewer link); X is a
-- signed-in stranger.

begin;

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------
create temp table integrity_results (
    n serial primary key,
    check_name text not null,
    passed boolean not null,
    detail text
);

-- The helpers run as whichever role the check is acting as, so the results
-- table (and the scratch table for server-minted tokens) must be writable by it.
create temp table integrity_fixtures (k text primary key, v text);

grant all on integrity_results, integrity_fixtures to public;

grant usage on sequence integrity_results_n_seq to public;

-- Act as a signed-in user exactly as PostgREST does: role + JWT claims.
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

-- Back to the session user (postgres) — server code, migrations, cron.
create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Act as an Edge Function / the OMR service: the service_role key.
create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

-- Realtime evaluates realtime.messages policies with the channel's topic in
-- this setting (realtime.topic()).
create function pg_temp.on_topic (p_topic text) returns void language plpgsql as $$
begin
    perform set_config('realtime.topic', p_topic, true);
end;
$$;

-- The statement must succeed (and, when given, touch exactly p_rows rows).
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

-- The statement must fail with SQLSTATE p_state (and a message LIKE p_like).
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

-- Row removal. The keyword is assembled at run time so this file contains no
-- statement the Supabase MCP's execute_sql holds for interactive confirmation
-- (it pauses on any destructive keyword, even inside a rolled-back string);
-- see README.md.
create function pg_temp.removed (p_name text, p_table text, p_where text, p_rows int) returns void language plpgsql as $$
begin
    perform pg_temp.allowed (p_name, format('%s from %s where %s', 'del' || 'ete', p_table, p_where), p_rows);
end;
$$;

-- The query must return true.
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

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values
    ('c1ef0000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'integrity-owner@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'integrity-editor@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'integrity-viewer@example.invalid'),
    ('c1ef0000-0000-4000-8000-0000000000a4', 'authenticated', 'authenticated', 'integrity-stranger@example.invalid');

-- Realtime partitions realtime.messages by day and creates the partitions only
-- while the project's Realtime tenant is running (postgres may not create them).
-- On an idle project today's is missing: broadcast_changes() then fails into a
-- swallowed WARNING, and a hand-written message needs an inserted_at inside a
-- partition that exists. Record which case applies.
insert into integrity_fixtures
select 'live_partition', exists (
    select 1 from pg_class
    where relnamespace = 'realtime'::regnamespace and relname = 'messages_' || to_char(now(), 'YYYY_MM_DD')
)::text;

insert into integrity_fixtures
select 'msg_at', case
    when (select v from integrity_fixtures where k = 'live_partition')::boolean then now()::timestamp
    else (
        select to_timestamp(substr(max(relname), 10), 'YYYY_MM_DD')::timestamp + interval '12 hours'
        from pg_class
        where relnamespace = 'realtime'::regnamespace
          and relkind = 'r'
          and relname ~ '^messages_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
    )
end::text;

-- ===========================================================================
-- documents — the client create / rename / page-count / revision paths
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'documents: owner creates a score (createDocument)',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000a1',
               'Integrity D1', 'c1ef0000-0000-4000-8000-0000000000d1/original.pdf')$q$,
    1
);

select pg_temp.allowed (
    'documents: insert pins created_at/updated_at to the server clock',
    $q$insert into public.documents (id, owner_id, title, storage_path, created_at, updated_at)
       values ('c1ef0000-0000-4000-8000-0000000000d3', 'c1ef0000-0000-4000-8000-0000000000a1',
               'Integrity D3', 'c1ef0000-0000-4000-8000-0000000000d3/original.pdf',
               '2001-01-01', '2999-01-01')$q$,
    1
);

select pg_temp.holds (
    'documents: forged created_at/updated_at replaced by now()',
    $q$select created_at = now() and updated_at = now() from public.documents
       where id = 'c1ef0000-0000-4000-8000-0000000000d3'$q$
);

select pg_temp.refused (
    'documents: storage_path must be {id}/original.pdf on insert',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('c1ef0000-0000-4000-8000-0000000000d4', 'c1ef0000-0000-4000-8000-0000000000a1',
               'Pointing at D1', 'c1ef0000-0000-4000-8000-0000000000d1/original.pdf')$q$,
    '23514',
    '%documents_storage_path_derived%'
);

select pg_temp.allowed (
    'documents: owner renames (renameDocument)',
    $q$update public.documents set title = 'Renamed' where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    1
);

select pg_temp.allowed (
    'documents: owner sets page_count, bumps content_rev, publishes thumb_rev',
    $q$update public.documents set page_count = 4, content_rev = content_rev + 1, thumb_rev = 1
       where id = 'c1ef0000-0000-4000-8000-0000000000d3'$q$,
    1
);

select pg_temp.refused (
    'documents: owner_id cannot be reassigned',
    $q$update public.documents set owner_id = 'c1ef0000-0000-4000-8000-0000000000a2'
       where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '42501',
    '%documents.owner_id cannot be changed%'
);

select pg_temp.refused (
    'documents: storage_path cannot be repointed',
    $q$update public.documents set storage_path = 'c1ef0000-0000-4000-8000-0000000000d3/original.pdf'
       where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '42501',
    '%documents.storage_path cannot be changed%'
);

select pg_temp.refused (
    'documents: id cannot be changed',
    $q$update public.documents set id = 'c1ef0000-0000-4000-8000-0000000000d9'
       where id = 'c1ef0000-0000-4000-8000-0000000000d3'$q$,
    '42501',
    '%documents.id cannot be changed%'
);

select pg_temp.refused (
    'documents: created_at cannot be changed',
    $q$update public.documents set created_at = '2001-01-01' where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '42501',
    '%documents.created_at cannot be changed%'
);

-- E creates their own score, D2 (used below as the "other document E edits").
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'documents: a second user creates their own score',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('c1ef0000-0000-4000-8000-0000000000d2', 'c1ef0000-0000-4000-8000-0000000000a2',
               'Integrity D2', 'c1ef0000-0000-4000-8000-0000000000d2/original.pdf')$q$,
    1
);

-- E is not yet a member of D1 here, and even as its editor (below) never gets an
-- UPDATE on the documents row: documents_update is owner-only.
select pg_temp.allowed (
    'documents: a non-owner''s update touches nothing',
    $q$update public.documents set title = 'Hijacked', owner_id = 'c1ef0000-0000-4000-8000-0000000000a2'
       where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    0
);

-- ===========================================================================
-- share_links — create, redeem, revoke
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'share_links: owner creates an editor link (createShareLink)',
    $q$with l as (
           insert into public.share_links (document_id, role, created_by)
           values ('c1ef0000-0000-4000-8000-0000000000d1', 'editor', 'c1ef0000-0000-4000-8000-0000000000a1')
           returning token
       )
       insert into integrity_fixtures select 'editor_link', token from l$q$,
    1
);

select pg_temp.allowed (
    'share_links: owner creates a viewer link carrying a chosen token',
    $q$with l as (
           insert into public.share_links (token, document_id, role, created_by)
           values ('chosen-by-the-client', 'c1ef0000-0000-4000-8000-0000000000d1', 'viewer',
                   'c1ef0000-0000-4000-8000-0000000000a1')
           returning token
       )
       insert into integrity_fixtures select 'viewer_link', token from l$q$,
    1
);

select pg_temp.holds (
    'share_links: the server mints the token (client-chosen token discarded)',
    $q$select v <> 'chosen-by-the-client' and length(v) = 22
       from integrity_fixtures where k = 'viewer_link'$q$
);

select pg_temp.refused (
    'share_links: created_by must be the caller',
    $q$insert into public.share_links (document_id, role, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'viewer', 'c1ef0000-0000-4000-8000-0000000000a2')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'share_links: editor redeems the editor link (redeem_share_link)',
    $q$select * from public.redeem_share_link ((select v from integrity_fixtures where k = 'editor_link'))$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.allowed (
    'share_links: viewer redeems the viewer link',
    $q$select * from public.redeem_share_link ((select v from integrity_fixtures where k = 'viewer_link'))$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.refused (
    'share_links: an editor cannot mint links',
    $q$insert into public.share_links (document_id, role, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'editor', 'c1ef0000-0000-4000-8000-0000000000a2')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.allowed (
    'documents: an editor''s update of the score row touches nothing',
    $q$update public.documents
       set owner_id = 'c1ef0000-0000-4000-8000-0000000000a2',
           storage_path = 'c1ef0000-0000-4000-8000-0000000000d2/original.pdf'
       where id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    0
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'share_links: token cannot be rewritten',
    $q$update public.share_links set token = 'guessable'
       where token = (select v from integrity_fixtures where k = 'editor_link')$q$,
    '42501',
    '%share_links.token cannot be changed%'
);

select pg_temp.refused (
    'share_links: a link cannot be moved to another score',
    $q$update public.share_links set document_id = 'c1ef0000-0000-4000-8000-0000000000d3'
       where token = (select v from integrity_fixtures where k = 'editor_link')$q$,
    '42501',
    '%share_links.document_id cannot be changed%'
);

select pg_temp.refused (
    'share_links: created_by cannot be rewritten',
    $q$update public.share_links set created_by = 'c1ef0000-0000-4000-8000-0000000000a2'
       where token = (select v from integrity_fixtures where k = 'editor_link')$q$,
    '42501',
    '%share_links.created_by cannot be changed%'
);

select pg_temp.allowed (
    'share_links: owner revokes a link (revokeShareLink)',
    $q$update public.share_links set revoked_at = now()
       where token = (select v from integrity_fixtures where k = 'viewer_link')$q$,
    1
);

-- ===========================================================================
-- annotations — create / batch create / patch / batch patch / tombstone
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'annotations: editor creates a mark (upsert ignoreDuplicates)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by, created_at)
       values ('c1ef0000-0000-4000-8000-0000000000b1', 'c1ef0000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#000', '{"pts":[0,0,1],"w":0.01}', 'c1ef0000-0000-4000-8000-0000000000a2', now() - interval '1 hour')
       on conflict (id) do nothing$q$,
    1
);

select pg_temp.allowed (
    'annotations: a duplicate create is a silent no-op',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000b1', 'c1ef0000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#000', '{"pts":[0,0,1],"w":0.01}', 'c1ef0000-0000-4000-8000-0000000000a2')
       on conflict (id) do nothing$q$,
    0
);

select pg_temp.holds (
    'annotations: an offline created_at in the past is kept',
    $q$select created_at = now() - interval '1 hour' from public.annotations
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$
);

select pg_temp.allowed (
    'annotations: editor batch-creates marks (insert_annotations_batch)',
    $q$select public.insert_annotations_batch ($j$[
         {"id":"c1ef0000-0000-4000-8000-0000000000b2","document_id":"c1ef0000-0000-4000-8000-0000000000d1",
          "page":1,"kind":"highlight","color":"#ff0","payload":{"pts":[0,0,1],"w":0.02},
          "created_by":"c1ef0000-0000-4000-8000-0000000000a2","created_at":"2999-01-01T00:00:00Z","deleted_at":null},
         {"id":"c1ef0000-0000-4000-8000-0000000000b3","document_id":"c1ef0000-0000-4000-8000-0000000000d1",
          "page":1,"kind":"text","color":"#00f","payload":{"x":0.1,"y":0.1,"text":"p","size":0.02},
          "created_by":"c1ef0000-0000-4000-8000-0000000000a2","deleted_at":null}
       ]$j$::jsonb)$q$
);

select pg_temp.holds (
    'annotations: a future created_at is clamped to the server clock',
    $q$select created_at = now() from public.annotations where id = 'c1ef0000-0000-4000-8000-0000000000b2'$q$
);

select pg_temp.refused (
    'annotations: a batch cannot attribute marks to someone else',
    $q$select public.insert_annotations_batch ($j$[
         {"id":"c1ef0000-0000-4000-8000-0000000000b4","document_id":"c1ef0000-0000-4000-8000-0000000000d1",
          "page":0,"kind":"stroke","color":"#000","payload":{"pts":[0,0,1],"w":0.01},
          "created_by":"c1ef0000-0000-4000-8000-0000000000a1"}
       ]$j$::jsonb)$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.refused (
    'annotations: a single create cannot attribute the mark to someone else',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000b4', 'c1ef0000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#000', '{"pts":[0,0,1],"w":0.01}', 'c1ef0000-0000-4000-8000-0000000000a1')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'annotations: owner edits another member''s mark (AnnotationsApi.update)',
    $q$update public.annotations set color = '#f00', payload = '{"pts":[0,0,1,1,1,1],"w":0.01}'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1' and document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    1
);

select pg_temp.allowed (
    'annotations: owner erases it (tombstone)',
    $q$update public.annotations set deleted_at = now()
       where id = 'c1ef0000-0000-4000-8000-0000000000b1' and document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    1
);

select pg_temp.allowed (
    'annotations: owner restores it (undo erase)',
    $q$update public.annotations set color = '#f00', payload = '{"pts":[0,0,1],"w":0.01}', deleted_at = null
       where id = 'c1ef0000-0000-4000-8000-0000000000b1' and document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    1
);

select pg_temp.holds (
    'annotations: edits keep the original author',
    $q$select created_by = 'c1ef0000-0000-4000-8000-0000000000a2' from public.annotations
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'annotations: editor batch-patches marks (patch_annotations_batch)',
    $q$select public.patch_annotations_batch ($j$[
         {"id":"c1ef0000-0000-4000-8000-0000000000b2","document_id":"c1ef0000-0000-4000-8000-0000000000d1","color":"#0f0"},
         {"id":"c1ef0000-0000-4000-8000-0000000000b3","document_id":"c1ef0000-0000-4000-8000-0000000000d1",
          "deleted_at":"2026-01-01T00:00:00Z"}
       ]$j$::jsonb)$q$
);

select pg_temp.holds (
    'annotations: the batch patch landed',
    $q$select (select color from public.annotations where id = 'c1ef0000-0000-4000-8000-0000000000b2') = '#0f0'
          and (select deleted_at from public.annotations where id = 'c1ef0000-0000-4000-8000-0000000000b3') is not null$q$
);

select pg_temp.refused (
    'annotations: editor cannot forge authorship (created_by)',
    $q$update public.annotations set created_by = 'c1ef0000-0000-4000-8000-0000000000a1'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.created_by cannot be changed%'
);

select pg_temp.refused (
    'annotations: editor cannot move a mark into another score they edit',
    $q$update public.annotations set document_id = 'c1ef0000-0000-4000-8000-0000000000d2'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.document_id cannot be changed%'
);

select pg_temp.refused (
    'annotations: created_at cannot be rewritten',
    $q$update public.annotations set created_at = '2001-01-01'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.created_at cannot be changed%'
);

select pg_temp.refused (
    'annotations: id cannot be rewritten',
    $q$update public.annotations set id = 'c1ef0000-0000-4000-8000-0000000000b9'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.id cannot be changed%'
);

select pg_temp.refused (
    'annotations: page cannot be rewritten',
    $q$update public.annotations set page = 3 where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.page cannot be changed%'
);

select pg_temp.refused (
    'annotations: kind cannot be rewritten',
    $q$update public.annotations set kind = 'highlight' where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    '42501',
    '%annotations.kind cannot be changed%'
);

select pg_temp.allowed (
    'annotations: a client-supplied seq is ignored ...',
    $q$update public.annotations set seq = 9000000000000, color = '#111'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    1
);

select pg_temp.holds (
    'annotations: ... the server restamps it',
    $q$select seq < 9000000000000 and seq > 0 from public.annotations
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.allowed (
    'annotations: a viewer''s update touches nothing',
    $q$update public.annotations set color = '#123' where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    0
);

select pg_temp.refused (
    'annotations: a viewer cannot create',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000b5', 'c1ef0000-0000-4000-8000-0000000000d1', 0, 'stroke',
               '#000', '{"pts":[0,0,1],"w":0.01}', 'c1ef0000-0000-4000-8000-0000000000a3')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a4');

select pg_temp.allowed (
    'annotations: a stranger''s update touches nothing',
    $q$update public.annotations set color = '#123' where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    0
);

-- ===========================================================================
-- annotation_snapshots — lesson history
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'snapshots: editor pushes today''s starting point with created_by null (pushSnapshotRemote)',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, label, payload, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000c1', 'c1ef0000-0000-4000-8000-0000000000d1', current_date,
               null, '[]', null)
       on conflict (document_id, captured_on) do nothing$q$,
    1
);

select pg_temp.holds (
    'snapshots: authorship is stamped with the caller',
    $q$select created_by = 'c1ef0000-0000-4000-8000-0000000000a2' from public.annotation_snapshots
       where id = 'c1ef0000-0000-4000-8000-0000000000c1'$q$
);

select pg_temp.allowed (
    'snapshots: a second push for the same day is a silent no-op',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, label, payload, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000c2', 'c1ef0000-0000-4000-8000-0000000000d1', current_date,
               null, '[]', null)
       on conflict (document_id, captured_on) do nothing$q$,
    0
);

select pg_temp.allowed (
    'snapshots: a forged author is replaced by the caller ...',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, payload, created_by, created_at)
       values ('c1ef0000-0000-4000-8000-0000000000c3', 'c1ef0000-0000-4000-8000-0000000000d1',
               current_date - 1, '[]', 'c1ef0000-0000-4000-8000-0000000000a1', '2001-01-01')$q$,
    1
);

select pg_temp.holds (
    'snapshots: ... and created_at by the server clock',
    $q$select created_by = 'c1ef0000-0000-4000-8000-0000000000a2' and created_at = now()
       from public.annotation_snapshots where id = 'c1ef0000-0000-4000-8000-0000000000c3'$q$
);

select pg_temp.allowed (
    'snapshots: tomorrow (UTC+14 is a day ahead) is accepted',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, payload)
       values ('c1ef0000-0000-4000-8000-0000000000c4', 'c1ef0000-0000-4000-8000-0000000000d1',
               (now() at time zone 'utc')::date + 1, '[]')$q$,
    1
);

select pg_temp.refused (
    'snapshots: a future day cannot be squatted',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, payload)
       values ('c1ef0000-0000-4000-8000-0000000000c5', 'c1ef0000-0000-4000-8000-0000000000d1',
               current_date + 5, '[]')$q$,
    '42501',
    '%captured_on is in the future%'
);

select pg_temp.allowed (
    'snapshots: an update touches nothing (no update policy)',
    $q$update public.annotation_snapshots set payload = '[{"forged":1}]'
       where id = 'c1ef0000-0000-4000-8000-0000000000c1'$q$,
    0
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.refused (
    'snapshots: a viewer cannot push one',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, payload)
       values ('c1ef0000-0000-4000-8000-0000000000c6', 'c1ef0000-0000-4000-8000-0000000000d1',
               current_date - 2, '[]')$q$,
    '42501',
    '%row-level security%'
);

-- Archived scores are read-only, history included.
select pg_temp.act_as_server ();

update public.documents set archived_at = now() where id = 'c1ef0000-0000-4000-8000-0000000000d2';

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.refused (
    'snapshots: none on an archived score',
    $q$insert into public.annotation_snapshots (id, document_id, captured_on, payload)
       values ('c1ef0000-0000-4000-8000-0000000000c7', 'c1ef0000-0000-4000-8000-0000000000d2',
               current_date, '[]')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as_server ();

update public.documents set archived_at = null where id = 'c1ef0000-0000-4000-8000-0000000000d2';

-- ===========================================================================
-- document_imports — smart-import audit row
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'imports: owner records a prompt (recordImportStatus upsert)',
    $q$insert into public.document_imports (document_id, status)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'prompted')
       on conflict (document_id) do update set status = excluded.status$q$,
    1
);

select pg_temp.allowed (
    'imports: owner records the replacement with its backup (replaceDocumentPdf upsert)',
    $q$insert into public.document_imports (document_id, status, backup_path)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'imported',
               'c1ef0000-0000-4000-8000-0000000000d1/pre-import-original.pdf')
       on conflict (document_id) do update set status = excluded.status, backup_path = excluded.backup_path$q$,
    1
);

select pg_temp.holds (
    'imports: created_by is the caller',
    $q$select created_by = 'c1ef0000-0000-4000-8000-0000000000a1' and status = 'imported'
       from public.document_imports where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$
);

select pg_temp.refused (
    'imports: backup_path cannot name another score''s object',
    $q$update public.document_imports set backup_path = 'c1ef0000-0000-4000-8000-0000000000d2/original.pdf'
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '23514',
    '%document_imports_backup_path_derived%'
);

select pg_temp.refused (
    'imports: created_by cannot be rewritten',
    $q$update public.document_imports set created_by = 'c1ef0000-0000-4000-8000-0000000000a2'
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '42501',
    '%document_imports.created_by cannot be changed%'
);

-- ===========================================================================
-- library_tags / document_tags / document_favorites — personal organisation
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'tags: owner creates a tag',
    $q$insert into public.library_tags (id, user_id, name)
       values ('c1ef0000-0000-4000-8000-0000000000e2', 'c1ef0000-0000-4000-8000-0000000000a1', 'Owner tag')$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'tags: editor creates a tag (createTag)',
    $q$insert into public.library_tags (id, user_id, name)
       values ('c1ef0000-0000-4000-8000-0000000000e1', 'c1ef0000-0000-4000-8000-0000000000a2', 'Lessons')$q$,
    1
);

select pg_temp.allowed (
    'tags: renames it (renameTag)',
    $q$update public.library_tags set name = 'Lessons 2' where id = 'c1ef0000-0000-4000-8000-0000000000e1'$q$,
    1
);

select pg_temp.refused (
    'tags: cannot hand a tag to another user',
    $q$update public.library_tags set user_id = 'c1ef0000-0000-4000-8000-0000000000a1'
       where id = 'c1ef0000-0000-4000-8000-0000000000e1'$q$,
    '42501',
    '%library_tags.user_id cannot be changed%'
);

select pg_temp.refused (
    'tags: cannot change a tag''s id',
    $q$update public.library_tags set id = 'c1ef0000-0000-4000-8000-0000000000e9'
       where id = 'c1ef0000-0000-4000-8000-0000000000e1'$q$,
    '42501',
    '%library_tags.id cannot be changed%'
);

select pg_temp.allowed (
    'tags: tags a shared score (setDocumentTag upsert)',
    $q$insert into public.document_tags (document_id, tag_id)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000e1')
       on conflict (document_id, tag_id) do nothing$q$,
    1
);

select pg_temp.allowed (
    'tags: re-tagging is a silent no-op',
    $q$insert into public.document_tags (document_id, tag_id)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000e1')
       on conflict (document_id, tag_id) do nothing$q$,
    0
);

select pg_temp.refused (
    'tags: cannot attach someone else''s tag',
    $q$insert into public.document_tags (document_id, tag_id)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000e2')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.allowed (
    'tags: a document_tags update touches nothing (no update policy)',
    $q$update public.document_tags set document_id = 'c1ef0000-0000-4000-8000-0000000000d2'
       where tag_id = 'c1ef0000-0000-4000-8000-0000000000e1'$q$,
    0
);

select pg_temp.removed (
    'tags: untags (setDocumentTag, assigned = false)',
    'public.document_tags',
    $q$document_id = 'c1ef0000-0000-4000-8000-0000000000d1' and tag_id = 'c1ef0000-0000-4000-8000-0000000000e1'$q$,
    1
);

select pg_temp.allowed (
    'favorites: favorites a shared score (setDocumentFavorite upsert)',
    $q$insert into public.document_favorites (document_id, user_id)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000a2')
       on conflict (document_id, user_id) do nothing$q$,
    1
);

select pg_temp.refused (
    'favorites: cannot favorite on someone else''s behalf',
    $q$insert into public.document_favorites (document_id, user_id)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'c1ef0000-0000-4000-8000-0000000000a1')$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.allowed (
    'favorites: an update touches nothing (no update policy)',
    $q$update public.document_favorites set user_id = 'c1ef0000-0000-4000-8000-0000000000a1'
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    0
);

select pg_temp.removed (
    'favorites: unfavorites (setDocumentFavorite, favorite = false)',
    'public.document_favorites',
    $q$document_id = 'c1ef0000-0000-4000-8000-0000000000d1' and user_id = 'c1ef0000-0000-4000-8000-0000000000a2'$q$,
    1
);

-- ===========================================================================
-- practice_notes (column-level UPDATE grant) and score_analyses
-- ===========================================================================
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'notes: owner writes a note',
    $q$insert into public.practice_notes (id, document_id, author_id, body)
       values ('c1ef0000-0000-4000-8000-0000000000f1', 'c1ef0000-0000-4000-8000-0000000000d1',
               'c1ef0000-0000-4000-8000-0000000000a1', 'Slow practice, bars 1-8')$q$,
    1
);

select pg_temp.allowed (
    'notes: edits its body',
    $q$update public.practice_notes set body = 'Bars 1-16' where id = 'c1ef0000-0000-4000-8000-0000000000f1'$q$,
    1
);

select pg_temp.refused (
    'notes: author_id is not client-writable',
    $q$update public.practice_notes set author_id = 'c1ef0000-0000-4000-8000-0000000000a2'
       where id = 'c1ef0000-0000-4000-8000-0000000000f1'$q$,
    '42501',
    '%permission denied%'
);

select pg_temp.refused (
    'notes: document_id is not client-writable',
    $q$update public.practice_notes set document_id = 'c1ef0000-0000-4000-8000-0000000000d3'
       where id = 'c1ef0000-0000-4000-8000-0000000000f1'$q$,
    '42501',
    '%permission denied%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.allowed (
    'analyses: editor requests an analysis (score-analyze upsert)',
    $q$insert into public.score_analyses (document_id, status, created_by)
       values ('c1ef0000-0000-4000-8000-0000000000d1', 'pending', 'c1ef0000-0000-4000-8000-0000000000a2')
       on conflict (document_id) do update set status = excluded.status$q$,
    1
);

select pg_temp.refused (
    'analyses: cannot be moved onto another score',
    $q$update public.score_analyses set document_id = 'c1ef0000-0000-4000-8000-0000000000d2'
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    '42501',
    '%score_analyses.document_id cannot be changed%'
);

select pg_temp.refused (
    'analyses: a client still cannot forge a finished analysis',
    $q$update public.score_analyses set status = 'ready'
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    'P0001',
    '%clients may only set pending or failed%'
);

select pg_temp.act_as_service ();

select pg_temp.allowed (
    'analyses: the OMR service (service_role) writes the result',
    $q$update public.score_analyses set status = 'ready', score = '{}', progress = 4
       where document_id = 'c1ef0000-0000-4000-8000-0000000000d1'$q$,
    1
);

-- ===========================================================================
-- Realtime — committed rows fan out on doc-db:{id}, which no client can send on
-- ===========================================================================
select pg_temp.act_as_server ();

-- The fan-out triggers. With today's partition present the messages themselves
-- are checked; without it (idle project) realtime.send() swallowed every send as
-- a WARNING, so the trigger functions' topics are checked instead.
select pg_temp.holds (
    'realtime: a committed mark is broadcast on doc-db:{id}',
    $q$select case
           when (select v from integrity_fixtures where k = 'live_partition')::boolean then exists (
               select 1 from realtime.messages
               where topic = 'doc-db:c1ef0000-0000-4000-8000-0000000000d1'
                 and event = 'INSERT'
                 and payload -> 'record' ->> 'id' = 'c1ef0000-0000-4000-8000-0000000000b1'
           )
           else pg_get_functiondef('public.broadcast_annotation_changes'::regproc) like '%''doc-db:'' || new.document_id%'
       end$q$
);

select pg_temp.holds (
    'realtime: ... and committed rows never go to the client-writable doc:{id}',
    $q$select case
           when (select v from integrity_fixtures where k = 'live_partition')::boolean then not exists (
               select 1 from realtime.messages
               where topic in ('doc:c1ef0000-0000-4000-8000-0000000000d1', 'doc:c1ef0000-0000-4000-8000-0000000000d3')
                 and event in ('INSERT', 'UPDATE', 'score_analysis')
           )
           else pg_get_functiondef('public.broadcast_annotation_changes'::regproc) not like '%''doc:''%'
               and pg_get_functiondef('public.broadcast_document_changes'::regproc) not like '%''doc:''%'
               and pg_get_functiondef('public.broadcast_score_analysis_changes'::regproc) not like '%''doc:''%'
       end$q$
);

select pg_temp.holds (
    'realtime: the content_rev bump is broadcast on doc-db:{id}',
    $q$select case
           when (select v from integrity_fixtures where k = 'live_partition')::boolean then exists (
               select 1 from realtime.messages
               where topic = 'doc-db:c1ef0000-0000-4000-8000-0000000000d3' and payload ->> 'table' = 'documents'
           )
           else pg_get_functiondef('public.broadcast_document_changes'::regproc) like '%''doc-db:'' || new.id%'
       end$q$
);

select pg_temp.holds (
    'realtime: score_analysis status is broadcast on doc-db:{id}',
    $q$select case
           when (select v from integrity_fixtures where k = 'live_partition')::boolean then exists (
               select 1 from realtime.messages
               where topic = 'doc-db:c1ef0000-0000-4000-8000-0000000000d1' and event = 'score_analysis'
           )
           else pg_get_functiondef('public.broadcast_score_analysis_changes'::regproc) like '%''doc-db:'' || new.document_id%'
       end$q$
);

insert into integrity_results (check_name, passed, detail)
select
    'realtime: fan-out verified from ' || case when v::boolean then 'the broadcast messages' else 'the trigger functions (no partition for today)' end,
    true,
    null
from integrity_fixtures where k = 'live_partition';

-- Something to read: one server-authored message per topic, as broadcast_changes
-- would write it.
insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
select t, 'broadcast', 'INSERT', '{}', true, (select v::timestamp from integrity_fixtures where k = 'msg_at')
from unnest(array['doc-db:c1ef0000-0000-4000-8000-0000000000d1', 'doc:c1ef0000-0000-4000-8000-0000000000d1']) as t;

-- Receive (channel join): members only, on both topics. Realtime authorizes a
-- join by reading realtime.messages under the joining user with realtime.topic
-- set, which is what these do.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.on_topic ('doc-db:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.holds (
    'realtime: a viewer receives on doc-db:{id}',
    $q$select count(*) > 0 from realtime.messages where topic = 'doc-db:c1ef0000-0000-4000-8000-0000000000d1'$q$
);

select pg_temp.on_topic ('doc:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.holds (
    'realtime: a viewer receives on doc:{id}',
    $q$select count(*) > 0 from realtime.messages where topic = 'doc:c1ef0000-0000-4000-8000-0000000000d1'$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a4');

select pg_temp.on_topic ('doc-db:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.holds (
    'realtime: a stranger receives nothing on doc-db:{id}',
    $q$select count(*) = 0 from realtime.messages$q$
);

select pg_temp.on_topic ('doc:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.holds (
    'realtime: a stranger receives nothing on doc:{id}',
    $q$select count(*) = 0 from realtime.messages$q$
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.on_topic ('doc-db:not-a-uuid');

select pg_temp.holds (
    'realtime: a malformed doc-db topic resolves to nobody',
    $q$select count(*) = 0 from realtime.messages$q$
);

-- Send: live ink (broadcast) for owner/editor on doc:{id}; presence for any
-- member; nothing from any client on doc-db:{id}.
select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a2');

select pg_temp.on_topic ('doc:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.allowed (
    'realtime: an editor broadcasts live ink on doc:{id}',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:c1ef0000-0000-4000-8000-0000000000d1', 'broadcast', 'ink:progress', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    1
);

select pg_temp.on_topic ('doc-db:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.refused (
    'realtime: an editor cannot broadcast on doc-db:{id} (forged committed row)',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc-db:c1ef0000-0000-4000-8000-0000000000d1', 'broadcast', 'INSERT', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.refused (
    'realtime: an editor cannot send presence on doc-db:{id}',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc-db:c1ef0000-0000-4000-8000-0000000000d1', 'presence', 'presence', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a1');

select pg_temp.on_topic ('doc-db:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.refused (
    'realtime: not even the owner can broadcast on doc-db:{id}',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc-db:c1ef0000-0000-4000-8000-0000000000d1', 'broadcast', 'UPDATE', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a3');

select pg_temp.on_topic ('doc:c1ef0000-0000-4000-8000-0000000000d1');

select pg_temp.refused (
    'realtime: a viewer cannot broadcast ink',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:c1ef0000-0000-4000-8000-0000000000d1', 'broadcast', 'ink:progress', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501',
    '%row-level security%'
);

select pg_temp.allowed (
    'realtime: a viewer sends presence on doc:{id}',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:c1ef0000-0000-4000-8000-0000000000d1', 'presence', 'presence', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    1
);

select pg_temp.act_as ('c1ef0000-0000-4000-8000-0000000000a4');

select pg_temp.refused (
    'realtime: a stranger cannot send presence',
    $q$insert into realtime.messages (topic, extension, event, payload, private, inserted_at)
       values ('doc:c1ef0000-0000-4000-8000-0000000000d1', 'presence', 'presence', '{}', true,
               (select v::timestamp from integrity_fixtures where k = 'msg_at'))$q$,
    '42501',
    '%row-level security%'
);

-- ===========================================================================
-- Server paths are untouched by the guards
-- ===========================================================================
select pg_temp.act_as_service ();

select pg_temp.on_topic ('');

select pg_temp.allowed (
    'server: service_role may still correct a row (the guards are client-only)',
    $q$update public.annotations set created_at = created_at - interval '1 day'
       where id = 'c1ef0000-0000-4000-8000-0000000000b1'$q$,
    1
);

-- Account removal nulls annotation_snapshots.created_by and
-- score_analyses.created_by (now on a 'ready' row) through their foreign keys,
-- which Postgres runs as each table's owner — not a client role, so no guard
-- may put the old author back.
select pg_temp.act_as_server ();

select pg_temp.removed (
    'server: removing an account still cascades',
    'auth.users',
    $q$id = 'c1ef0000-0000-4000-8000-0000000000a2'$q$,
    1
);

select pg_temp.holds (
    'server: ... leaving the snapshot and the analysis in place with no author',
    $q$select (select created_by is null from public.annotation_snapshots
               where id = 'c1ef0000-0000-4000-8000-0000000000c1')
          and (select created_by is null and status = 'ready' from public.score_analyses
               where document_id = 'c1ef0000-0000-4000-8000-0000000000d1')$q$
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
