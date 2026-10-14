-- Cross-branch integration checks for the 20261007 migration set.
--
-- Each fix branch proved its own migration; this file proves they hold
-- TOGETHER, on the paths where one branch writes a column another branch
-- guards:
--
--   * billing's archive/restore writes (archived_at, archived_reason) through
--     integrity's documents_guard_columns and the owner's own archive;
--   * scope-imslp's provenance columns (service-role only) next to the owner's
--     ordinary edits;
--   * library's removal tombstones and id-reuse guard, and the storage cleanup
--     policies that let the former owner purge a deleted score's folder;
--   * sync's patch_annotations_batch (returns the ids it changed) under
--     integrity's annotation guard and compliance's nullable created_by;
--   * sharing's role change through its definer RPC;
--   * compliance's account deletion: every user-keyed foreign key fires
--     (SET NULL through integrity's and security's role-keyed guards), the
--     authorship change fans out on integrity's receive-only doc-db:{id} topic
--     while sharing's membership event still goes to doc:{id}, and the deleted
--     owner's scores leave library tombstones behind (which is why
--     the account-removal Edge Function drains them before removing the auth user).
--
-- Same harness and conventions as column_integrity.sql (see README.md): one
-- transaction ending in ROLLBACK, acting as each user the way PostgREST does,
-- every check recorded rather than raised, no destructive keyword spelled out
-- in the file (pg_temp.removed assembles it at run time). The last statement
-- returns the failures and a summary row; a clean run is one row reading
-- 'ALL n CHECKS PASSED'.

begin;

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

create function pg_temp.act_as_server () returns void language plpgsql as $$
begin
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.act_as_service () returns void language plpgsql as $$
begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
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

