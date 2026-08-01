-- Realtime: one private channel per document, topic 'doc:{documentId}'.
--  * Committed annotations fan out via broadcast-from-database (exactly-one
--    fan-out that also fires for offline flushes; no postgres_changes
--    per-subscriber overhead). Gap-fill on (re)connect is the watermark pull.
--  * Live in-progress ink + presence are client events on the same channel.
--  * realtime.messages policies mirror document membership; send is split by
--    extension so viewers appear in presence but can never broadcast ink.

-- Safe topic → role resolution ('doc:{uuid}' only; never throws on foreign topics).
create or replace function public.topic_document_role (topic text) returns text language plpgsql stable security definer
set search_path = public as $$
declare
    doc uuid;
begin
    if topic not like 'doc:%' then
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

grant execute on function public.topic_document_role (text) to authenticated;

-- Broadcast every committed annotation write to the document's channel.
-- SECURITY DEFINER: the writing user has no direct insert grant on
-- realtime.messages — the documented broadcast_changes trigger pattern.
create or replace function public.broadcast_annotation_changes () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform realtime.broadcast_changes(
        'doc:' || new.document_id::text, -- topic
        tg_op,                           -- event name ('INSERT' | 'UPDATE')
        tg_op,                           -- operation
        tg_table_name,
        tg_table_schema,
        new,
        old
    );
    return null;
end;
$$;

create trigger annotations_broadcast after insert or update on public.annotations
for each row execute function public.broadcast_annotation_changes ();

-- Receive: any member of the document, both broadcast and presence.
create policy doc_topic_receive on realtime.messages for select to authenticated
using (public.topic_document_role (realtime.topic ()) is not null);

-- Send presence: any member (viewers must appear in the presence bar).
create policy doc_topic_send_presence on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'presence'
    and public.topic_document_role (realtime.topic ()) is not null
);

-- Send broadcast (live ink): editors and owners only.
create policy doc_topic_send_broadcast on realtime.messages for insert to authenticated
with check (
    realtime.messages.extension = 'broadcast'
    and public.topic_document_role (realtime.topic ()) in ('owner', 'editor')
);
