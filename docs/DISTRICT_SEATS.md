# District seats — admin runbook

A district is an Academy sold on a custom quote through **Stripe Invoicing**
(`collection_method = send_invoice`), with more teacher seats than Academy's 5.
The seat count is an admin-set override in `public.studio_seat_overrides`, tied
to the district's subscription. Schema and reasoning:
`supabase/migrations/20261020180400_district_seat_overrides.sql` and
`supabase/migrations/20261020180500_district_seat_cap_and_grace.sql`.

## How it behaves

- The override counts only while the subscription it names is the studio
  owner's own, `send_invoice`, Academy, in an entitling Stripe account, and
  **live**: `active` or `trialing` inside its period, or `past_due`/`unpaid`
  inside its **invoice grace period** (below). Cancelled, ended or past grace
  puts the studio back on 5; a payment or renewal brings the override back. No
  one has to re-set it.
- The Stripe webhook never writes the override. It only records the
  subscription, now including its `collection_method`. It links the district's
  Stripe customer to the owner, so the owner's billing portal works.
- **Seats past the limit are read-only.** If the studio has more teachers than
  its effective limit (an override lowered, cleared or lapsed, or a district
  moved to ordinary Academy), only the first limit − 1 teachers keep Academy:
  the ones the owner chose to keep, then the longest-seated. The rest can open
  and export their scores but cannot edit them, upload, import, run analyses or
  add students. That holds on **every** score, their own and ones shared with
  them, from the moment the seat goes read-only: the database asks who is
  writing on each write (marks, lesson history, live ink, renaming, share
  links, assignments), not only whether the score is archived. Their own scores
  are also archived as `plan_lapse` and their entitlements read
  `seat_read_only`. Marks a read-only teacher drew are kept on their device and
  upload once the seat is active again; roster students keep their Edit
  access. **Nothing is deleted.** When the override
  comes back, or the district pays, every seat and every score returns at once.
  No one new can be seated while the studio is over its limit.
- The owner chooses who stays active on **Account → Academy seats** (tick up to
  limit − 1 and save). The panel stays visible to an owner whose plan has
  lapsed, because that is when the choice matters. Removing a read-only teacher
  releases them to an ordinary free account with their scores back up to the
  free cap.
- Seats are re-ranked on every override change, subscription write, pick and
  removal, and an hourly `district-seat-reconcile` cron handles what only the
  clock changes (a grace period running out). Entitlements and the read-only
  write check are right immediately either way. Only the archive (which stops
  other collaborators editing a read-only teacher's own scores) can lag, by up
  to an hour.
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
      the subscription `past_due` once an invoice passes its due date unpaid.
      The district keeps full access for 30 days after that, then the seats
      past 5 go read-only until it pays (see _Past-due invoices_). Set up the
      Invoicing reminders described there.
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

## Past-due invoices: 30 days of grace

A `send_invoice` subscription that goes `past_due` or `unpaid` keeps **full
access, override included, for 30 days** from when it went past due
(`subscriptions.past_due_since`, stamped on the first past-due write; Stripe
marks an invoiced subscription past due at the invoice's due date). After that,
the read-only rules above apply. Card subscriptions get no grace and behave as
before.

**Stripe Invoicing reminders** (Dashboard → Settings → Billing → Subscriptions
and emails → _Manage invoices sent to customers_; test mode first, then live):

- Send reminders **on the due date**, **7 days after** and **21 days after**.
- _If an invoice remains unpaid after its due date_: **leave the subscription
  past due**, or cancel it no sooner than 30 days plus the longest extension you
  expect to grant. Cancelling inside the grace period cuts the grace short,
  because a cancelled subscription is not live.

**Extending grace for one district** (per studio):

```sql
select public.admin_extend_district_grace(
    p_studio => '<studio id>',
    p_grace_until => '2026-12-15T00:00:00Z',  -- null puts it back to 30 days
    p_actor => 'Max',
    p_reason => 'PO approved, payment in transit'
);
-- returns grace_ends_at: the later of past_due_since + 30 days and the extension
```

## Contract end and data retention

`public.district_billing` is the district's billing record, one row per studio.
The webhook creates it from the owner's `send_invoice` subscription, and setting
an override creates it too. Its `contract_ends_at` is what the retention purge
(PR #64) counts from: district data is purged 30 days after it, with a 14-day
export notice first. **Null means never purged.**

- By default it follows Stripe's **actual** end, and nothing else: null while
  the subscription has not ended (a cancellation that is only scheduled, past
  due, or resumed), then the day Stripe says it ended (`ended_at`, or the
  `cancel_at` it ended on). Never a scheduled date and never a billing-period
  date: a district that schedules cancellation for next year and then cancels
  today counts from today, and one cancelled long after its last recorded
  period does not count from that period. A redelivered cancellation never
  moves it.
- An admin can pin it from the contract, which Stripe writes then leave alone:

```sql
-- Pin a date (or p_contract_ends_at => null for "never purge"):
select public.admin_set_district_contract_end('<studio id>', '2027-06-30T00:00:00Z', 'Max', 'Contract #123 term');
-- Hand it back to Stripe's dates:
select public.admin_set_district_contract_end('<studio id>', null, 'Max', 'Follow Stripe', p_automatic => true);
-- Check it:
select contract_ends_at, contract_ends_source, grace_extended_until from public.district_billing
where studio_id = '<studio id>';
```

Every change to the billing record is logged in `public.district_billing_log`.

## Changing, ending, auditing

```sql
-- Change: run admin_set_studio_seat_override again with the new count.
-- End (studio back to 5):
select public.admin_clear_studio_seat_override('<studio id>', 'Max', 'Contract ended');
-- History:
select * from public.studio_seat_override_log where studio_id = '<studio id>' order by id;
-- Who is active and who is read-only right now:
select s.*, u.email from public.studio_seat_states('<studio id>') s join auth.users u on u.id = s.user_id;
```

Clearing an override does not end the contract. `contract_ends_at` lives on
`district_billing`, so set or follow it separately (above).

The admin functions are callable only by the service role (and from the SQL
editor). They refuse any caller with a user JWT.