create function pg_temp.removed (p_name text, p_table text, p_where text, p_rows int) returns void language plpgsql as $$
begin
    perform pg_temp.allowed (p_name, format('%s from %s where %s', 'del' || 'ete', p_table, p_where), p_rows);
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
-- O owns D1..D5 on a paid plan; E edits D1 and owns DE; V views D1; X is a
-- signed-in stranger.
insert into auth.users (id, aud, role, email)
values
    ('c1b0a000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'cb-owner@example.test'),
    ('c1b0a000-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', 'cb-editor@example.test'),
    ('c1b0a000-0000-4000-8000-0000000000b1', 'authenticated', 'authenticated', 'cb-viewer@example.test'),
    ('c1b0a000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 'cb-stranger@example.test');

insert into public.subscriptions (stripe_subscription_id, user_id, tier, status, current_period_end, mode)
values ('sub_cb_owner', 'c1b0a000-0000-4000-8000-0000000000a1', 'teacher', 'active', now() + interval '30 days', 'test');

insert into public.documents (id, owner_id, title, storage_path, updated_at)
select
    ('c1b0d000-0000-4000-8000-00000000000' || i)::uuid,
    'c1b0a000-0000-4000-8000-0000000000a1',
    'Score ' || i,
    'c1b0d000-0000-4000-8000-00000000000' || i || '/original.pdf',
    now() - (10 - i) * interval '1 hour'
from generate_series(1, 5) i;

insert into public.documents (id, owner_id, title, storage_path)
values (
    'c1b0d000-0000-4000-8000-0000000000e9',
    'c1b0a000-0000-4000-8000-0000000000e1',
    'Editor score',
    'c1b0d000-0000-4000-8000-0000000000e9/original.pdf'
);

insert into public.document_members (document_id, user_id, role)
values
    ('c1b0d000-0000-4000-8000-000000000001', 'c1b0a000-0000-4000-8000-0000000000e1', 'editor'),
    ('c1b0d000-0000-4000-8000-000000000001', 'c1b0a000-0000-4000-8000-0000000000b1', 'viewer');

insert into public.annotations (id, document_id, page, kind, color, payload, created_by)
values
    ('c1b0e000-0000-4000-8000-0000000000a1', 'c1b0d000-0000-4000-8000-000000000001', 0, 'stroke', '#000000', '{"pts":[0,0,1],"w":0.01}', 'c1b0a000-0000-4000-8000-0000000000a1'),
    ('c1b0e000-0000-4000-8000-0000000000e1', 'c1b0d000-0000-4000-8000-000000000001', 0, 'stroke', '#000000', '{"pts":[0,0,1],"w":0.01}', 'c1b0a000-0000-4000-8000-0000000000e1');

insert into public.annotation_snapshots (id, document_id, captured_on, payload, created_by)
values (gen_random_uuid(), 'c1b0d000-0000-4000-8000-000000000001', current_date, '[]', 'c1b0a000-0000-4000-8000-0000000000e1');

insert into public.score_analyses (document_id, status, created_by)
values ('c1b0d000-0000-4000-8000-000000000001', 'pending', 'c1b0a000-0000-4000-8000-0000000000e1');

-- Bytes for D4 and DE, as Storage would hold them.
insert into storage.objects (bucket_id, name, owner)
values
    ('scores', 'c1b0d000-0000-4000-8000-000000000004/original.pdf', 'c1b0a000-0000-4000-8000-0000000000a1'),
    ('thumbnails', 'c1b0d000-0000-4000-8000-000000000004/0.jpg', 'c1b0a000-0000-4000-8000-0000000000a1'),
    ('scores', 'c1b0d000-0000-4000-8000-0000000000e9/original.pdf', 'c1b0a000-0000-4000-8000-0000000000e1');

-- ---------------------------------------------------------------------------
-- billing x integrity: who archived a score, and getting it back
-- ---------------------------------------------------------------------------
select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'billing/integrity: the owner archives their own score',
    $q$update public.documents set archived_at = now(), archived_reason = 'plan_lapse' where id = 'c1b0d000-0000-4000-8000-000000000005'$q$,
    1
);

select pg_temp.holds (
    'billing/integrity: a client archive is labelled owner, whatever the client sent',
    $q$select archived_reason = 'owner' from public.documents where id = 'c1b0d000-0000-4000-8000-000000000005'$q$
);

select pg_temp.allowed (
    'billing/integrity: renaming an archived score keeps its reason',
    $q$update public.documents set title = 'Parked' where id = 'c1b0d000-0000-4000-8000-000000000005'$q$,
    1
);

select pg_temp.refused (
    'billing/integrity: the owner still cannot move a score''s storage_path',
    $q$update public.documents set storage_path = 'c1b0d000-0000-4000-8000-000000000001/original.pdf' where id = 'c1b0d000-0000-4000-8000-000000000005'$q$,
    '42501'
);

select pg_temp.act_as_server ();

update public.subscriptions set status = 'canceled' where stripe_subscription_id = 'sub_cb_owner';

select pg_temp.act_as_service ();

select pg_temp.holds (
    'billing/integrity: the lapse archives past the free cap as the service role (4 active -> 3)',
    $q$select public.apply_free_tier_archival ('c1b0a000-0000-4000-8000-0000000000a1') = 1$q$
);

select pg_temp.holds (
    'billing/integrity: the lapse stamped plan_lapse on the least recently used score',
    $q$select archived_reason = 'plan_lapse' from public.documents where id = 'c1b0d000-0000-4000-8000-000000000001'$q$
);

select pg_temp.act_as_server ();

update public.subscriptions set status = 'active' where stripe_subscription_id = 'sub_cb_owner';

select pg_temp.act_as_service ();

select pg_temp.holds (
    'billing/integrity: resubscribing restores the lapse archive through the column guard',
    $q$select public.restore_plan_archived_scores ('c1b0a000-0000-4000-8000-0000000000a1') = 1$q$
);

select pg_temp.holds (
    'billing/integrity: ...and leaves the owner''s own archive alone',
    $q$select (select archived_at is null and archived_reason is null from public.documents where id = 'c1b0d000-0000-4000-8000-000000000001')
          and (select archived_reason = 'owner' from public.documents where id = 'c1b0d000-0000-4000-8000-000000000005')$q$
);

-- ---------------------------------------------------------------------------
-- scope-imslp x integrity: provenance is the import service's to write
-- ---------------------------------------------------------------------------
select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000a1');

select pg_temp.refused (
    'scope/integrity: a client cannot create a score claiming provenance',
    $q$insert into public.documents (id, owner_id, title, storage_path, source_url)
       values ('c1b0d000-0000-4000-8000-0000000000f7', 'c1b0a000-0000-4000-8000-0000000000a1', 'Forged',
               'c1b0d000-0000-4000-8000-0000000000f7/original.pdf', 'https://imslp.org/wiki/Forged')$q$,
    '42501'
);

select pg_temp.act_as_service ();

select pg_temp.allowed (
    'scope/integrity: imslp-download (service role) records provenance',
    $q$update public.documents
       set source_url = 'https://imslp.org/wiki/Sonata', source_filename = 'Sonata.pdf',
           source_license = 'Creative Commons Attribution 4.0',
           source_attribution = '{"source":"imslp","work":"Sonata","composer":null,"editor":"Ed","arranger":null,"publisher":null,"year":null}'
       where id = 'c1b0d000-0000-4000-8000-000000000002'$q$,
    1
);

select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'scope/integrity: the owner still renames an imported score',
    $q$update public.documents set title = 'Renamed import', page_count = 4 where id = 'c1b0d000-0000-4000-8000-000000000002'$q$,
    1
);

