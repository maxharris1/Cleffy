-- launchfix P4 rebase onto #69: document_realtime_rotation_queue
-- (20261022120000) names service_role in a grant of its own, like every
-- public table since 20261022100000_explicit_service_role_grants.sql
-- (launch re-audit BL-3; tests/security/explicitServiceRoleGrants.test.ts).
--
-- No change on a project built with today's default ACL, which already gives
-- service_role everything on a table `postgres` creates in `public`; on one
-- built after Supabase's announced change to default grants, the service role
-- keeps the access it has today. anon and authenticated stay revoked.

grant all on table public.document_realtime_rotation_queue to service_role;
