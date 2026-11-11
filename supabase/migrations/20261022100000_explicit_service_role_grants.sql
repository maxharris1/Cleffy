-- Explicit service_role grants on the fifteen public tables that never had one
-- (launch re-audit BL-3).
--
-- Every other public table names service_role in a grant of its own (the core
-- tables since 20260827140000_core_table_grants.sql). These fifteen only ever
-- revoked from the client roles and relied on the default ACL for objects
-- `postgres` creates in `public`, which today gives service_role arwdDxtm. That
-- default is the platform's to change -- Supabase's announced change to default
-- grants for new tables (dated 2026-10-30, not verified here) is exactly such a
-- change -- and a fresh replay onto a project built after it would leave the
-- service role with `42501 permission denied` on tables the Edge Functions
-- write directly: billing_customers (stripe-checkout, the webhook),
-- content_reports, content_notice_outbox and content_moderators (the
-- content-report and content-moderation functions). The rest are read or
-- written by SECURITY DEFINER functions, by the service role's admin SQL and
-- by tests/sql proofs acting as it.
--
-- The client roles are left exactly as they are: no grant or revoke here names
-- anon or authenticated, so the column grants on studios (insert (id,
-- owner_id, name), update (name)) and practice_notes (update (body, shared,
-- noted_on)), and every revoke, stand.
--
-- `all`, as 20260827140000 grants the core tables: service_role bypasses RLS,
-- and this is the table-level gate only. Rerunnable: granting a privilege that
-- is already held is a no-op.

grant all on table public.billing_customers,
               public.studios,
               public.studio_members,
               public.usage_counters,
               public.assignments,
               public.practice_notes,
               public.edge_rate_buckets,
               public.pdf_export_claims,
               public.content_moderators,
               public.content_reports,
               public.content_takedowns,
               public.content_strikes,
               public.content_notice_log,
               public.content_notice_outbox,
               public.document_realtime_epochs
    to service_role;