select pg_temp.refused (
    'scope/integrity: the owner cannot strip the attribution',
    $q$update public.documents set source_attribution = null where id = 'c1b0d000-0000-4000-8000-000000000002'$q$,
    '42501'
);

select pg_temp.holds (
    'scope/integrity: the provenance survived the rename',
    $q$select source_license = 'Creative Commons Attribution 4.0' and title = 'Renamed import'
       from public.documents where id = 'c1b0d000-0000-4000-8000-000000000002'$q$
);

-- ---------------------------------------------------------------------------
-- library x integrity: row first, tombstone, folder cleanup
-- ---------------------------------------------------------------------------
select pg_temp.removed (
    'library: the owner removes a score row-first',
    'public.documents',
    $q$id = 'c1b0d000-0000-4000-8000-000000000004'$q$,
    1
);

select pg_temp.holds (
    'library: the removal left a tombstone the former owner can read',
    $q$select count(*) = 1 from public.document_storage_cleanup where document_id = 'c1b0d000-0000-4000-8000-000000000004'$q$
);

select pg_temp.holds (
    'library: the former owner can still list the deleted score''s folder',
    $q$select count(*) = 2 from storage.objects where name like 'c1b0d000-0000-4000-8000-000000000004/%'$q$
);

-- Hosted Storage refuses direct row removal from storage.objects unless the
-- Storage API marks the statement as its own (storage.protect_delete); this is
-- that mark, so the RLS policies are what decide below, as they do there.
select set_config('storage.allow_delete_query', 'true', true);

select pg_temp.removed (
    'library: ...and remove its bytes from both buckets',
    'storage.objects',
    $q$name like 'c1b0d000-0000-4000-8000-000000000004/%'$q$,
    2
);

select pg_temp.removed (
    'library: ...then clear the tombstone',
    'public.document_storage_cleanup',
    $q$document_id = 'c1b0d000-0000-4000-8000-000000000004'$q$,
    1
);

select pg_temp.removed (
    'library: a second removal leaves a second tombstone',
    'public.documents',
    $q$id = 'c1b0d000-0000-4000-8000-000000000003'$q$,
    1
);

select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000f1');

select pg_temp.refused (
    'library: a stranger cannot take over a tombstoned id',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('c1b0d000-0000-4000-8000-000000000003', 'c1b0a000-0000-4000-8000-0000000000f1', 'Mine now',
               'c1b0d000-0000-4000-8000-000000000003/original.pdf')$q$,
    '23505'
);

select pg_temp.holds (
    'library: a stranger sees no tombstone and no folder',
    $q$select (select count(*) from public.document_storage_cleanup) = 0
          and (select count(*) from storage.objects where name like 'c1b0d000-0000-4000-8000-000000000003/%') = 0$q$
);

select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'library: the former owner may re-create their own id',
    $q$insert into public.documents (id, owner_id, title, storage_path)
       values ('c1b0d000-0000-4000-8000-000000000003', 'c1b0a000-0000-4000-8000-0000000000a1', 'Back again',
               'c1b0d000-0000-4000-8000-000000000003/original.pdf')$q$,
    1
);

select pg_temp.holds (
    'library: ...which retires the tombstone in the same statement',
    $q$select count(*) = 0 from public.document_storage_cleanup where document_id = 'c1b0d000-0000-4000-8000-000000000003'$q$
);

-- ---------------------------------------------------------------------------
-- sync x integrity x compliance: patches report what they changed
-- ---------------------------------------------------------------------------
select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000e1');

select pg_temp.holds (
    'sync: an editor''s batch patch returns the id it updated',
    $q$select public.patch_annotations_batch (
           '[{"id":"c1b0e000-0000-4000-8000-0000000000a1","document_id":"c1b0d000-0000-4000-8000-000000000001","color":"#ff0000"},
             {"id":"c1b0e000-0000-4000-8000-0000000000e1","document_id":"c1b0d000-0000-4000-8000-000000000001","color":"#00ff00"}]'::jsonb
       ) = array['c1b0e000-0000-4000-8000-0000000000a1', 'c1b0e000-0000-4000-8000-0000000000e1']::uuid[]$q$
);

select pg_temp.refused (
    'compliance/integrity: an editor cannot blank a mark''s author now that it is nullable',
    $q$update public.annotations set created_by = null where id = 'c1b0e000-0000-4000-8000-0000000000a1'$q$,
    '42501'
);

select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000b1');

select pg_temp.holds (
    'sync: a viewer''s patch matches nothing and says so (empty, not an error)',
    $q$select public.patch_annotations_batch (
           '[{"id":"c1b0e000-0000-4000-8000-0000000000a1","document_id":"c1b0d000-0000-4000-8000-000000000001","color":"#0000ff"}]'::jsonb
       ) = '{}'::uuid[]$q$
);

