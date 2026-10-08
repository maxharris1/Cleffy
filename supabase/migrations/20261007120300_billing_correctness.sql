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
--  * Entitlement resolution moves behind get_entitlements() into the
--    service-only resolve_entitlements(), so server bookkeeping can ask about a
--    user other than the JWT's (a seat invite restores the seated teacher's
--    scores while the request is the Academy owner's).
--  * A refunded smart import's document id is spent for good, and a refund
--    needs the score's bytes gone as well as its row, so a refund can never be
--    taken while keeping the score.

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
-- Entitlements, resolved for a user the caller has already vouched for
-- ---------------------------------------------------------------------------
-- get_entitlements() refuses to answer about anyone but the signed-in caller,
-- which is right for the RPC and wrong for the server's own bookkeeping: when an
-- Academy owner seats a teacher, the restore below has to ask about the TEACHER
-- while the request's JWT still names the owner. So the resolution moves here,
-- unchanged, and get_entitlements() becomes the caller check in front of it.
-- Service-only: callers are definer code that has already decided p_user is
-- the user it may act for. The body is the 20260828180000_billing_stripe_mode.sql
-- definition verbatim, entitling_billing_modes() filter included, so the
-- production narrowing in DEPLOY.md §0 still governs both entry points.
create or replace function public.resolve_entitlements (p_user uuid) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_user uuid := p_user;
    v_tier text := 'free';
    v_status text;
    v_source text := 'none';
    v_period_end timestamptz;
    v_sub record;
begin
    if v_user is null then
        raise exception 'resolve_entitlements requires p_user' using errcode = '22023';
    end if;

    -- A provisioned student short-circuits everything below. The flag is set by
    -- the provisioning function through the admin API, so it is not something the
    -- account itself can write, and a student has no subscription, no seat and no
    -- upgrade path to resolve.
    perform 1
    from auth.users u
    where u.id = v_user
      and u.raw_app_meta_data ->> 'user_type' = 'student';

    if found then
        return jsonb_build_object(
            'user_id', v_user,
            'tier', 'student',
            'status', null::text,
            'source', 'managed',
            'current_period_end', null::timestamptz,
            'limits', public.tier_limits ('student')
        );
    end if;

    -- Own subscription first. Highest tier wins if somehow more than one is live.
    select s.tier, s.status, s.current_period_end
    into v_sub
    from public.subscriptions s
    where s.user_id = v_user
      and s.mode = any (public.entitling_billing_modes ())
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    order by case s.tier when 'academy' then 3 when 'teacher' then 2 when 'personal' then 1 else 0 end desc,
             s.current_period_end desc nulls last
    limit 1;

    if found then
        v_tier := v_sub.tier;
        v_status := v_sub.status;
        v_period_end := v_sub.current_period_end;
        v_source := 'subscription';
    else
        -- Otherwise: a seat in an academy whose owner is paying.
        select s.status, s.current_period_end
        into v_sub
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join public.subscriptions s on s.user_id = st.owner_id
        where sm.user_id = v_user
          and s.tier = 'academy'
          and s.mode = any (public.entitling_billing_modes ())
          and s.status in ('active', 'trialing')
          and (s.current_period_end is null or s.current_period_end > now())
        order by s.current_period_end desc nulls last
        limit 1;

        if found then
            v_tier := 'academy';
            v_status := v_sub.status;
            v_period_end := v_sub.current_period_end;
            v_source := 'studio_member';
        end if;
    end if;

    return jsonb_build_object(
        'user_id', v_user,
        'tier', v_tier,
        'status', v_status,
        'source', v_source,
        'current_period_end', v_period_end,
        'limits', public.tier_limits (v_tier)
    );
end;
$$;

revoke all on function public.resolve_entitlements (uuid) from public;
revoke all on function public.resolve_entitlements (uuid) from anon;
revoke all on function public.resolve_entitlements (uuid) from authenticated;
grant execute on function public.resolve_entitlements (uuid) to service_role;

-- The RPC keeps its signature, its grants and its caller check; only the
-- resolution behind it moved.
create or replace function public.get_entitlements (p_user uuid default null) returns jsonb language plpgsql stable security definer
set search_path = public as $$
declare
    v_caller uuid := auth.uid();
