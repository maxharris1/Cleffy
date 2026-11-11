-- Launch checkout compliance (launch packet items 14, 18, 19).
--
-- 1. checkout_consents -- the auto-renewal consent behind every purchase: who,
--    which Checkout Session / subscription, the EXACT wording they ticked, the
--    Terms and Refund Policy versions, when, the billing country and the IP.
--    CA BPC §17602 / NY GBL §527-a want the consent provable; we keep it at
--    least three years (see the delete guard below).
--
--    user_id is ON DELETE SET NULL, not CASCADE: deleting an account must not
--    delete the proof that its owner agreed to be charged, which is the record
--    we would need if a charge were ever disputed after the deletion. The row
--    keeps the Stripe customer and subscription ids, which is enough to find the
--    payment, and holds no email address.
--
-- 2. billing_cancel_tokens -- the signed-out cancel link (/cancel). Only a
--    SHA-256 of the token is stored; the token itself exists only in the email.
--
-- 3. billing_notices -- one row per confirmation email sent, so a webhook
--    redelivery (or two deliveries of different events about the same
--    purchase) never mails the customer twice.
--
-- 4. billing_user_for_email() -- the cancel flow's lookup from an address to an
--    account, service role only (the guest_email_taken pattern).
--
-- All three tables are service-role only: no client role can read or write
-- them, and the Edge Functions are the only writers.

-- ---------------------------------------------------------------------------
-- checkout_consents
-- ---------------------------------------------------------------------------
create table public.checkout_consents (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users (id) on delete set null,
    mode text not null check (mode in ('live', 'test')),
    stripe_customer_id text not null,
    checkout_session_id text,
    stripe_subscription_id text,
    price_id text not null,
    plan_slot text not null,
    currency text not null check (currency in ('usd', 'eur', 'gbp')),
    amount_minor integer not null check (amount_minor >= 0),
    renewal_interval text not null check (renewal_interval in ('month', 'year')),
    tax_inclusive boolean not null,
    -- The sentence the checkbox stood for, byte for byte (billingTerms.ts
    -- autoRenewalConsentText; stripe-checkout refuses a mismatch).
    wording text not null check (length(wording) between 1 and 4000),
    wording_version text not null,
    terms_version text not null,
    refund_policy_version text not null,
    -- The country the buyer chose in the pricing dialog, which set the currency.
    declared_country text not null check (declared_country ~ '^[A-Z]{2}$'),
    -- The billing address country Stripe collected, filled in on completion.
    billing_country text check (billing_country ~ '^[A-Z]{2}$'),
    ip_address text,
    user_agent text,
    consented_at timestamptz not null default now(),
    completed_at timestamptz
);

create index checkout_consents_user on public.checkout_consents (user_id);
create index checkout_consents_session on public.checkout_consents (checkout_session_id);
create index checkout_consents_subscription on public.checkout_consents (stripe_subscription_id);

-- The retention floor, enforced rather than promised: a retention job written
-- later (or a hand-run delete) cannot take a consent younger than three years.
-- Retention past three years is a policy decision for later; nothing purges
-- these today.
create or replace function public.checkout_consents_refuse_early_delete () returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if old.consented_at > now() - interval '3 years' then
        raise exception 'checkout consents are kept for at least three years' using errcode = '42501';
    end if;
    return old;
end;
$$;

revoke all on function public.checkout_consents_refuse_early_delete () from public, anon, authenticated, service_role;

create trigger checkout_consents_refuse_early_delete
before delete on public.checkout_consents
for each row execute function public.checkout_consents_refuse_early_delete ();

alter table public.checkout_consents enable row level security;

revoke all on table public.checkout_consents from public, anon, authenticated;
grant select, insert, update, delete on table public.checkout_consents to service_role;

-- ---------------------------------------------------------------------------
-- billing_cancel_tokens
-- ---------------------------------------------------------------------------
create table public.billing_cancel_tokens (
    token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid not null references auth.users (id) on delete cascade,
    mode text not null check (mode in ('live', 'test')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz
);

create index billing_cancel_tokens_user on public.billing_cancel_tokens (user_id);
create index billing_cancel_tokens_expires on public.billing_cancel_tokens (expires_at);

alter table public.billing_cancel_tokens enable row level security;

revoke all on table public.billing_cancel_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_cancel_tokens to service_role;

-- ---------------------------------------------------------------------------
-- billing_notices
-- ---------------------------------------------------------------------------
create table public.billing_notices (
    kind text not null check (kind in ('purchase_confirmation', 'cancellation_confirmation')),
    -- The Checkout Session for a purchase; subscription id + cancel time for a cancellation.
    stripe_object_id text not null,
    created_at timestamptz not null default now(),
    primary key (kind, stripe_object_id)
);

alter table public.billing_notices enable row level security;

revoke all on table public.billing_notices from public, anon, authenticated;
grant select, insert, update, delete on table public.billing_notices to service_role;

-- ---------------------------------------------------------------------------
-- billing_user_for_email
-- ---------------------------------------------------------------------------
-- The account an address belongs to, for the signed-out cancel flow. Anonymous
-- (guest) accounts never match: they have no billing relationship. The caller
-- answers every request identically whatever this returns, so it is not an
-- account-existence oracle to the person typing the address.
create or replace function public.billing_user_for_email (p_email text) returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_user uuid;
begin
    if coalesce(auth.role (), '') <> 'service_role' then
        raise exception 'billing_user_for_email is for the service role only' using errcode = '42501';
    end if;
    if p_email is null or length(trim(p_email)) = 0 then
        return null;
    end if;
    select u.id into v_user
    from auth.users u
    where lower(u.email) = lower(trim(p_email))
      and coalesce(u.is_anonymous, false) = false
    limit 1;
    return v_user;
end;
$$;

revoke all on function public.billing_user_for_email (text) from public, anon, authenticated;
grant execute on function public.billing_user_for_email (text) to service_role;
