-- Money we owe a double-charged customer, written down where an event cannot
-- lose it (QA round 4 review of #56, finding 2).
--
-- What 20261012120100's handler left open. When the partial unique index refuses
-- a SECOND entitling subscription, the double charge has already happened in
-- Stripe, so stripe-webhook cancels that subscription and refunds it. If the
-- refund fails in a way a retry might get past, it answers Stripe 500 and
-- releases the event claim, so the delivery comes again.
--
-- The retry does come -- and it never reaches the refund, because the CANCEL
-- succeeded. The redelivery re-reads the subscription from Stripe, which now
-- says `canceled`; `canceled` is not an entitling status, so the index has
-- nothing to refuse; so the row is written as an ordinary cancellation and the
-- event is acknowledged 200. The duplicate branch -- the only code that has ever
-- attempted a refund -- is never entered again. The customer keeps paying for a
-- plan they were charged twice for, and after the 200 nothing anywhere records
-- that a refund was owed. One ALERT line, three days old, in a log.
--
-- So the debt stops being a property of an EVENT and becomes a row. It is keyed
-- on the subscription, because that is the identifier that does not change: the
-- event id changes with every delivery, the subscription's status changes under
-- the retry, the ledger key does neither. stripeEvents.ts writes it before
-- either Stripe call is attempted and retries it from every later delivery about
-- that subscription, whatever that subscription's status has become
-- (finishPendingDuplicateUndo).
--
-- Both halves are safe to repeat, which is what makes retrying from an arbitrary
-- later delivery correct rather than merely hopeful: a subscription already ended
-- is recognised and left alone, and the refund carries an idempotency key per
-- invoice, so Stripe answers a repeat with the original refund instead of making
-- a second one (_shared/stripe.ts, cancelAndRefundDuplicate).
create table if not exists public.duplicate_refunds (
    stripe_subscription_id text not null,
    -- Mode-keyed like billing_customers, and read mode-filtered, for the reason
    -- the D4 note in stripe-webhook/index.ts gives: Stripe ids are globally
    -- unique, but that is a property of Stripe's id space rather than an
    -- invariant of this table, and every other billing lookup is filtered.
    mode text not null check (mode in ('live', 'test')),
    -- `set null` rather than `cascade`: an account being deleted does not make a
    -- refund we never issued stop being owed, and this row is the only record of
    -- it. The subscription id in it is still enough for a human to find the
    -- charge in Stripe.
    user_id uuid references auth.users (id) on delete set null,
    -- `pending` is the only one anything retries. `needs_human` is a paid
    -- invoice whose payment cannot be identified -- it reads the same way on
    -- every attempt, so retrying it would bury the alert instead of surfacing
    -- it. See DuplicateUndoState in _shared/stripeEvents.ts.
    state text not null check (state in ('pending', 'resolved', 'needs_human')),
    -- Whether the duplicate can still bill, and what came of the refund half:
    -- 'refunded' / 'nothing_to_refund' / 'needs_human' / 'failed', null before
    -- the first attempt has answered.
    stopped boolean not null default false,
    refund text,
    -- cancelAndRefundDuplicate's own notes, which is what a human reconciling
    -- this row reads.
    detail text,
    -- How many attempts have reported back (one per settle, so one per pair of
    -- Stripe calls). A row with a high count still `pending` is the shape of a
    -- refund no delivery will ever manage, which is the one a human has to take.
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (stripe_subscription_id, mode)
);

-- What a reconciliation reads: everything still owed, oldest first.
create index if not exists duplicate_refunds_unsettled
    on public.duplicate_refunds (created_at)
    where state <> 'resolved';

-- Service role only, like every other billing table: the client never reads or
-- writes this. No policy, so RLS refuses every client role outright.
alter table public.duplicate_refunds enable row level security;

-- service_role bypasses RLS but still needs the table-level grant (see
-- 20260827140000_core_table_grants.sql).
grant all on table public.duplicate_refunds to service_role;

-- Open the debt. Called BEFORE the Stripe calls are attempted, so an isolate
-- that dies between them has still left the row.
--
-- An already `resolved` row is left resolved: the undo is idempotent, so
-- re-attempting it is harmless, but reopening a settled ledger entry would make
-- money we have handed back look outstanding. `attempts` is left alone too --
-- the attempt this call precedes is counted when it reports back, below.
create or replace function public.record_duplicate_refund (
    p_subscription_id text,
    p_mode text,
    p_user uuid
) returns void language plpgsql set search_path = public as $$
begin
    insert into public.duplicate_refunds as d (stripe_subscription_id, mode, user_id, state)
    values (p_subscription_id, p_mode, p_user, 'pending')
    on conflict (stripe_subscription_id, mode) do update
    set user_id = coalesce(excluded.user_id, d.user_id),
        state = case when d.state = 'resolved' then d.state else 'pending' end,
        updated_at = now();
end;
$$;

-- Close it, or record that this attempt did not. Scoped to nothing: whichever
-- delivery last spoke to Stripe holds the freshest answer, and all of them are
-- asking Stripe about the same subscription.
--
-- Every settle counts an attempt, including the ones that leave the row
-- `pending`, because that count is what distinguishes a refund Stripe refused
-- once from one it will refuse forever.
create or replace function public.settle_duplicate_refund (
    p_subscription_id text,
    p_mode text,
    p_state text,
    p_stopped boolean,
    p_refund text,
    p_detail text
) returns void language plpgsql set search_path = public as $$
begin
    update public.duplicate_refunds
    set state = p_state,
        stopped = p_stopped,
        refund = p_refund,
        detail = p_detail,
        attempts = attempts + 1,
        updated_at = now()
    where stripe_subscription_id = p_subscription_id and mode = p_mode;
end;
$$;

-- Is anything still owed on this subscription? Answers the row, so the caller's
-- alert can name the user the duplicate belonged to -- which the delivery doing
-- the retry has no other way of knowing, since it is usually an event about a
-- subscription that no longer looks like a duplicate at all.
create or replace function public.pending_duplicate_refund (p_subscription_id text, p_mode text)
returns table (user_id uuid, attempts integer) language sql stable set search_path = public as $$
select d.user_id, d.attempts
from public.duplicate_refunds d
where d.stripe_subscription_id = p_subscription_id and d.mode = p_mode and d.state = 'pending'
$$;

revoke all on function public.record_duplicate_refund (text, text, uuid) from public, anon, authenticated;
revoke all on function public.settle_duplicate_refund (text, text, text, boolean, text, text)
    from public, anon, authenticated;
revoke all on function public.pending_duplicate_refund (text, text) from public, anon, authenticated;

grant execute on function public.record_duplicate_refund (text, text, uuid) to service_role;
grant execute on function public.settle_duplicate_refund (text, text, text, boolean, text, text) to service_role;
grant execute on function public.pending_duplicate_refund (text, text) to service_role;
