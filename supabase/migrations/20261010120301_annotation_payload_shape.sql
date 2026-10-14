-- The server checks what a mark's payload and colour look like.
--
-- annotations.payload was `jsonb not null` and nothing else, so any editor
-- could store any JSON at all -- a string, a 10 MB blob, a "stroke" with no
-- points -- through PostgREST or the batch RPCs, and every peer's viewer then
-- had to cope with it. A CHECK on the table holds for every write path at once
-- (plain inserts and updates, insert_annotations_batch and
-- patch_annotations_batch, which run as the caller), so neither RPC needs its
-- own copy.
--
-- What is checked mirrors src/types/models.ts (StrokePayload / TextPayload),
-- which has carried these shapes unchanged since the ink engine landed:
--
--  * every payload: a JSON object of at most 1 MiB serialized. The largest
--    stroke ever stored is under 25 KB; a megabyte is minutes of continuous
--    pen input.
--  * stroke / highlight: `pts` a non-empty flat array of numbers in [x, y, p]
--    triplets, `w` a number in (0, 1]; `sp` / `src` 1 when present.
--  * text: `x` / `y` / `size` numbers (size in (0, 1]), `text` a string of at
--    most 10,000 characters; `src` / `sf` / `hw` / `bold` 1, `italic` 0 or 1,
--    `font` 'sans' or 'serif' when present.
--  * coordinates (and pressures) within [-1, 2]. The client clamps ink to the
--    page (0..1) and keeps text on it, so this is a sanity bound rather than
--    the page edge: a slightly out-of-range value from an older or future
--    client is not worth refusing, a 1e300 is.
--  * colour: a #hex colour, which is all the app's palette has ever held.
--
-- Unknown payload keys are allowed on purpose. A refused write is discarded by
-- the sync outbox (rolled back to server truth), so a client release that adds
-- a provenance flag before this function learns it must not lose marks; the
-- size cap is what bounds what an extra key can carry.
--
-- Production rows were checked against these rules before the constraint was
-- written (all pass); VALIDATE re-proves it at apply time and fails the
-- migration rather than leaving an unenforced constraint behind.

-- A JSON number as numeric; NULL for anything else (a string "0.5", an array,
-- a missing key), which the caller's comparison then turns into a refusal.
create or replace function public.annotation_payload_number (p_value jsonb) returns numeric
language sql immutable parallel safe
set search_path = '' as $$
    select case when jsonb_typeof(p_value) = 'number' then (p_value #>> '{}')::numeric end;
$$;

create or replace function public.annotation_payload_valid (p_kind text, p_payload jsonb) returns boolean
language sql immutable parallel safe
set search_path = '' as $$
    -- coalesce: a missing or mistyped key makes its test NULL, and a CHECK
    -- passes on NULL.
    select coalesce(
        jsonb_typeof(p_payload) = 'object'
        and octet_length(p_payload::text) <= 1048576
        and case
            -- A nested CASE, not AND: SQL does not promise to evaluate AND's
            -- arms in order, and jsonb_array_length raises on a non-array.
            when p_kind in ('stroke', 'highlight') then case
                when jsonb_typeof(p_payload -> 'pts') is distinct from 'array' then false
                else
                    jsonb_array_length(p_payload -> 'pts') >= 3
                    and jsonb_array_length(p_payload -> 'pts') % 3 = 0
                    -- Strict jsonpath (lax would unwrap a nested array into
                    -- its numbers): an element that is not a number, or is out
                    -- of range, makes the filter match.
                    and not jsonb_path_exists(
                        p_payload, 'strict $.pts[*] ? (@.type() != "number" || @ < -1 || @ > 2)'
                    )
                    and public.annotation_payload_number (p_payload -> 'w') > 0
                    and public.annotation_payload_number (p_payload -> 'w') <= 1
                    and (not p_payload ? 'sp' or p_payload -> 'sp' = '1'::jsonb)
                    and (not p_payload ? 'src' or p_payload -> 'src' = '1'::jsonb)
            end
            when p_kind = 'text' then
                public.annotation_payload_number (p_payload -> 'x') between -1 and 2
                and public.annotation_payload_number (p_payload -> 'y') between -1 and 2
                and public.annotation_payload_number (p_payload -> 'size') > 0
                and public.annotation_payload_number (p_payload -> 'size') <= 1
                and jsonb_typeof(p_payload -> 'text') = 'string'
                and char_length(p_payload ->> 'text') <= 10000
                and (not p_payload ? 'src' or p_payload -> 'src' = '1'::jsonb)
                and (not p_payload ? 'sf' or p_payload -> 'sf' = '1'::jsonb)
                and (not p_payload ? 'hw' or p_payload -> 'hw' = '1'::jsonb)
                and (not p_payload ? 'bold' or p_payload -> 'bold' = '1'::jsonb)
                and (not p_payload ? 'italic' or p_payload -> 'italic' in ('0'::jsonb, '1'::jsonb))
                and (not p_payload ? 'font' or p_payload -> 'font' in ('"sans"'::jsonb, '"serif"'::jsonb))
            else false
        end,
        false
    );
$$;

-- Pure and harmless, and the client may as well be able to ask it.
revoke all on function public.annotation_payload_valid (text, jsonb) from public;
revoke all on function public.annotation_payload_valid (text, jsonb) from anon;
grant execute on function public.annotation_payload_valid (text, jsonb) to authenticated, service_role;

revoke all on function public.annotation_payload_number (jsonb) from public;
revoke all on function public.annotation_payload_number (jsonb) from anon;
grant execute on function public.annotation_payload_number (jsonb) to authenticated, service_role;

-- NOT VALID then VALIDATE: the add itself only takes a brief lock, and the scan
-- of existing rows runs under one that lets reads and writes continue.
alter table public.annotations
    add constraint annotations_payload_shape check (public.annotation_payload_valid (kind, payload)) not valid;

alter table public.annotations validate constraint annotations_payload_shape;

alter table public.annotations
    add constraint annotations_color_hex check (color ~ '^#[0-9A-Fa-f]{3,8}$') not valid;

alter table public.annotations validate constraint annotations_color_hex;
