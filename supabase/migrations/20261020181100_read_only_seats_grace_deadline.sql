-- Live ink stops at the grace deadline itself, not at the next sweep
-- (launch-compliance decision 26; Codex round-4 review of PR #61, D2 partial).
--
-- Every check a read-only seat meets per request already compares now()
-- against the stored grace deadline: caller_seat_read_only() reads
-- resolve_entitlements(), whose subscription_is_live() asks
-- now() < district_grace_ends_at(), so marks, lesson history, renames, share
-- links, assignments and every write to the 'scores' bucket are refused from
-- the deadline itself, with nothing recorded and nothing archived -- no sweep
-- (tests/sql/district_read_only_seats.sql proves it with every trigger off).
--
-- Live ink is the exception, because Realtime does not ask per request. It
-- asks the broadcast policy when a channel JOINS and again when the client
-- hands it a new access token, and keeps the answer until then -- at the
-- latest until that token expires, when it closes the channel (proven against
-- the local Realtime server; 20261020180800). A join answered while the
-- district's grace still ran therefore kept its live ink past the deadline,
-- until the hourly sweep (20261020180500's district-seat-reconcile) noticed and
-- rotated the score's topic: up to an hour of a modified client drawing live on
-- a seat the clock had already made read-only.
--
-- So the join itself is now asked whether the answer would outlive the
-- deadline. A district member whose seat rests on a subscription inside its
-- past-due grace (decisions 21 and 25: card or Stripe Invoicing), and whose
-- grace ends before the token Realtime is authorizing expires (its exp claim),
-- is refused broadcast on doc:{id}. Whatever Realtime holds then expires no
-- later than the deadline: a channel authorized earlier was authorized with a
-- token that runs out before it, and every refresh after that is refused. A
-- token with no exp is treated as never expiring. The cost is live ink for a
-- seat in the last token lifetime (jwt_expiry, an hour) of a grace period of
-- 30 days or more -- marks still save, through RLS, and reach everyone through
-- doc-db:{id} -- and it is a member of a district in that last hour, not only
-- the seats that will go read-only: which of them do depends on what the owner
-- does in that hour. Paying ends the grace period and with it the refusal at
-- the next join or refresh. Presence, receiving, and anyone who is not a
-- member of such a district (a roster student included) are untouched.
--
-- The sweep keeps its job: it records the seat, sends the membership hint and
-- rotates the topics (20261020180800) once the clock has moved it, as before.
--
-- Rerunnable: functions CREATE OR REPLACE, the policy dropped before it is
-- created.

-- ---------------------------------------------------------------------------
-- When the clock alone could make this account a read-only seat
-- ---------------------------------------------------------------------------
-- The earliest grace deadline among the past-due subscriptions, inside their
-- grace, that this account's seat or own plan rests on: its own, and those of
-- the owners of the studios it is a member of. Null for an account that is no
-- studio's member (the cheap common case: one index probe), and for a member
-- whose district pays outright. subscription_is_live() of a past_due row is
-- exactly "inside its grace", so the deadline is always still ahead.
create or replace function public.seat_grace_deadline (p_user uuid) returns timestamptz language plpgsql stable
security definer
set search_path = public as $$
begin
    if p_user is null or not exists (select 1 from public.studio_members sm where sm.user_id = p_user) then
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
              )
          )
          and public.subscription_is_live (s)
    );
end;
$$;

-- For the policy below: does the caller's grace end before the token Realtime
-- is authorizing does? Written `(select ...)` in the policy, so it is planned
-- once per statement.
create or replace function public.caller_seat_grace_ends_before_token () returns boolean language sql stable
security definer
set search_path = public as $$
    select coalesce(
        public.seat_grace_deadline (auth.uid())
            <= coalesce(to_timestamp(nullif(auth.jwt () ->> 'exp', '')::double precision), 'infinity'::timestamptz),
        false
    );
$$;

revoke all on function public.seat_grace_deadline (uuid) from public;
revoke all on function public.seat_grace_deadline (uuid) from anon;
revoke all on function public.seat_grace_deadline (uuid) from authenticated;
grant execute on function public.seat_grace_deadline (uuid) to service_role;

revoke all on function public.caller_seat_grace_ends_before_token () from public;
revoke all on function public.caller_seat_grace_ends_before_token () from anon;
grant execute on function public.caller_seat_grace_ends_before_token () to authenticated;
grant execute on function public.caller_seat_grace_ends_before_token () to service_role;

-- ---------------------------------------------------------------------------
-- Live ink
-- ---------------------------------------------------------------------------
-- Restrictive, beside 20261020180600's doc_topic_seat_read_only_broadcast and
-- whatever permissive policies the topic has (#63's included): ANDed with them,
-- so it neither copies nor can undo another migration's definition.
drop policy if exists doc_topic_seat_grace_broadcast on realtime.messages;

create policy doc_topic_seat_grace_broadcast on realtime.messages as restrictive for insert to authenticated
with check (
    realtime.messages.extension is distinct from 'broadcast'
    or realtime.topic () not like 'doc:%'
    or not (select public.caller_seat_grace_ends_before_token ())
);
