-- Annotation payloads and colours have a checked shape
-- (migration 20261010120301_annotation_payload_shape).
--
-- Same harness and same reading as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, every check a row in integrity_results, and a
-- clean run is exactly one row reading 'ALL n CHECKS PASSED'.
--
-- Every shape the client writes is accepted -- the pen, the highlighter, text
-- notes, imported marks, suggested fingerings, handwriting turned to print, and
-- rows exactly as production holds them -- and malformed ones are refused with
-- 23514 (PostgREST 400, which the sync outbox reads as a permanent refusal) on
-- every write path: insert, update, and both batch RPCs.

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

create function pg_temp.act_as (p_uid uuid, p_session uuid default null, p_student boolean default false)
returns void language plpgsql as $$
begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
        'request.jwt.claims',
        jsonb_strip_nulls(jsonb_build_object(
            'sub', p_uid,
            'role', 'authenticated',
            'session_id', p_session,
            'app_metadata', case when p_student then jsonb_build_object('user_type', 'student') end
        ))::text,
        true
    );
end;
$$;

create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
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

-- ---------------------------------------------------------------------------
-- Fixtures (as postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
values ('c1ef0000-0000-4000-8000-00000000b7e1', 'authenticated', 'authenticated', 'payload-owner@example.invalid');

insert into public.documents (id, owner_id, title, storage_path)
values ('c1ef0000-0000-4000-8000-00000000bd01', 'c1ef0000-0000-4000-8000-00000000b7e1', 'Payload D', 'c1ef0000-0000-4000-8000-00000000bd01/original.pdf');

select pg_temp.act_as ('c1ef0000-0000-4000-8000-00000000b7e1');

-- ===========================================================================
-- Accepted: what the client writes
-- ===========================================================================
select pg_temp.allowed (
    'accepted: pen stroke, simulated pressure (as production stores it)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020001', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.12,0.4,0.5,0.13,0.41,0.5,0.15,0.43,0.5],"w":0.0025,"sp":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: pen stroke, a single dot (one triplet)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020002', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#2563eb', '{"pts":[0.5,0.5,0.5],"w":0.005,"sp":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: pen stroke, real pressure, touching both page edges',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020003', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#dc2626', '{"pts":[0,0,0.01,1,1,1],"w":0.01}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: highlighter (as production stores it)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020004', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'highlight', '#eab308', '{"pts":[0.127,0.27,0.5,1,0.85,0.5],"w":0.035,"sp":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: imported ink (src) at the widest import width',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020005', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#9333ea', '{"pts":[0.2,0.2,0.5,0.3,0.3,0.5],"w":0.02,"src":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: text note, bare (as production stores it)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020006', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#0d9488', '{"x":0.31,"y":0.06,"text":"1","size":0.0123}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: suggested fingering (sf)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020007', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#0d9488', '{"x":0.5,"y":0.17,"text":"3","size":0.012,"sf":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: imported text at the music size ceiling',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020008', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.4,"y":0.2,"text":"cresc.","size":0.16,"src":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: handwriting to print with every style flag',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020009', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#16a34a', '{"x":0.1,"y":0.1,"text":"rit.","size":0.02,"hw":1,"font":"serif","bold":1,"italic":0}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: text set in sans, italic forced',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020010', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#16a34a', '{"x":0.1,"y":0.1,"text":"dolce","size":0.02,"font":"sans","italic":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: text nudged just above the page by its top inset',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020011', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.02,"y":-0.01,"text":"p","size":0.05}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: an empty note being typed',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020012', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.5,"y":0.5,"text":"","size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: a long note (10,000 characters)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020013', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937',
               jsonb_build_object('x', 0.1, 'y', 0.1, 'size', 0.02, 'text', repeat('a', 10000)), 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: a payload key a newer client adds',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020014', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":0.005,"future":1}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: a three-digit hex colour',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020015', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#000', '{"pts":[0.1,0.1,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    1
);

select pg_temp.allowed (
    'accepted: insert_annotations_batch with client-shaped rows',
    $q$select public.insert_annotations_batch (jsonb_build_array(
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020016', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'page', 1, 'kind', 'stroke', 'color', '#2563eb',
               'payload', '{"pts":[0.3,0.3,0.5,0.31,0.32,0.5],"w":0.005,"sp":1}'::jsonb, 'created_by', 'c1ef0000-0000-4000-8000-00000000b7e1'),
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020017', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'page', 1, 'kind', 'text', 'color', '#0d9488',
               'payload', '{"x":0.2,"y":0.2,"text":"4","size":0.012,"sf":1}'::jsonb, 'created_by', 'c1ef0000-0000-4000-8000-00000000b7e1')))$q$
);

select pg_temp.holds (
    'accepted: ... both rows landed',
    $q$select count(*) = 2 from public.annotations where document_id = 'c1ef0000-0000-4000-8000-00000000bd01' and page = 1$q$
);