begin
    if v_caller is null then
        if p_user is null then
            raise exception 'get_entitlements requires p_user when unauthenticated' using errcode = '22023';
        end if;
        return public.resolve_entitlements (p_user);
    end if;

    if p_user is not null and p_user <> v_caller then
        raise exception 'cannot read another user''s entitlements' using errcode = '42501';
    end if;
    return public.resolve_entitlements (v_caller);
end;
$$;

-- The score cap asks about the row's OWNER, who is not always the JWT's user:
-- a restore run inside an Academy owner's seat invite un-archives the seated
-- teacher's scores, and get_entitlements() would refuse that question outright
-- and abort the invite. Redefined verbatim from 20260826193902_billing.sql
-- except for that one call; its trigger and grants are unchanged.
create or replace function public.documents_enforce_score_cap () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_tier text;
    v_limit int;
    v_count int;
begin
    -- Only a row that is (or becomes) active claims a slot.
    if new.archived_at is not null then
        return null;
    end if;
    if tg_op = 'UPDATE' and old.archived_at is null then
        return null; -- already active; nothing new is being claimed
    end if;

    v_ent := public.resolve_entitlements (new.owner_id);
    v_tier := v_ent ->> 'tier';
    v_limit := (v_ent -> 'limits' ->> 'cloud_scores')::int;

    if v_limit < 0 then
        return null;
    end if;

    -- Taken only on a capped tier, and only once the cheap exits are past: an
    -- unlimited plan never serializes against itself. Released at commit.
    perform pg_advisory_xact_lock (hashtext('cleffy.documents_score_cap'), hashtext(new.owner_id::text));

    -- The new row is already in, so it counts itself: the test is `>`, not `>=`.
    select count(*)::int into v_count
    from public.documents d
    where d.owner_id = new.owner_id
      and d.archived_at is null;

    if v_count > v_limit then
        raise exception 'limit_reached'
            using errcode = 'P0001',
                  detail = json_build_object(
                      'code', 'limit_reached',
                      'metric', 'cloud_scores',
                      'limit', v_limit,
                      'tier', v_tier
                  )::text,
                  hint = 'Upgrade for unlimited cloud scores.';
    end if;

    return null;
