# District seats — admin runbook

A district is an Academy sold on a custom quote through **Stripe Invoicing**
(`collection_method = send_invoice`), with more teacher seats than Academy's 5.
The seat count is an admin-set override in `public.studio_seat_overrides`, tied
to the district's subscription. Schema and reasoning:
`supabase/migrations/20261020180400_district_seat_overrides.sql`.

## How it behaves

- The override counts only while the subscription it names is the studio
  owner's own, `send_invoice`, Academy, in an entitling Stripe account, `active`
  or `trialing`, and inside its period. Overdue (`past_due`), cancelled or ended
  puts the studio back on 5; a payment or renewal brings the override back. No
  one has to re-set it.
- The Stripe webhook never writes the override. It only records the
  subscription, now including its `collection_method`.
- Teachers already seated keep their seats when the override lapses. Nobody is
  removed, but no one new can be added until the count is under the limit.
- Every set, change and clear (including a hand-run SQL statement, and the
  cascade when a studio or its owner is deleted) is logged in
  `public.studio_seat_override_log`.

## Setting up a district (test mode first, then live)

1. **Owner account.** The district's admin signs up for Cleffy. They must not
   hold another running subscription in the same Stripe account. A second
   entitling subscription is treated as a double charge, and the webhook cancels
   and refunds the newcomer. If they already pay for Academy by card, cancel that
   first (immediately, not at period end), or use a separate account.
2. **Stripe subscription** (Dashboard → Billing → Subscriptions → Create, or the
   API):
    - Customer: the district (billing email = whoever pays invoices).
    - Price: a custom price on the **Academy** product, at the quoted amount and
      interval.
    - Payment: **Email invoice to the customer** (`send_invoice`). Set
      `days_until_due` to the contract's net terms (e.g. 30 or 60). Stripe marks
      the subscription `past_due` once an invoice passes its due date unpaid, and
      the district then loses Academy until it pays.
    - Metadata: `user_id` = the owner's Cleffy user id (from `auth.users`), and
      `cleffy_plan` = `district`. Both are required. Without `user_id` the webhook
      cannot attribute the subscription (no Checkout ever linked this customer).
      Without `cleffy_plan=district` a custom price maps to the free tier.
3. **Check the webhook recorded it** (SQL editor):

    ```sql
    select stripe_subscription_id, user_id, tier, status, collection_method, current_period_end
    from public.subscriptions where stripe_subscription_id = 'sub_...';
    -- expect tier = 'academy', collection_method = 'send_invoice'
    ```

4. **Owner creates their academy.** Account page → Academy seats → Create
   academy.
5. **Set the seat count** (SQL editor; the count includes the owner):

    ```sql
    select public.admin_set_studio_seat_override(
        p_studio => (select st.id from public.studios st
                     join auth.users u on u.id = st.owner_id
                     where u.email = 'admin@district.example'),
        p_seat_limit => 40,
        p_stripe_subscription_id => 'sub_...',
        p_actor => 'Max',
        p_reason => 'Contract #..., 40 teachers, 2026-27'
    );
    ```

    The function refuses, with a message saying why, a count ≤ 5, a subscription
    the webhook has not recorded yet, one belonging to someone else, a
    card-paid one, or one that does not resolve to Academy.

## Changing, ending, auditing

```sql
-- Change: run admin_set_studio_seat_override again with the new count.
-- End (studio back to 5):
select public.admin_clear_studio_seat_override('<studio id>', 'Max', 'Contract ended');
-- History:
select * from public.studio_seat_override_log where studio_id = '<studio id>' order by id;
```

Both admin functions are callable only by the service role (and from the SQL
editor). They refuse any caller with a user JWT.
