-- District retention notices: deferred, not failed, when the mail budget is spent.
--
-- Codex round-2 review of #64, new major 2 (and the cross-PR mail ceiling):
-- district-retention-notices sent straight through Resend, outside the shared
-- mail budget. It now reserves the `retentionNotice` share of LAUNCH_MAIL_SPLIT
-- (_shared/mailBudget.ts) before each send. A notice the budget holds back is
-- handed back to the outbox (district_retention_notices) with this function:
-- its claim released and the attempt the claim counted taken back, because no
-- send was tried. It stays unsent, so the purge keeps waiting for it, and the
-- next wake of the sender claims it again.

create or replace function public.defer_district_retention_notice (p_id bigint) returns void language plpgsql
security definer
set search_path = public as $$
begin
    update public.district_retention_notices
    set lease_until = null,
        attempts = greatest(attempts - 1, 0),
        last_error = 'deferred: the retention notice mail budget is spent'
    where id = p_id and sent_at is null;
end;
$$;

revoke all on function public.defer_district_retention_notice (bigint) from public, anon, authenticated;

grant execute on function public.defer_district_retention_notice (bigint) to service_role;
