-- Billing correctness for the paid launch: resubscribing restores what a lapse
-- archived, and the PDF export allowance is claimed server-side before the
-- export is built.
--
-- (This migration also carried a smart-import refund ledger -- a credit spent
-- on an import the CLIENT then rolled back could be given back once. It was
-- dropped when integrating with fix/scope-imslp, before ever being applied:
-- imslp-download now creates the score itself once the PDF is in hand, refunds
-- every failure before it answers, and the client never rolls a delivered
-- score back, so there is no client rollback left to refund. Keeping a
-- client-callable refund would only have let an account import, delete the
-- score and take the credit back. See the note at the end of this file.)
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
--  * A resubscribe restores the subscriber AND the teachers seated in the
--    studios they own: an Academy subscription entitles those seats, and a
--    seated teacher gets no webhook of their own.
--  * A share-link guest's PDF export is drawn from the score owner's allowance
--    rather than exempted, so the free plan's one export a month cannot be
--    multiplied by opening one's own share link anonymously.

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
-- One user's restore. Every paid tier is unlimited on cloud_scores, so in
-- practice this restores everything; the cap arithmetic is for an entitling
-- row that still resolves to a finite plan (an unrecognised price stores tier
-- 'free'), which must restore no further than the owner could have unarchived
-- by hand.
--
-- Most recently updated first, the same order the lapse kept by -- and the
-- touch trigger leaves updated_at alone on archive changes, so that order is
-- still the owner's own. Only 'plan_lapse' archives come back; an owner's own
-- archive stays put. The cap trigger still fires on every restored row and is
-- the real backstop: if this ever computed one slot too many, the whole restore
-- would roll back rather than leave the owner over their cap.
create or replace function public.restore_user_plan_archived_scores (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_limit int;
    v_active int;
    v_slots int;
    v_restored int;
begin
    if p_user is null then
        raise exception 'restore_user_plan_archived_scores requires p_user' using errcode = '22023';
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

revoke all on function public.restore_user_plan_archived_scores (uuid) from public;
revoke all on function public.restore_user_plan_archived_scores (uuid) from anon;
revoke all on function public.restore_user_plan_archived_scores (uuid) from authenticated;
grant execute on function public.restore_user_plan_archived_scores (uuid) to service_role;

-- The webhook's entry point, called whenever a subscription is applied in an
-- entitling status (a new checkout, a trial, unpaid -> active). It restores the
-- subscriber, and then every teacher seated in a studio the subscriber owns:
-- an Academy subscription entitles those teachers too, and they get no webhook
-- of their own. A teacher whose own plan lapsed while their Academy owner was
-- also not paying was archived down to the free cap; when the owner pays again
-- the teacher resolves to Academy, and without this would keep those scores
-- read-only indefinitely -- there is no client surface that un-archives.
--
-- A seated teacher is only restored when they now resolve to an unlimited plan
-- (the Academy that just started paying, or their own): a seat in a studio that
-- is still not paying hands nothing back past the free cap that the teacher did
-- not ask for, the same rule the backfill below follows. The member restore
-- re-reads that teacher's entitlements under their own lock, so the gate here
-- is only a filter, never the cap. Members are visited in id order, so two
-- restores that overlap on a teacher take that teacher's locks in one order.
-- Returns the number of scores restored across everyone it visited.
create or replace function public.restore_plan_archived_scores (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_member uuid;
    v_restored int;
begin
    if p_user is null then
        raise exception 'restore_plan_archived_scores requires p_user' using errcode = '22023';
    end if;

    v_restored := public.restore_user_plan_archived_scores (p_user);

    for v_member in
        select distinct sm.user_id
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        where st.owner_id = p_user
          and sm.user_id <> p_user
        order by sm.user_id
    loop
        if (public.resolve_entitlements (v_member) -> 'limits' ->> 'cloud_scores')::int < 0 then
            v_restored := v_restored + public.restore_user_plan_archived_scores (v_member);
        end if;
    end loop;

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
-- plan and still find everything past the free cap read-only. The restore
-- re-reads the teacher's own entitlements, so a seat in an academy that is not
-- paying restores nothing past the cap. Only the seated teacher: a seat changes
-- nobody else's plan, so the studio sweep in restore_plan_archived_scores has
-- nothing to do here. Seats are written only by studio_invite_member (owner-
-- and Academy-checked) and the service role; clients have no insert grant.
create or replace function public.studio_members_restore_plan_archived () returns trigger language plpgsql security definer
set search_path = public as $$
begin
    perform public.restore_user_plan_archived_scores (new.user_id);
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
-- fix this migration is. Only owners whose plan is unlimited now (their own
-- subscription or an Academy seat): a free owner with lapse archives gets
-- nothing back that they did not ask for. (Production held no archived scores
-- at the time of writing, so this is expected to be a no-op there; it is here
-- for every other database built from these files.)
do $$
declare
    v_owner uuid;
begin
    for v_owner in
        select distinct d.owner_id
        from public.documents d
        where d.archived_reason = 'plan_lapse'
        order by d.owner_id
    loop
        if (public.resolve_entitlements (v_owner) -> 'limits' ->> 'cloud_scores')::int < 0 then
            perform public.restore_user_plan_archived_scores (v_owner);
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
-- A share-link guest (an anonymous session) has no plan of its own, and used to
-- be exempt outright -- which made "1 PDF export a month" unenforced for any
-- free owner who opened their own share link in a private window. A guest's
-- export is now drawn from the allowance of the score's OWNER, whose plan is
-- what the export is a feature of: free if the owner pays for unlimited export,
-- the owner's one free export otherwise. So a guest must name the score
-- (p_document) and hold a membership on it -- the share link's redemption is
-- what grants one -- and the answer says billed_to:'owner' so the client words
-- a refusal for someone who cannot upgrade. A signed-in account's export is
-- always drawn from its own allowance; p_document is ignored for it.
--
-- Only what the pricing promises to limit is claimed: "1 PDF export a month".
-- Sharing a page as a photo is a PNG, never calls this, and is never counted.
create or replace function public.claim_pdf_export (p_document uuid default null) returns jsonb language plpgsql security definer
set search_path = public as $$
declare
    v_user uuid := auth.uid();
    v_owner uuid;
    v_ent jsonb;
    v_tier text;
    v_limit int;
begin
    if v_user is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;

    if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
        if p_document is null then
            raise exception 'a share-link guest must name the score being exported' using errcode = '22023';
        end if;

        -- document_role() is the caller's membership; the owner is read only
        -- once that is established, so a guest cannot probe whose a score is.
        if public.document_role (p_document) is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;
        select d.owner_id into v_owner
        from public.documents d
        where d.id = p_document;
        if v_owner is null then
            raise exception 'not a member of this score' using errcode = '42501';
        end if;

        -- tier_limits('student') is unlimited on pdf_exports, so a student
        -- owner's guests fall in the first branch along with every paid plan's.
        v_limit := (public.resolve_entitlements (v_owner) -> 'limits' ->> 'pdf_exports')::int;
        if v_limit < 0 then
            return jsonb_build_object('ok', true, 'unlimited', true, 'billed_to', 'owner');
        end if;

        -- The owner's tier is deliberately not returned: a guest learns that the
        -- allowance ran out, not what the owner pays for.
        return public.consume_quota (v_owner, 'pdf_exports', v_limit) - 'count'
            || jsonb_build_object('unlimited', false, 'billed_to', 'owner');
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

revoke all on function public.claim_pdf_export (uuid) from public;
revoke all on function public.claim_pdf_export (uuid) from anon;
grant execute on function public.claim_pdf_export (uuid) to authenticated;

-- Kept for bundles already in the field, which call it by this name; one
-- implementation, so the two cannot drift. The answer is a superset of the old
-- one ({ok, count, limit, exempt}). Those bundles name no score, so a guest
-- calling it is refused (22023) rather than exempted.
create or replace function public.consume_pdf_export () returns jsonb language sql security definer
set search_path = public as $$
    select public.claim_pdf_export ();
$$;

revoke all on function public.consume_pdf_export () from public;
revoke all on function public.consume_pdf_export () from anon;
grant execute on function public.consume_pdf_export () to authenticated;

-- ---------------------------------------------------------------------------
-- Smart-import credits: no client refund
-- ---------------------------------------------------------------------------
-- An earlier revision of this file added smart_import_charges,
-- record_smart_import_charge(), refund_smart_import() and the
-- documents_refuse_refunded_import trigger, so a client that rolled an IMSLP
-- import back (deleting the row it had created before calling imslp-download)
-- could ask for the credit back. With 20261007120700 and the matching
-- imslp-download, the row is created by the function after the PDF is fetched,
-- every failure path removes what the function created and refunds the credit
-- before answering, and the client keeps whatever a 200 delivered. Nothing is
-- left for a client to roll back, so none of those objects exist: a credit is
-- spent exactly when an import delivered its score, and given back by the one
-- place that knows it did not.