select pg_temp.holds (
    'accepted: patch_annotations_batch moving a note and recolouring a stroke',
    $q$select cardinality(public.patch_annotations_batch (jsonb_build_array(
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020016', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'color', '#dc2626', 'payload', '{"pts":[0.4,0.4,0.5],"w":0.01}'::jsonb)))) = 1$q$
);

select pg_temp.allowed (
    'accepted: an update that erases a mark (tombstone)',
    $q$update public.annotations set deleted_at = now() where id = 'c1ef0000-0000-4000-8000-000000020016'$q$,
    1
);

-- ===========================================================================
-- Refused: malformed payloads and colours, on every write path
-- ===========================================================================
select pg_temp.refused (
    'refused: a payload that is a string',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020018', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '"hello"', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a payload that is an array',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020019', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '[0.1,0.1,0.5]', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: an empty object for a stroke',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020020', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with no points',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020021', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke whose points are not triplets',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020022', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a highlight whose pts is an object',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020023', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'highlight', '#1f2937', '{"pts":{"x":1},"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with a string among its points',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020024', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,"x",0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with a nested array among its points',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020025', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,[0.1],0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with an absurd coordinate',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020026', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,1e300,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with no width',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020027', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5]}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with zero width',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020028', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":0}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with a string width',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020029', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":"0.005"}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke whose width is an array',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020030', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":[0.005]}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note whose x is an array',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020031', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":[0.1],"y":0.1,"text":"p","size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with sp other than 1',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020032', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":0.005,"sp":true}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note with a stroke payload',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020033', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"pts":[0.1,0.1,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a stroke with a text payload',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020034', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937', '{"x":0.1,"y":0.1,"text":"p","size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note with no text',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020035', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note whose text is a number',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020036', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"text":3,"size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note off the page',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020037', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":5,"y":0.1,"text":"p","size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note with a string coordinate',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020038', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":"0.1","y":0.1,"text":"p","size":0.02}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note of size zero',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020039', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"text":"p","size":0}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note in an unknown font',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020040', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"text":"p","size":0.02,"font":"comic"}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note with italic 2',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020041', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"text":"p","size":0.02,"italic":2}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a text note with bold true',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020042', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937', '{"x":0.1,"y":0.1,"text":"p","size":0.02,"bold":true}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a named colour',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020043', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', 'red', '{"pts":[0.1,0.1,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a colour that is not hex',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020044', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#zzzzzz', '{"pts":[0.1,0.1,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: an over-long colour',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020045', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937ff00', '{"pts":[0.1,0.1,0.5],"w":0.005}', 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a note over 10,000 characters',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020046', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'text', '#1f2937',
               jsonb_build_object('x', 0.1, 'y', 0.1, 'size', 0.02, 'text', repeat('a', 10001)), 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a payload over 1 MiB (an extra key carrying the bulk)',
    $q$insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
       values ('c1ef0000-0000-4000-8000-000000020047', 'c1ef0000-0000-4000-8000-00000000bd01', 0, 'stroke', '#1f2937',
               jsonb_build_object('pts', '[0.1,0.1,0.5]'::jsonb, 'w', 0.005, 'junk', repeat('x', 1048576)), 'c1ef0000-0000-4000-8000-00000000b7e1')$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a malformed row inside insert_annotations_batch (the whole batch)',
    $q$select public.insert_annotations_batch (jsonb_build_array(
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020048', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'page', 2, 'kind', 'stroke', 'color', '#2563eb',
               'payload', '{"pts":[0.3,0.3,0.5],"w":0.005}'::jsonb, 'created_by', 'c1ef0000-0000-4000-8000-00000000b7e1'),
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020049', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'page', 2, 'kind', 'stroke', 'color', '#2563eb',
               'payload', '"junk"'::jsonb, 'created_by', 'c1ef0000-0000-4000-8000-00000000b7e1')))$q$,
    '23514'
);

select pg_temp.holds (
    'refused: ... and nothing from that batch landed',
    $q$select count(*) = 0 from public.annotations where document_id = 'c1ef0000-0000-4000-8000-00000000bd01' and page = 2$q$
);

select pg_temp.refused (
    'refused: patch_annotations_batch replacing a payload with junk',
    $q$select public.patch_annotations_batch (jsonb_build_array(
           jsonb_build_object('id', 'c1ef0000-0000-4000-8000-000000020016', 'document_id', 'c1ef0000-0000-4000-8000-00000000bd01',
               'payload', '{"pts":"nope","w":0.005}'::jsonb)))$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a plain update to a malformed payload',
    $q$update public.annotations set payload = '{"w":0.005}' where id = 'c1ef0000-0000-4000-8000-000000020016'$q$,
    '23514'
);

select pg_temp.refused (
    'refused: a plain update to a named colour',
    $q$update public.annotations set color = 'blue' where id = 'c1ef0000-0000-4000-8000-000000020016'$q$,
    '23514'
);

-- ===========================================================================
-- The constraints are enforced, and every row already stored passes them
-- ===========================================================================
select pg_temp.act_as_server ();

select pg_temp.holds (
    'stored rows: every annotation in the database satisfies both checks',
    $q$select coalesce(bool_and(public.annotation_payload_valid (kind, payload)
                               and color ~ '^#[0-9A-Fa-f]{3,8}$'), true)
       from public.annotations$q$
);

select pg_temp.holds (
    'constraints: both are validated, not merely added',
    $q$select count(*) = 2 from pg_constraint
       where conrelid = 'public.annotations'::regclass
         and conname in ('annotations_payload_shape', 'annotations_color_hex')
         and convalidated$q$
);

select pg_temp.holds (
    'annotation_payload_valid: immutable, search_path pinned, not executable by anon',
    $q$select p.provolatile = 'i'
          and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
          and not has_function_privilege('anon', p.oid, 'execute')
       from pg_proc p
       where p.oid = 'public.annotation_payload_valid'::regproc$q$
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