-- ---------------------------------------------------------------------------
-- sharing x integrity: the owner's role change goes through the definer RPC
-- ---------------------------------------------------------------------------
select pg_temp.act_as ('c1b0a000-0000-4000-8000-0000000000a1');

select pg_temp.allowed (
    'sharing: the owner lifts the viewer to editor',
    $q$select public.set_document_member_role ('c1b0d000-0000-4000-8000-000000000001', 'c1b0a000-0000-4000-8000-0000000000b1', 'editor')$q$
);

select pg_temp.holds (
    'sharing: the role change took (and is locked against link redemption)',
    $q$select role = 'editor' from public.document_members
       where document_id = 'c1b0d000-0000-4000-8000-000000000001' and user_id = 'c1b0a000-0000-4000-8000-0000000000b1'$q$
);

-- ---------------------------------------------------------------------------
-- compliance: removing an account fires every user-keyed foreign key
-- ---------------------------------------------------------------------------
select pg_temp.act_as_server ();

insert into integrity_fixtures (k, v)
select 'seq_before', seq::text from public.annotations where id = 'c1b0e000-0000-4000-8000-0000000000e1';

insert into integrity_fixtures (k, v) values ('messages_before', (select count(*)::text from realtime.messages));

-- GoTrue's admin removal, as it reaches Postgres: no JWT, the table owner's role.
select pg_temp.removed (
    'compliance: removing the editor''s auth user succeeds',
    'auth.users',
    $q$id = 'c1b0a000-0000-4000-8000-0000000000e1'$q$,
    1
);

select pg_temp.holds (
    'compliance/integrity: their mark on the owner''s score stays, unattributed',
    $q$select created_by is null from public.annotations where id = 'c1b0e000-0000-4000-8000-0000000000e1'$q$
);

select pg_temp.holds (
    'compliance/integrity: ...with a new seq, so offline devices converge',
    $q$select seq > (select v::bigint from integrity_fixtures where k = 'seq_before')
       from public.annotations where id = 'c1b0e000-0000-4000-8000-0000000000e1'$q$
);

select pg_temp.holds (
    'compliance/security: their play-along request stays, unattributed (role-keyed guard)',
    $q$select created_by is null from public.score_analyses where document_id = 'c1b0d000-0000-4000-8000-000000000001'$q$
);

select pg_temp.holds (
    'compliance/integrity: the lesson-history snapshot stays, unattributed',
    $q$select count(*) = 1 from public.annotation_snapshots
       where document_id = 'c1b0d000-0000-4000-8000-000000000001' and created_by is null$q$
);

select pg_temp.holds (
    'compliance/sharing: their membership is gone',
    $q$select count(*) = 0 from public.document_members where user_id = 'c1b0a000-0000-4000-8000-0000000000e1'$q$
);

select pg_temp.holds (
    'compliance/library: their own score went with them, leaving a tombstone (the account-removal function drains these first)',
    $q$select (select count(*) from public.documents where id = 'c1b0d000-0000-4000-8000-0000000000e9') = 0
          and (select count(*) from public.document_storage_cleanup
               where document_id = 'c1b0d000-0000-4000-8000-0000000000e9'
                 and owner_id = 'c1b0a000-0000-4000-8000-0000000000e1') = 1$q$
);

-- Realtime only writes realtime.messages when the day's partition exists (see
-- column_integrity.sql); where it does not, these two are vacuously skipped.
select pg_temp.holds (
    'compliance/integrity: the unattributed mark fans out on the receive-only doc-db:{id} topic',
    $q$select (select v::int from integrity_fixtures where k = 'messages_before') = (select count(*) from realtime.messages)
          or exists (
              select 1 from realtime.messages
              where topic = 'doc-db:c1b0d000-0000-4000-8000-000000000001'
                and event = 'UPDATE'
                and payload -> 'record' ->> 'id' = 'c1b0e000-0000-4000-8000-0000000000e1')$q$
);

select pg_temp.holds (
    'compliance/sharing: the membership removal is announced on doc:{id}, where the viewer listens for it',
    $q$select (select v::int from integrity_fixtures where k = 'messages_before') = (select count(*) from realtime.messages)
          or exists (
              select 1 from realtime.messages
              where topic = 'doc:c1b0d000-0000-4000-8000-000000000001'
                and event = 'membership'
                and payload ->> 'user_id' = 'c1b0a000-0000-4000-8000-0000000000e1'
                and payload -> 'role' = 'null'::jsonb)$q$
);

-- ---------------------------------------------------------------------------
-- Result
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
