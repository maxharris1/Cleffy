-- Billing correctness for the paid launch: resubscribing restores what a lapse
-- archived, the PDF export allowance is claimed server-side before the export
-- is built, and a smart-import credit spent on an import the client then rolled
-- back can be given back -- once, and only for an import that no longer exists.
--
-- Design notes:
--  * Archival now records WHY a score is archived. apply_free_tier_archival is
--    the only flow that archives on a plan event, but documents_update is an
--    owner-wide policy over a table-wide UPDATE grant, so an owner can also set
--    archived_at themselves through the API. A resubscribe must undo the first
--    and never the second: an owner who parked a score did not ask for it back.
--  * The reason is derived, never trusted from a client. A trigger stamps it from
--    who is writing -- a PostgREST client role always gets 'owner' -- so nobody
--    can label their own archive 'plan_lapse' and have billing act on it.
--  * Both the lapse and the restore serialize with documents_enforce_score_cap
--    on the same per-owner advisory lock, taking row locks first, in the order
--    the cap trigger's own callers do (row, then advisory), so the three cannot
--    deadlock against each other or count past one another.

-- ---------------------------------------------------------------------------
-- Why a score is archived
-- ---------------------------------------------------------------------------
alter table public.documents add column archived_reason text;

-- Archive bookkeeping is not a touch (see the billing migration's note on
-- documents_touch_updated_at): a score's place in the library, and the
-- last-touched order the lapse keeps and the restore brings back by, must
-- survive the reason being stamped or cleared -- including the backfill below.
create or replace function public.documents_touch_updated_at () returns trigger language plpgsql
set search_path = public as $$
begin
    if new.archived_at is distinct from old.archived_at
        or new.archived_reason is distinct from old.archived_reason then
        new.updated_at := old.updated_at;
        return new;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

-- Every score archived before this migration was archived by a lapse: no client
-- surface has ever archived a score, and apply_free_tier_archival is the only
-- server path that does.
update public.documents
set archived_reason = 'plan_lapse'
where archived_at is not null
  and archived_reason is null;

alter table public.documents
add constraint documents_archived_reason_check check (
    (archived_at is null and archived_reason is null)
    or (archived_at is not null and archived_reason in ('plan_lapse', 'owner'))
);

-- Deliberately SECURITY INVOKER: current_user must be the role that issued the
-- write. Inside a definer trigger it would always be the function's owner, and
-- the client/trusted split below would collapse into "always trusted".
--
-- Named so it sorts before documents_touch (BEFORE triggers fire in name order),
-- which then sees the reason this trigger settled on, not the one a client sent.
create or replace function public.documents_archived_reason () returns trigger language plpgsql
set search_path = public as $$
declare
    v_client boolean := current_user in ('authenticated', 'anon');
begin
    if new.archived_at is null then
        new.archived_reason := null;
        return new;
    end if;

    -- Staying archived: the reason is whatever archived it. A client may touch
    -- the row (rename it, say) but never relabel the archive.
    if tg_op = 'UPDATE' and old.archived_at is not null then
        if v_client then
            new.archived_reason := old.archived_reason;
        end if;
        new.archived_reason := coalesce(new.archived_reason, old.archived_reason, 'owner');
        return new;
    end if;

    -- Newly archived. A client archiving its own score is the owner's choice;
    -- a trusted writer that names no reason is treated the same, so only a
    -- path that explicitly says 'plan_lapse' is ever undone by a resubscribe.
    if v_client or new.archived_reason is null then
        new.archived_reason := 'owner';
    end if;
    return new;
end;
$$;

create trigger documents_archived_reason before insert or update on public.documents
for each row execute function public.documents_archived_reason ();

revoke all on function public.documents_archived_reason () from public;

revoke all on function public.documents_archived_reason () from anon;

revoke all on function public.documents_archived_reason () from authenticated;

