-- Hand back one use of an edge rate-limit bucket.
--
-- guest-email-start's per-mailbox and project-wide limits are meant to count
-- mail that went out (DEPLOY.md, "spent only when a code is actually mailed").
-- check_edge_rate_limit counts and checks in one step, and the function used
-- to call it just before the send and keep the count whatever happened next:
-- a deploy with no mail key, or a Resend outage, used up a mailbox's three an
-- hour and the project's sixty without one email being sent.
--
-- The function now reserves with check_edge_rate_limit (so two requests at
-- once cannot both take the last slot) and calls this when nothing was
-- mailed. One use, never below zero, and only inside the bucket's current
-- window: a refund arriving after the window rolled over must not eat into
-- the next window's allowance.
--
-- Service role only, like check_edge_rate_limit: to anyone else it would be a
-- way to undo every limit built on these buckets.
create or replace function public.refund_edge_rate_limit (p_key text) returns void language plpgsql security definer
set search_path = public as $$
begin
    update public.edge_rate_buckets
    set count = count - 1
    where key = p_key
      and count > 0
      and reset_at > clock_timestamp();
end;
$$;

revoke all on function public.refund_edge_rate_limit (text) from public, anon, authenticated;
grant execute on function public.refund_edge_rate_limit (text) to service_role;
