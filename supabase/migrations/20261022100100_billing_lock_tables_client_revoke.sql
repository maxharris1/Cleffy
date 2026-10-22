-- No client role holds anything on the three billing lock tables (decision 20).
--
-- checkout_attempts (20261012120103), subscription_writes (20261012120105) and
-- duplicate_refunds (20261013120102) are the service role's alone: they are
-- read and written only by the webhook and stripe-checkout, through
-- begin/stage/finish/release_checkout_attempt, claim/release_subscription_write
-- and the duplicate-refund functions, all of which refuse every other caller.
-- Each migration enabled RLS, added no policy and granted the service role,
-- but never revoked from the client roles, so they kept whatever the default
-- ACL for `postgres`-owned tables in `public` hands out. On the local stack
-- (and any project whose default ACL is permissive) that is arwdDxtm: RLS
-- still hides every row, but a signed-in or anonymous caller can count the
-- tables, and TRUNCATE ignores RLS altogether. tests/sql/billing_double_charge.sql
-- checks 89, 92 and 98 ("or read the attempts table", "or read the write locks
-- table", "nor read the refund ledger") expect 42501 and failed 3 of 98 there.
--
-- Same convention as every other billing table: revoke from public, anon and
-- authenticated; the service role's own grant is untouched. Rerunnable.

revoke all on table public.checkout_attempts from public, anon, authenticated;
revoke all on table public.subscription_writes from public, anon, authenticated;
revoke all on table public.duplicate_refunds from public, anon, authenticated;