-- The restore runs on every entitling webhook, so finding "nothing to restore"
-- must not scan the owner's whole library.
create index documents_owner_plan_lapse on public.documents (owner_id)
where archived_reason = 'plan_lapse';

-- ---------------------------------------------------------------------------
-- Lapse: archive past the free cap (redefined to stamp the reason and lock)
-- ---------------------------------------------------------------------------
-- Row locks on the active set first, then the cap's advisory lock, then the
-- entitlement and the keep-set are read fresh. Without the advisory lock a score
-- uploaded mid-archival is invisible to the keep-set and survives as a fourth
-- active score; taking it before the row locks would invert the order the cap
-- trigger uses (its row is locked before it asks for the advisory lock).
create or replace function public.apply_free_tier_archival (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_archived int;
begin
    if p_user is null then
        raise exception 'apply_free_tier_archival requires p_user' using errcode = '22023';
    end if;

    perform 1
    from public.documents d
    where d.owner_id = p_user and d.archived_at is null
    for update;

    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(p_user::text));

    v_limit := (public.get_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        return 0;
    end if;

    with keep as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null
        order by d.updated_at desc, d.id
        limit v_limit
    )
    update public.documents d
    set archived_at = now(),
        archived_reason = 'plan_lapse'
    where d.owner_id = p_user
      and d.archived_at is null
      and not exists (select 1 from keep k where k.id = d.id);

    get diagnostics v_archived = row_count;
    return v_archived;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resubscribe: restore what the lapse archived, up to the plan's cap
