-- At most one entitling subscription per user per Stripe account.
--
-- The double charge this closes (QA round 4, D1): stripe-checkout refused a
-- second purchase by reading this table, but it read it when a Checkout Session
-- was CREATED, not when one was PAID. Two sessions opened before either was
-- paid both passed the guard -- two tabs, a double-click, a back button and a
-- retry; a session stays payable for 24 hours -- and paying both left the
-- customer with two `active` subscriptions whose billed periods overlapped
-- completely, $38 for one plan's worth of service. Nothing told them: the
-- entitlements RPC takes the highest tier and stops (`order by tier ... limit
-- 1`), so the app looked exactly as it does for one subscription, and the
-- second renewed every month unnoticed.
--
-- stripe-checkout now expires the customer's open sessions before it opens
-- another and passes Stripe a deterministic idempotency key, so two sessions
-- should no longer exist to be paid. This index is the layer that does not
-- depend on an Edge Function having run at all: whatever a client, a Stripe
-- retry or a future code path does, the webhook's upsert cannot land a SECOND
-- entitling row beside one that is already there. Entitlement is computed from
-- rows with these statuses, so a status nobody is entitled by is not something
-- to serialise -- a cancelled subscription and the new one replacing it must
-- both be allowed to sit here.
--
-- What the webhook does when it hits this index is deliberate and is NOT to
-- cancel the loser in Stripe (see stripe-webhook/index.ts): the row is left
-- absent, the event is acknowledged, and a single ALERT line names the user and
-- both subscriptions for a human to reconcile.

-- Fail the push rather than skip the index.
--
-- `create unique index` on a table that already violates it aborts the whole
-- `db push` with Postgres's own message, which names the duplicated KEY but not
-- the user, and leaves whoever is deploying to work out what to do. This says
-- it instead -- and it still fails, on purpose. The alternative, creating the
-- index only when the data allows it, would mean the one database that has
-- already double-charged somebody is the one database left unprotected, and the
-- failure would be a line in a log nobody reads rather than a stopped deploy.
-- Reconcile in Stripe first (cancel the duplicate subscription, refund it),
-- then push.
--
-- Checked read-only against production (jibgwgosihadbjgxdsfe) on 2026-10-12:
-- no user holds more than one entitling subscription in either mode, out of one
-- subscription row in total.
do $$
declare
    v_dup record;
begin
    select s.user_id, s.mode, count(*) as n
    into v_dup
    from public.subscriptions s
    where s.status in ('active', 'trialing')
    group by s.user_id, s.mode
    having count(*) > 1
    limit 1;

    if found then
        raise exception
            'user % already holds % entitling subscriptions in % mode; cancel and refund the duplicate in Stripe, then push this migration',
            v_dup.user_id, v_dup.n, v_dup.mode
            using errcode = '23505';
    end if;
end
$$;

create unique index if not exists subscriptions_one_entitling_per_user_mode
    on public.subscriptions (user_id, mode)
    where status in ('active', 'trialing');
