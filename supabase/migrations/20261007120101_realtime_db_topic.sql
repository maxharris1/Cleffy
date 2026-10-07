-- Realtime: committed rows move to a topic clients can only read.
--
-- doc:{id} carries presence and live ink, so editors must be able to send on
-- it — and Realtime authorizes a channel's sends once, at join, for every event
-- name. The committed-row fan-out (broadcast_changes 'INSERT' / 'UPDATE', the
-- documents content_rev change, and the score_analysis lifecycle) shared that
-- topic, so any editor — including an anonymous share-link editor — could send
-- a hand-made 'INSERT' that every peer applied as a committed server row: a
-- mark attributed to anyone, persisted in the peer's offline store, and a
-- forged seq that jumped the peer's pull watermark past every real change that
-- followed. The policies themselves were right (members receive, only
-- owners/editors send ink); the topic was shared with the wrong traffic.
--
-- Server-authored events now go to doc-db:{id}. Members may receive on it; no
-- client may send on it — the send policies resolve only 'doc:' topics, so they
-- never match. Rows still reach peers through exactly one broadcast each. The
-- client (src/sync/realtimeChannel.ts) joins both topics and reads committed
-- rows only from doc-db:{id}; tests/realtimeTopicsInSync.test.ts keeps the two
-- sides' topic names together.
--
-- Deploy with the frontend that joins doc-db:{id}: a tab still running the old
-- bundle stops receiving committed rows live (it still converges through its
-- pull on reconnect / coming online) until it reloads.
--
-- tests/sql/column_integrity.sql proves receive and send on both topics; see
-- tests/sql/README.md.

create or replace function public.db_topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc-db:%' then
        return null;
    end if;
    begin
        doc := split_part(topic, ':', 2)::uuid;
    exception when invalid_text_representation then
        return null;
    end;
    return public.document_role(doc);
end;
$$;

revoke all on function public.db_topic_document_role (text) from public;
revoke all on function public.db_topic_document_role (text) from anon;
grant execute on function public.db_topic_document_role (text) to authenticated;

-- ALTER rather than drop + create: members never lose their receive grant
-- mid-migration, and the policy keeps its name, command and role.
alter policy doc_topic_receive on realtime.messages
using (
    public.topic_document_role (realtime.topic ()) is not null
    or public.db_topic_document_role (realtime.topic ()) is not null
);

create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        tg_op,                              -- event name ('INSERT' | 'UPDATE')
        tg_op,                              -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create or replace function public.broadcast_document_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc-db:' || new.id::text, -- topic (receive-only for clients)
        tg_op, tg_op, tg_table_name, tg_table_schema, new, old
    );
    return null;
end;
$$;

create or replace function public.broadcast_score_analysis_changes () returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if tg_op = 'UPDATE'
       and old.status is not distinct from new.status
       and old.progress is not distinct from new.progress then
        return null;
    end if;

    perform realtime.send(
        jsonb_build_object(
            'table', 'score_analyses',
            'document_id', new.document_id,
            'status', new.status,
            'error', new.error,
            'progress', new.progress,
            'updated_at', new.updated_at
        ),
        'score_analysis', -- event
        'doc-db:' || new.document_id::text, -- topic (receive-only for clients)
        true -- private
    );
    return null;
end;
$$;

revoke all on function public.broadcast_annotation_changes () from public, anon, authenticated;
revoke all on function public.broadcast_document_changes () from public, anon, authenticated;
revoke all on function public.broadcast_score_analysis_changes () from public, anon, authenticated;