-- ---------------------------------------------------------------------------
-- Called by the webhook whenever a subscription is applied in an entitling
-- status (a new checkout, a trial, unpaid -> active). Every paid tier is
-- unlimited on cloud_scores, so in practice this restores everything; the cap
-- arithmetic is for an entitling row that still resolves to a finite plan (an
-- unrecognised price stores tier 'free'), which must restore no further than
-- the owner could have unarchived by hand.
--
-- Most recently updated first, the same order the lapse kept by -- and the
-- touch trigger leaves updated_at alone on archive changes, so that order is
-- still the owner's own. Only 'plan_lapse' archives come back; an owner's own
-- archive stays put. The cap trigger still fires on every restored row and is
-- the real backstop: if this ever computed one slot too many, the whole restore
-- would roll back rather than leave the owner over their cap.
create or replace function public.restore_plan_archived_scores (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_active int;
    v_slots int;
    v_restored int;
begin
    if p_user is null then
        raise exception 'restore_plan_archived_scores requires p_user' using errcode = '22023';
    end if;

    -- Rows first, then the advisory lock: the order a concurrent unarchive takes
    -- them (its row, then the cap trigger's lock), so the two cannot deadlock.
    perform 1
    from public.documents d
    where d.owner_id = p_user and d.archived_reason = 'plan_lapse'
    for update;

    if not found then
        return 0;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(p_user::text));

    v_limit := (public.get_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
    if v_limit < 0 then
        v_slots := null; -- LIMIT NULL is LIMIT ALL
    else
        select count(*)::int into v_active
        from public.documents d
        where d.owner_id = p_user and d.archived_at is null;

        v_slots := greatest(0, v_limit - v_active);
        if v_slots = 0 then
            return 0;
        end if;
    end if;

    with restore as (
        select d.id
        from public.documents d
        where d.owner_id = p_user and d.archived_reason = 'plan_lapse'
        order by d.updated_at desc, d.id
        limit v_slots
    )
    update public.documents d
    set archived_at = null
    where d.id in (select r.id from restore r);

    get diagnostics v_restored = row_count;
    return v_restored;
end;
$$;

revoke all on function public.restore_plan_archived_scores (uuid) from public;
revoke all on function public.restore_plan_archived_scores (uuid) from anon;
revoke all on function public.restore_plan_archived_scores (uuid) from authenticated;
grant execute on function public.restore_plan_archived_scores (uuid) to service_role;

-- Same grants as before; restated because create or replace keeps them, but a
-- reader of this file should not have to go looking.
revoke all on function public.apply_free_tier_archival (uuid) from public;
revoke all on function public.apply_free_tier_archival (uuid) from anon;
revoke all on function public.apply_free_tier_archival (uuid) from authenticated;
grant execute on function public.apply_free_tier_archival (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- PDF export: claim before building
-- ---------------------------------------------------------------------------
-- The export is flattened on-device, so the database cannot physically stop a
-- modified client from producing one. What it can do is be the only place the
-- allowance is decided: the shipped client builds nothing until this answers
-- ok:true, and treats anything else -- a refusal, an error, no network -- as
-- "no". The check and the increment are consume_quota's single statement, so
-- two tabs exporting at once cannot both spend the one free export.
--
-- The answer carries the tier and whether the plan is unlimited, so the client
-- can word a refusal for the plan the server actually saw, and can remember
-- that an unlimited plan needs no claim to export offline.
--
-- Only what the pricing promises to limit is claimed: "1 PDF export a month".
-- Sharing a page as a photo is a PNG, never calls this, and is never counted.
create or replace function public.claim_pdf_export () returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_ent jsonb;
    v_tier text;
    v_limit int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    -- A share-link guest is someone else's visitor, with no plan of their own to
    -- draw down and no way to upgrade. Never gated.
    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        return jsonb_build_object('ok', true, 'exempt', 'anonymous', 'unlimited', true);
    end if;

    v_ent := public.get_entitlements ();
    v_tier := v_ent ->> 'tier';

    -- Students print what they were assigned. That is the product working, not
    -- usage to meter.
    if v_tier = 'student' then
        return jsonb_build_object('ok', true, 'exempt', 'student', 'unlimited', true, 'tier', v_tier);
    end if;

    v_limit := (v_ent -> 'limits' ->> 'pdf_exports')::int;
    if v_limit < 0 then
        return jsonb_build_object('ok', true, 'unlimited', true, 'limit', v_limit, 'tier', v_tier);
    end if;

    return public.consume_quota (v_user, 'pdf_exports', v_limit)
        || jsonb_build_object('unlimited', false, 'tier', v_tier);
end;
$$;

revoke all on function public.claim_pdf_export () from public;
revoke all on function public.claim_pdf_export () from anon;
grant execute on function public.claim_pdf_export () to authenticated;

-- Kept for bundles already in the field, which call it by this name; one
-- implementation, so the two cannot drift. The answer is a superset of the old
-- one ({ok, count, limit, exempt}).
create or replace function public.consume_pdf_export () returns jsonb language sql security definer
set search_path = public as $$
    select public.claim_pdf_export ();
$$;

revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

-- ---------------------------------------------------------------------------
-- Smart-import credits: a ledger, so a rolled-back import can be refunded once
-- ---------------------------------------------------------------------------
-- imslp-download meters smart_imports and refunds its own failures, but the
-- import is only finished when the CLIENT has the bytes. If the client fails
-- after the function answered (the response is lost, the download from Storage
-- fails), it rolls the import back by deleting the score -- and the credit was
-- already spent on a score the teacher never got.
--
-- One row per metered import, written by the function only after the PDF landed
-- in Storage, and only when a credit was actually consumed (an unlimited plan
-- spends none, so has nothing to give back). document_id is deliberately not a
-- foreign key: a refund is only allowed once that document is GONE, and the
-- row has to outlive it to say so.
create table public.smart_import_charges (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    document_id uuid not null,
    -- The usage_counters month the credit was taken from. A refund only ever
    -- gives back to the same month, so it cannot carry credit across a rollover.
    month date not null,
    charged_at timestamptz not null default now(),
    refunded_at timestamptz
);

create index smart_import_charges_document on public.smart_import_charges (document_id)
where refunded_at is null;

create index smart_import_charges_user_month on public.smart_import_charges (user_id, month);

alter table public.smart_import_charges enable row level security;

-- Zero policies: written by the Edge Function (service role), consumed only
-- through refund_smart_import below. Nothing for a client to read or forge.
revoke all on table public.smart_import_charges from public;
revoke all on table public.smart_import_charges from anon;
revoke all on table public.smart_import_charges from authenticated;
grant all on table public.smart_import_charges to service_role;

-- Records the charge for an import that landed. Refuses to record more open
-- charges in a month than the counter has increments: every refundable charge
-- must stand for a distinct unit that really was taken from THIS month. That is
-- what closes the one gap between consume_quota and this call -- an import that
-- straddles midnight on the 1st was counted in the old month, finds nothing in
-- the new one to stand for, and is simply not refundable.
create or replace function public.record_smart_import_charge (p_user uuid, p_document uuid) returns boolean language plpgsql security definer
set search_path = public as $$
declare
    v_month date := date_trunc('month', now())::date;
    v_count int;
    v_open int;
begin
    if p_user is null or p_document is null then
        raise exception 'record_smart_import_charge requires p_user and p_document' using errcode = '22023';
    end if;

    -- Serializes this user's charges and refunds against each other, so the
    -- count-then-insert below cannot interleave.
    perform pg_advisory_xact_lock (hashtext('cleffy.smart_import_charges'), hashtext(p_user::text));

    select uc.count into v_count
    from public.usage_counters uc
    where uc.user_id = p_user and uc.metric = 'smart_imports' and uc.month = v_month;

    select count(*)::int into v_open
    from public.smart_import_charges c
    where c.user_id = p_user and c.month = v_month and c.refunded_at is null;

    if coalesce(v_count, 0) <= v_open then
        return false;
    end if;

    insert into public.smart_import_charges (user_id, document_id, month)
    values (p_user, p_document, v_month);
    return true;
end;
$$;

revoke all on function public.record_smart_import_charge (uuid, uuid) from public;
revoke all on function public.record_smart_import_charge (uuid, uuid) from anon;
revoke all on function public.record_smart_import_charge (uuid, uuid) from authenticated;
grant execute on function public.record_smart_import_charge (uuid, uuid) to service_role;

-- The client's half of the rollback, called after it has deleted the score.
-- What keeps it from minting credits:
--  * it only refunds charges the server recorded, each at most once (the
--    refunded_at stamp is set in the same statement that selects it);
--  * only the caller's own charges, so nobody refunds into someone else's month;
--  * only while the document the import created no longer exists -- the
--    teacher gives the score up to get the credit back;
--  * only in the month it was charged, and only within 15 minutes of the
--    charge: a rollback follows its import immediately, so anything later is a
--    score that was used and then deleted, which is not a failed import.
-- Returns the number of credits given back (0 when there was nothing to give).
create or replace function public.refund_smart_import (p_document uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_month date := date_trunc('month', now())::date;
    v_refunded int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    if p_document is null then
        raise exception 'refund_smart_import requires p_document' using errcode = '22023';
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.smart_import_charges'), hashtext(v_user::text));

    if exists (select 1 from public.documents d where d.id = p_document) then
        return 0;
    end if;

    with refunded as (
        update public.smart_import_charges c
        set refunded_at = now()
        where c.document_id = p_document
          and c.user_id = v_user
          and c.refunded_at is null
          and c.month = v_month
          and c.charged_at > now() - interval '15 minutes'
        returning 1
    )
    select count(*)::int into v_refunded from refunded;

    if v_refunded > 0 then
        update public.usage_counters
        set count = greatest(0, count - v_refunded), updated_at = now()
        where user_id = v_user
          and metric = 'smart_imports'
          and month = v_month;
    end if;

    return v_refunded;
end;
$$;

revoke all on function public.refund_smart_import (uuid) from public;
revoke all on function public.refund_smart_import (uuid) from anon;
grant execute on function public.refund_smart_import (uuid) to authenticated;
