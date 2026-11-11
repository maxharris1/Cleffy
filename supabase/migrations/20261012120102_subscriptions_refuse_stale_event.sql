-- Refuse a subscription write that carries an older Stripe event than the row
-- already holds (QA round 4, D3).
--
-- `customer.subscription.created` / `.updated` already re-read the subscription
-- from Stripe instead of applying the copy embedded in the event, which removes
-- most of the damage reordering can do. What it cannot remove is two deliveries
-- in flight at once: A reads `active`, B reads the newer `past_due`, B writes,
-- and then A's write lands and puts `active` back. The row then says a customer
-- whose card failed is paid up, until the next event about them -- a month away
-- on a monthly plan, a year on an annual one.
--
-- So each write now carries the `created` timestamp of the event that triggered
-- it, and the row keeps the newest one it has seen. Stripe stamps `created` on
-- every event, and it is the account's clock for both deliveries, so comparing
-- them is meaningful in a way that comparing our own two write times is not.
--
-- It has to be a trigger: the webhook writes through PostgREST's upsert, which
-- has no way to carry a conditional `where`, and splitting it into a read and a
-- write would reintroduce the same race one level up.
alter table public.subscriptions
    add column if not exists last_event_created_at timestamptz;

-- BEFORE UPDATE returning OLD rather than NULL: the write is dropped, but the
-- statement still reports a row, so PostgREST answers the webhook 200 and
-- Stripe is not asked to retry an event that is simply too old to matter.
--
-- Both NULL cases let the write through, and both are real:
--  * the row has no stamp -- every row written before this migration, and any
--    row a code path other than the webhook touches. There is nothing to
--    compare against, and refusing would freeze those rows permanently.
--  * the write has no stamp -- an event without `created` (nothing Stripe sends
--    today), or a future caller that does not thread one through. A guard that
--    swallowed those would silently drop legitimate writes, which is strictly
--    worse than the staleness it is guarding against; it keeps the stamp the
--    row already has instead, so one unstamped write cannot wipe out the
--    high-water mark and reopen the window for the next stale event.
--
-- Equal stamps pass. Re-processing the SAME event has to stay possible: a retry
-- after a failure that landed its upsert but not the archival after it depends
-- on being able to write the same state again.
create or replace function public.subscriptions_refuse_stale_event () returns trigger
language plpgsql set search_path = public as $$
begin
    if new.last_event_created_at is null then
        new.last_event_created_at := old.last_event_created_at;
        return new;
    end if;

    if old.last_event_created_at is not null and new.last_event_created_at < old.last_event_created_at then
        return old;
    end if;

    return new;
end;
$$;

revoke all on function public.subscriptions_refuse_stale_event () from public, anon, authenticated;

drop trigger if exists subscriptions_refuse_stale_event on public.subscriptions;

create trigger subscriptions_refuse_stale_event
    before update on public.subscriptions
    for each row
    execute function public.subscriptions_refuse_stale_event ();
