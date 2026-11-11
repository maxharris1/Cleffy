-- patch_annotations_batch reports which rows it actually changed.
--
-- The function used to return void. An UPDATE that RLS filters out (the
-- caller's role dropped to viewer, the row never reached the server, the row
-- belongs to another document) matches nothing and raises nothing, so the
-- client acked those patches as saved: the outbox op was deleted while the
-- server still held the old row, and the edit quietly vanished on the next
-- open. Returning the ids that were updated lets the sync engine tell "saved"
-- from "matched nothing" and repair the latter from server truth, telling the
-- user, instead of assuming success.
--
-- Same arguments, same security-invoker semantics (RLS still decides what each
-- UPDATE may touch); only the return type changes, which CREATE OR REPLACE
-- cannot do, hence the drop. A client built before this migration ignores the
-- result, and the new client treats a null result (the old void function) as
-- "unknown" and keeps the previous ack-on-no-error behaviour, so the deploy
-- order of client and database does not matter.

drop function if exists public.patch_annotations_batch (jsonb);

create function public.patch_annotations_batch (p_patches jsonb) returns uuid[] language plpgsql security invoker
set search_path = public as $$
declare
    elem jsonb;
    v_id uuid;
    v_updated uuid[] := '{}';
begin
    if jsonb_typeof(p_patches) is distinct from 'array' then
        raise exception 'p_patches must be a JSON array';
    end if;

    for elem in select value from jsonb_array_elements(p_patches)
    loop
        update public.annotations
        set
            color = coalesce(elem ->> 'color', color),
            payload = case when elem ? 'payload' then elem -> 'payload' else payload end,
            deleted_at = case
                when elem ? 'deleted_at' then (elem ->> 'deleted_at')::timestamptz
                else deleted_at
            end
        where id = (elem ->> 'id')::uuid
          and document_id = (elem ->> 'document_id')::uuid
        returning id into v_id;

        -- id is the primary key, so at most one row; FOUND is false when RLS
        -- (or a missing row) left nothing to update.
        if found then
            v_updated := v_updated || v_id;
        end if;
    end loop;

    return v_updated;
end;
$$;

revoke all on function public.patch_annotations_batch (jsonb) from public;
revoke all on function public.patch_annotations_batch (jsonb) from anon;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;
