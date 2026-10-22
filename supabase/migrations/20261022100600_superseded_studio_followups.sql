-- What superseding a studio leaves behind (Codex round 1 on #69, MAJOR 1 and 2).
--
-- 20261022100300 retires an owner's extra studios: resolve_entitlements() reads
-- no seat from a superseded studio, so a member seated only there now resolves
-- as if never seated. Two things did not follow:
--
--  1. Their scores. The score cap only refuses a NEW active score
--     (documents_enforce_score_cap); a member who had 100 active scores through
--     the retired studio kept all 100. Every member of a superseded studio is
--     now brought in line with their FINAL entitlement, once, here, and again
--     whenever a studio is superseded later: anyone still entitled (their own
--     plan, or a seat in another live studio) is skipped, and anyone left on a
--     capped plan gets apply_free_tier_archival() -- the lapse path, which
--     archives past the cap as 'plan_lapse' and deletes nothing; every restore
--     path already undoes it. Members are visited in user id order, the order
--     reconcile_studio_seats() uses, so the two cannot deadlock on a member's
--     locks. A studio brought back (superseded_at cleared) is handed to
--     reconcile_studio_seats(), as any seat change is.
--
--  2. Live ink. seat_grace_deadline() (20261020181100) still read every studio
--     a member belonged to, so a retired membership could still refuse its
--     member broadcast in the last hour of the owner's grace -- on the member's
--     own score, or with a plan of their own. It now reads live studios only,
--     the boundary resolve_entitlements() draws, and so does the restrictive
--     doc_topic_seat_grace_broadcast policy that asks it (through
--     caller_seat_grace_ends_before_token(), unchanged).
--
-- Deliberately NOT changed: subscriptions_follow_district (20261020180500) and
-- the retention functions (20261021120700, 20261021120800) still visit
-- superseded studios. Superseding retires a studio's seats, not its billing
-- history or the district's retention duties to students attributed to it, so
-- retention must keep processing it.
--
-- Rerunnable: functions CREATE OR REPLACE, the trigger dropped before it is
-- created, and the one-off pass archives only what is still past a cap.

-- ---------------------------------------------------------------------------
-- 2. seat_grace_deadline(): live studios only
-- ---------------------------------------------------------------------------
-- The 20261020181100 definition, except that both membership reads skip a
-- superseded studio.
create or replace function public.seat_grace_deadline (p_user uuid) returns timestamptz language plpgsql stable
security definer
set search_path = public as $$
begin
    if p_user is null or not exists (
        select 1
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        where sm.user_id = p_user
          and st.superseded_at is null
    ) then
        return null;
    end if;
    return (
        select min(public.district_grace_ends_at (s.stripe_subscription_id, s.past_due_since))
        from public.subscriptions s
        where s.status = 'past_due'
          and (
              s.user_id = p_user
              or s.user_id in (
                  select st.owner_id
                  from public.studio_members sm
                  join public.studios st on st.id = sm.studio_id
                  where sm.user_id = p_user
                    and st.superseded_at is null
              )
          )
          and public.subscription_is_live (s)
    );
end;
$$;

-- Unchanged from 20261020181100.
revoke all on function public.seat_grace_deadline (uuid) from public;
revoke all on function public.seat_grace_deadline (uuid) from anon;
revoke all on function public.seat_grace_deadline (uuid) from authenticated;
grant execute on function public.seat_grace_deadline (uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 1. A superseded studio's members, on their final entitlement
-- ---------------------------------------------------------------------------
-- One member: skipped while still entitled (unlimited cloud scores), else
-- archived past the plan's cap. apply_free_tier_archival() takes the member's
-- row locks and the cap's advisory lock and re-reads the entitlement under
-- them, so this read is a filter, never the cap. Also records whether the
-- member is a read-only seat now, as reconcile_studio_seats() does, so the
-- live-ink hint follows a seat the retired studio no longer makes read-only.
-- Returns the scores it archived.
create or replace function public.superseded_studio_member_follow (p_user uuid) returns int language plpgsql security definer
set search_path = public as $$
declare
    v_ent jsonb;
    v_archived int := 0;
begin
    if p_user is null then
        raise exception 'superseded_studio_member_follow requires p_user' using errcode = '22023';
    end if;

    v_ent := public.resolve_entitlements (p_user);
    if (v_ent -> 'limits' ->> 'cloud_scores')::int >= 0 then
        v_archived := public.apply_free_tier_archival (p_user);
    end if;
    perform public.seat_live_ink_follow (p_user, coalesce((v_ent ->> 'seat_read_only')::boolean, false));
    return v_archived;
end;
$$;

revoke all on function public.superseded_studio_member_follow (uuid) from public;
revoke all on function public.superseded_studio_member_follow (uuid) from anon;
revoke all on function public.superseded_studio_member_follow (uuid) from authenticated;
grant execute on function public.superseded_studio_member_follow (uuid) to service_role;

-- A studio superseded, or brought back, after this migration.
create or replace function public.studios_follow_superseded () returns trigger language plpgsql security definer
set search_path = public as $$
declare
    v_member uuid;
begin
    if old.superseded_at is null and new.superseded_at is not null then
        for v_member in
            select sm.user_id
            from public.studio_members sm
            join auth.users u on u.id = sm.user_id
            where sm.studio_id = new.id
            order by sm.user_id
        loop
            perform public.superseded_studio_member_follow (v_member);
        end loop;
    elsif old.superseded_at is not null and new.superseded_at is null then
        perform public.reconcile_studio_seats (new.id);
    end if;
    return null;
end;
$$;

revoke all on function public.studios_follow_superseded () from public;
revoke all on function public.studios_follow_superseded () from anon;
revoke all on function public.studios_follow_superseded () from authenticated;

drop trigger if exists studios_follow_superseded on public.studios;

create trigger studios_follow_superseded after update of superseded_at on public.studios
for each row
when (old.superseded_at is distinct from new.superseded_at)
execute function public.studios_follow_superseded ();

-- The studios 20261022100300 already superseded: every member of any of them,
-- once each, in user id order.
do $$
declare
    v_member uuid;
    v_members int := 0;
    v_archived int := 0;
begin
    for v_member in
        select distinct sm.user_id
        from public.studio_members sm
        join public.studios st on st.id = sm.studio_id
        join auth.users u on u.id = sm.user_id
        where st.superseded_at is not null
        order by sm.user_id
    loop
        v_archived := v_archived + public.superseded_studio_member_follow (v_member);
        v_members := v_members + 1;
    end loop;

    if v_members > 0 then
        raise notice 'superseded studios: % member(s) brought in line with their entitlement, % score(s) archived as plan_lapse',
            v_members, v_archived;
    end if;
end;
$$;