end;
$$;

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

    v_limit := (public.resolve_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
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
-- status (a new checkout, a trial, unpaid -> active), and by the seat trigger
-- below when an Academy owner seats a teacher (an Academy seat is unlimited
-- even when the teacher's own plan lapsed). Every paid tier is
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

    v_limit := (public.resolve_entitlements (p_user) -> 'limits' ->> 'cloud_scores')::int;
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

-- An Academy seat entitles without any webhook for the seated teacher: the
-- subscription that pays for it is the owner's. Without this, a teacher whose
-- own plan lapsed and who is then given a seat would resolve to an unlimited
-- plan and still find everything past the free cap read-only -- and there is
-- no client surface that un-archives. The restore re-reads the teacher's own
-- entitlements, so a seat in an academy that is not paying restores nothing
-- past the cap. Seats are written only by studio_invite_member (owner- and
-- Academy-checked) and the service role; clients have no insert grant.
create or replace function public.studio_members_restore_plan_archived () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.restore_plan_archived_scores (new.user_id);
    return null;
end;
$$;

revoke all on function public.studio_members_restore_plan_archived () from public;
revoke all on function public.studio_members_restore_plan_archived () from anon;
revoke all on function public.studio_members_restore_plan_archived () from authenticated;

create trigger studio_members_restore_plan_archived after insert on public.studio_members
for each row execute function public.studio_members_restore_plan_archived ();

-- Owners who are ALREADY entitled again when this ships would otherwise wait
-- for their next entitling webhook -- up to a year on an annual plan -- for the
-- fix this migration is. Only owners whose plan is unlimited now: a free owner
-- with lapse archives gets nothing back that they did not ask for. (Production
-- held no archived scores at the time of writing, so this is expected to be a
-- no-op there; it is here for every other database built from these files.)
do $$
declare
    v_owner uuid;
begin
    for v_owner in
        select distinct d.owner_id
        from public.documents d
        where d.archived_reason = 'plan_lapse'
    loop
        if (public.resolve_entitlements (v_owner) -> 'limits' ->> 'cloud_scores')::int < 0 then
            perform public.restore_plan_archived_scores (v_owner);
        end if;
    end loop;
end;
$$;

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

-- Not partial: the refund looks up open charges by document, and the insert
-- guard below looks up REFUNDED ones on every new score.
create index smart_import_charges_document on public.smart_import_charges (document_id);

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
--  * only once the import is really gone -- the documents row AND every object
--    under its folder in the scores bucket. Deleting only the row would leave
--    the PDF in Storage, and since document ids are client-chosen the owner
--    could re-create the row under the same id and be its owner again;
--  * and the id is spent for good: documents_refuse_refunded_import below
--    refuses any score under an id whose import was refunded, so the row (and
--    with it access to that folder) can never come back;
--  * only in the month it was charged, and only within 15 minutes of the
--    charge: a rollback follows its import immediately, so anything later is a
--    score that was used and then deleted, which is not a failed import;
--  * at most twice in a calendar month (the free plan's whole smart-import
--    allowance; no paid plan meters imports). A modified client could still
--    keep bytes it downloaded and re-upload them as an ordinary score -- an
--    upload any account may make, counted against the cloud-score cap -- and
--    this bounds how far that can stretch the allowance. A genuine third
--    rollback in one month is rare enough to cost the credit.
-- Returns the number of credits given back (0 when there was nothing to give).
create or replace function public.refund_smart_import (p_document uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_month date := date_trunc('month', now())::date;
    v_monthly_refunds constant int := 2;
    v_refunded int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    if p_document is null then
        raise exception 'refund_smart_import requires p_document' using errcode = '22023';
    end if;

    -- This user's charges and refunds, then this id: the insert guard takes the
    -- id's lock too, so a score re-created under the id either commits before
    -- the existence check below (and is seen) or waits for this refund to commit
    -- (and is refused). Only this function takes both, in this order.
    perform pg_advisory_xact_lock (hashtext('cleffy.smart_import_charges'), hashtext(v_user::text));
    perform pg_advisory_xact_lock (hashtext('cleffy.smart_import_refund'), hashtext(p_document::text));

    if exists (select 1 from public.documents d where d.id = p_document) then
        return 0;
    end if;

    -- The bytes must be gone too. A prefix match on the folder, not
    -- storage.foldername(): it uses the bucket/name index, and a uuid's text
    -- holds no LIKE wildcards.
    if exists (
        select 1
        from storage.objects o
        where o.bucket_id = 'scores'
          and o.name like p_document::text || '/%'
    ) then
        return 0;
    end if;

    if (
        select count(*)
        from public.smart_import_charges c
        where c.user_id = v_user and c.month = v_month and c.refunded_at is not null
    ) >= v_monthly_refunds then
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

-- A refunded import's id is spent. Without this the refund is a loan: delete
-- the row, take the credit back, re-create the row under the same id (ids are
-- client-chosen) and the owner-membership trigger makes the caller owner of
-- that folder again. The app always mints a fresh uuid, so no legitimate flow
-- reuses one. UPDATE OF id is covered too, although the document_members
-- foreign key already keeps a score's id from changing under it.
--
-- SECURITY DEFINER to read the ledger, which no client role can. Takes the
-- refund's per-id lock so the check cannot interleave with a refund in flight
-- (see refund_smart_import); an uncontended advisory lock is cheap next to the
-- insert it guards.
create or replace function public.documents_refuse_refunded_import () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    if tg_op = 'UPDATE' and new.id is not distinct from old.id then
        return new;
    end if;

    perform pg_advisory_xact_lock (hashtext('cleffy.smart_import_refund'), hashtext(new.id::text));

    if exists (
        select 1
        from public.smart_import_charges c
        where c.document_id = new.id
          and c.refunded_at is not null
    ) then
        raise exception 'document id is not available' using errcode = '23505';
    end if;
    return new;
end;
$$;

revoke all on function public.documents_refuse_refunded_import () from public;
revoke all on function public.documents_refuse_refunded_import () from anon;
revoke all on function public.documents_refuse_refunded_import () from authenticated;

create trigger documents_refuse_refunded_import before insert or update of id on public.documents
for each row execute function public.documents_refuse_refunded_import ();
