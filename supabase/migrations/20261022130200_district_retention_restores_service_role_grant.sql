-- launchfix P5 rebase onto #69: district_retention_restores
-- (20261022130000) names service_role in a grant of its own, like every
-- public table since 20261022100000_explicit_service_role_grants.sql
-- (launch re-audit BL-3; tests/security/explicitServiceRoleGrants.test.ts).
--
-- 20261022130000 already grants it where it creates the table; this repeats
-- that grant in the rebase pass's own migration, as 20261022120300 did for
-- launchfix P4's table. No change on any project: the service role keeps the
-- access it has, and anon and authenticated stay revoked.

grant all on table public.district_retention_restores to service_role;
