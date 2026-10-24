-- District retention: a renewal lifts the provisioning barrier at once
-- (decision 68(3)'s follow-up).
--
-- The barrier (20261022130300, decision 67(a)) holds from a district's soft
-- delete until its cycle is cancelled. A renewal (the contract end moved, or
-- cleared) is what cancels it, but only when the next daily run reaches the
-- district and deletes its district_retention row: until then the renewed
-- district still refused every provision with district_deletion_pending.
-- Decision 68(3) accepted the wait for launch; this removes it.
--
-- district_deletion_pending() now answers no for a soft-deleted cycle whose
-- billing record no longer names the contract end the cycle began for: the
-- same condition under which retention_district_next_step() answers
-- 'cancel', so the barrier and the run agree on what a renewal is. A hard
-- deleted district stays closed for good, and so does a soft-deleted one
-- whose billing record is gone (the studio deleted another way: its cycle is
-- the cancel's, and nobody can provision into a missing district anyway).
--
-- Nothing the purge decides changes:
--   * until the run's cancel, the district's listed students stay archived,
--     and the cancel un-archives them as before;
--   * a student provisioned between the renewal and the cancel is not on the
--     list, so the cancel leaves them alone;
--   * the sweep and the hard delete already pass a district whose next step
--     is its cancel over, so nobody provisioned meanwhile is listed;
--   * a renewal undone before the run (the contract end set back) closes the
--     barrier again, and the next run's sweep lists whoever was provisioned
--     meanwhile, exactly as for a student attributed late (20261022130300).
--
-- The lock is unchanged: a provision takes the district's billing row FOR KEY
-- SHARE before reading its state; the billing writers (district_billing_
-- rederive(), admin_set_district_contract_end()) take FOR NO KEY UPDATE,
-- which does not conflict with it, so a provision racing the renewal reads
-- either side of it and a refused one succeeds on retry.
--
-- Rerunnable: the function is replaced with the same signature and its
-- privileges reset to the same end state.

-- 20261022130300's definition, plus the renewal.
create or replace function public.district_deletion_pending (p_studio uuid) returns boolean
language sql stable security definer
set search_path = public as $$
    select exists (
        select 1 from public.district_retention r
        where r.studio_id = p_studio
          and (
              r.hard_deleted_at is not null
              or (
                  r.soft_deleted_at is not null
                  -- Renewed: the billing record names another contract end
                  -- (or none) than the one this cycle began for. The run's
                  -- next step for it is its cancel.
                  and not exists (
                      select 1 from public.district_billing b
                      where b.studio_id = r.studio_id
                        and b.contract_ends_at is distinct from r.contract_ends_at
                  )
              )
          )
    );
$$;

revoke all on function public.district_deletion_pending (uuid) from public, anon, authenticated;

grant execute on function public.district_deletion_pending (uuid) to service_role;

-- DEPLOY: after 20261022130300; no edge function changes (student-provision
-- already asks district_provision_refusal(), which asks this).
