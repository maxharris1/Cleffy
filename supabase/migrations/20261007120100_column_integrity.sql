-- Column integrity: identity, ownership and authorship columns are immutable
-- (or caller-pinned) for client roles. (The realtime half of the same audit —
-- committed rows on a receive-only topic — is 20261007120101_realtime_db_topic.)
--
-- Why this exists: RLS decides which ROWS a caller may write, never which
-- COLUMNS. Every table below carries a table-wide UPDATE grant (the explicit
-- grants in 20260827140000_core_table_grants, and on hosted projects the
-- permissive default ACL besides), so a policy like annotations_update — "any
-- editor of the document" — let an editor rewrite created_by (forging
-- authorship), created_at, id, or document_id (moving a mark into another
-- score they edit). The same class of hole existed on documents (id,
-- owner_id, storage_path, created_at), share_links (token, created_by,
-- document_id), document_imports (created_by, backup_path) and the rest
-- listed below; annotation_snapshots never pinned created_by at all.
--
-- Why triggers rather than column grants: column-level UPDATE grants only take
-- effect once the table-wide grant is revoked, and the hosted default ACL plus
-- the idempotent core_table_grants migration make that a revoke any later
-- `grant update on table ...` silently undoes. A BEFORE trigger holds no matter
-- what is granted, covers INSERT pinning (which grants cannot express), and
-- applies equally to PostgREST writes and to the SECURITY INVOKER batch RPCs
-- (insert_annotations_batch / patch_annotations_batch), which run as the caller.
--
-- Who is a "client": current_user in ('authenticated', 'anon') — the roles
-- PostgREST switches to for a user JWT. Everything else is trusted server code
-- and is left alone: service_role (Edge Functions, OMR service), postgres
-- (migrations, cron), SECURITY DEFINER functions (they run as their owner, and
-- are already responsible for checking their caller), and FK actions such as
-- ON DELETE SET NULL from an account deletion (Postgres runs those as the
-- referencing table's owner). The guard functions are deliberately SECURITY
-- INVOKER so current_user is the writer, not the function owner.
--
-- Refusals raise 42501 (PostgREST → 403). The client never sends any of these
-- columns on an update (AnnotationUpdate is color/payload/deleted_at only), so a
-- refusal is only ever seen by a forged request; the sync engine treats a 403 as
-- permanent and adopts server truth.
--
-- tests/sql/column_integrity.sql proves each refusal and each legitimate client
-- path in a rolled-back transaction; see tests/sql/README.md.

-- ---------------------------------------------------------------------------
-- annotations
-- ---------------------------------------------------------------------------
-- Editors may change what a mark looks like and whether it is erased (color,
-- payload, deleted_at — the product requirement: editors edit anyone's marks).
-- Everything that says what the mark IS and WHO made it is fixed at insert.
-- page and kind are included: the client never patches them (a handwriting
-- conversion is delete + create precisely because kind cannot be patched), and
-- a kind change would leave a payload peers cannot parse. seq / updated_at are
-- server-stamped by annotations_stamp on every write and need no check here.
--
-- On INSERT, created_by is already pinned by annotations_insert. created_at is
-- client-supplied on purpose (an offline mark keeps the time it was drawn), but
-- kept between the score's own created_at and the server clock: nobody drew on
-- a score before it existed or in the future. Out-of-range values are clamped
-- rather than refused, because a device whose clock is wrong is not an attacker
-- and a refused create would be discarded by the outbox. (created_at only
-- orders marks for hit-testing, so the clamp is about sanity, not access.)
create or replace function public.annotations_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
    v_floor timestamptz;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.created_at > now() then
            new.created_at := now();
        else
            -- Read as the caller: annotations_insert only admits members, who
            -- can see the score. Not visible means the insert is refused anyway.
            select d.created_at into v_floor from public.documents d where d.id = new.document_id;
            if new.created_at < v_floor then
                new.created_at := v_floor;
            end if;
        end if;
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    elsif new.page is distinct from old.page then
        v_col := 'page';
    elsif new.kind is distinct from old.kind then
        v_col := 'kind';
    end if;

    if v_col is not null then
        raise exception 'annotations.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists annotations_guard_columns on public.annotations;

create trigger annotations_guard_columns before insert or update on public.annotations
for each row execute function public.annotations_guard_columns ();

-- ---------------------------------------------------------------------------
-- annotation_snapshots
-- ---------------------------------------------------------------------------
-- Authorship is stamped, not trusted: the client has always sent created_by
-- null (ensureDayStartingSnapshot is never given a user), so a policy-only
-- `created_by = auth.uid()` would have refused every lesson-history push. The
-- trigger overwrites it with the caller, and the policy then checks it as a
-- second line. created_at is the server clock.
--
-- captured_on is the client's LOCAL calendar day, so it cannot be pinned to the
-- server date — but no timezone is more than one day ahead of UTC (UTC+14), so
-- anything later is a forgery. Refusing it matters: one row per (document, day)
-- and the client upserts ON CONFLICT DO NOTHING, so a squatted future day would
-- silently replace that day's real starting point.
--
-- Past days are deliberately not limited: a snapshot captured offline is pushed
-- whenever the device is back, possibly days later. So an editor can still fill
-- an EMPTY past day (or today, before anyone edits) with a made-up starting
-- point. That is no more than an editor can already do to the marks themselves,
-- the row is stamped with their id, and a day that already has its real
-- starting point cannot be replaced (no update path, one row per day).
--
-- Snapshots are immutable starting points (no update policy exists); the guard
-- also refuses client updates outright so a future policy cannot reopen it.
create or replace function public.annotation_snapshots_guard_columns () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        raise exception 'annotation_snapshots rows cannot be changed' using errcode = '42501';
    end if;

    new.created_by := auth.uid();
    new.created_at := now();
    if new.captured_on > (now() at time zone 'utc')::date + 1 then
        raise exception 'annotation_snapshots.captured_on is in the future' using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists annotation_snapshots_guard_columns on public.annotation_snapshots;

create trigger annotation_snapshots_guard_columns before insert or update on public.annotation_snapshots
for each row execute function public.annotation_snapshots_guard_columns ();

-- Archived scores are read-only (20260826193902_billing): the same rule now
-- covers their lesson history, which annotations_insert already enforces for
-- the marks themselves. ALTER (not drop + create) so the policy is never
-- briefly absent and its name, command and role stay exactly as they were.
alter policy annotation_snapshots_insert on public.annotation_snapshots
with check (
    public.document_role (document_id) in ('owner', 'editor')
    and created_by = (select auth.uid())
    and not public.document_is_archived (document_id)
);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
-- storage_path is derived from id ('{id}/original.pdf'); the Edge Functions
-- (score-analyze, imslp-download) already refuse a row where it is not, and the
-- client only ever writes that form. A CHECK makes it an invariant for every
-- role, including service code. Production and the dev branch hold no row that
-- violates it (verified before this migration was written).
alter table public.documents drop constraint if exists documents_storage_path_derived;

alter table public.documents
add constraint documents_storage_path_derived check (storage_path = id::text || '/original.pdf');

-- documents_update already limits UPDATE to the owner and WITH CHECK pins
-- owner_id = auth.uid(), so today nobody can hand a score to someone else — but
-- only because the owner is the sole 'owner' member. Making identity immutable
-- here keeps that true if co-ownership or any new owner-role path ever appears.
-- title, page_count, content_rev, thumb_rev and archived_at stay writable: they
-- are the owner's legitimate edits (archived_at is also held by the score-cap
-- trigger and by billing's archival functions).
create or replace function public.documents_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.owner_id is distinct from old.owner_id then
        v_col := 'owner_id';
    elsif new.storage_path is distinct from old.storage_path then
        v_col := 'storage_path';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'documents.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists documents_guard_columns on public.documents;

create trigger documents_guard_columns before insert or update on public.documents
for each row execute function public.documents_guard_columns ();

-- ---------------------------------------------------------------------------
-- share_links
-- ---------------------------------------------------------------------------
-- The token is the credential, so the server always mints it: the column
-- default was only used when the client omitted it, and a client-chosen token
-- is a guessable one. created_by is pinned by share_links_insert; on UPDATE the
-- link's identity (token, document, author, created_at) is fixed. role,
-- expires_at and revoked_at stay with the owner — they are what managing a link
-- means.
create or replace function public.share_links_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.token := rtrim(
            replace(replace(encode(extensions.gen_random_bytes(16), 'base64'), '+', '-'), '/', '_'),
            '='
        );
        new.created_at := now();
        return new;
    end if;

    if new.token is distinct from old.token then
        v_col := 'token';
    elsif new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'share_links.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists share_links_guard_columns on public.share_links;

create trigger share_links_guard_columns before insert or update on public.share_links
for each row execute function public.share_links_guard_columns ();

-- ---------------------------------------------------------------------------
-- document_imports
-- ---------------------------------------------------------------------------
-- backup_path can only name this document's own backup object (the one
-- replaceDocumentPdf writes); no row anywhere holds anything else.
alter table public.document_imports drop constraint if exists document_imports_backup_path_derived;

alter table public.document_imports
add constraint document_imports_backup_path_derived check (
    backup_path is null
    or backup_path = document_id::text || '/pre-import-original.pdf'
);

-- created_by was never written by the client (always null); it is now the
-- caller on insert and fixed afterwards. updated_at had no touch trigger at
-- all, so it is stamped here for every role.
create or replace function public.document_imports_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if tg_op = 'UPDATE' then
        new.updated_at := now();
    end if;

    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_by := auth.uid();
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_by is distinct from old.created_by then
        v_col := 'created_by';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'document_imports.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists document_imports_guard_columns on public.document_imports;

create trigger document_imports_guard_columns before insert or update on public.document_imports
for each row execute function public.document_imports_guard_columns ();

-- ---------------------------------------------------------------------------
-- library_tags
-- ---------------------------------------------------------------------------
-- library_tags_update already pins user_id to the caller on both sides; only
-- the name is meant to change (renameTag). created_at is the server clock, as
-- on every table here.
create or replace function public.library_tags_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        return new;
    end if;

    if new.id is distinct from old.id then
        v_col := 'id';
    elsif new.user_id is distinct from old.user_id then
        v_col := 'user_id';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'library_tags.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists library_tags_guard_columns on public.library_tags;

create trigger library_tags_guard_columns before insert or update on public.library_tags
for each row execute function public.library_tags_guard_columns ();

-- ---------------------------------------------------------------------------
-- practice_notes
-- ---------------------------------------------------------------------------
-- Updates are already confined by a column-level grant (body, shared,
-- noted_on — 20260826194426_roster), and practice_notes_insert vets author,
-- score and student. What was left is the insert-time clock: created_at orders
-- notes within a lesson day, so it is the server's, like everywhere else.
create or replace function public.practice_notes_guard_columns () returns trigger language plpgsql
set search_path = public as $$
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    new.created_at := now();
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists practice_notes_guard_columns on public.practice_notes;

create trigger practice_notes_guard_columns before insert on public.practice_notes
for each row execute function public.practice_notes_guard_columns ();

-- ---------------------------------------------------------------------------
-- score_analyses
-- ---------------------------------------------------------------------------
-- guard_score_analyses_client_write (20260803120000) decided "client or not"
-- from the JWT: anything without a service_role claim was a client. A write with
-- no JWT at all is server code — and the one that matters is account deletion:
-- removing a user makes Postgres null score_analyses.created_by (ON DELETE SET
-- NULL), the guard put the old value back, and the foreign key then refused the
-- whole deletion (or, on a 'ready' row, the status check did). Same body, but
-- keyed on the database role like every guard above, which still treats
-- PostgREST user requests (and score-analyze's user client) as clients and the
-- OMR service's service_role as trusted.
create or replace function public.guard_score_analyses_client_write () returns trigger language plpgsql
set search_path = public as $$
begin
    -- Server code (service role OMR write-back, FK actions, migrations) may
    -- write any lifecycle fields.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.status not in ('pending', 'failed') then
            raise exception 'score_analyses: clients may only insert pending or failed';
        end if;
        if new.score is not null then
            raise exception 'score_analyses: clients may not write score';
        end if;
        if new.status = 'pending' then
            new.score := null;
            new.progress := null;
            new.engine_version := null;
            new.bpm_default := null;
        end if;
        return new;
    end if;

    -- UPDATE: request/retry only.
    if new.status not in ('pending', 'failed') then
        raise exception 'score_analyses: clients may only set pending or failed';
    end if;
    if new.score is not null then
        raise exception 'score_analyses: clients may not write score';
    end if;
    -- Preserve original requester attribution across retries.
    new.created_by := old.created_by;
    if new.status = 'pending' then
        new.score := null;
        new.progress := null;
        new.error := null;
        new.engine_version := null;
        new.bpm_default := null;
    end if;
    return new;
end;
$$;

-- The guard above keeps the lifecycle fields and created_by; this adds the
-- row's identity, so an editor cannot move one score's analysis request onto
-- another score. On insert both timestamps are the server clock: updated_at is
-- what score-analyze's staleness check reads, so a client-dated request could
-- otherwise look stale (and be re-run) or fresh (and never be retried).
create or replace function public.score_analyses_guard_columns () returns trigger language plpgsql
set search_path = public as $$
declare
    v_col text;
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    if tg_op = 'INSERT' then
        new.created_at := now();
        new.updated_at := now();
        return new;
    end if;

    if new.document_id is distinct from old.document_id then
        v_col := 'document_id';
    elsif new.created_at is distinct from old.created_at then
        v_col := 'created_at';
    end if;

    if v_col is not null then
        raise exception 'score_analyses.% cannot be changed', v_col using errcode = '42501';
    end if;
    return new;
end;
$$;

drop trigger if exists score_analyses_guard_columns on public.score_analyses;

create trigger score_analyses_guard_columns before insert or update on public.score_analyses
for each row execute function public.score_analyses_guard_columns ();

-- Trigger functions are never called directly.
revoke all on function public.annotations_guard_columns () from public, anon, authenticated;
revoke all on function public.annotation_snapshots_guard_columns () from public, anon, authenticated;
revoke all on function public.documents_guard_columns () from public, anon, authenticated;
revoke all on function public.share_links_guard_columns () from public, anon, authenticated;
revoke all on function public.document_imports_guard_columns () from public, anon, authenticated;
revoke all on function public.library_tags_guard_columns () from public, anon, authenticated;
revoke all on function public.practice_notes_guard_columns () from public, anon, authenticated;
revoke all on function public.score_analyses_guard_columns () from public, anon, authenticated;
revoke all on function public.guard_score_analyses_client_write () from public, anon, authenticated;
