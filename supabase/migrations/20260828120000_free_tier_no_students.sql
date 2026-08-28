-- Free becomes a taste of Personal, not a taste of Teacher.
--
-- Free previously carried students = 3, which made it a miniature teaching
-- plan: a studio could run three students indefinitely without ever reaching
-- the tier that sells the roster. Personal is the individual licence, and Free
-- is the sample of it, so the roster now starts at Teacher.
--
-- Only the 'free' branch changes; every other tier is reproduced exactly as
-- 20260826193902_billing.sql defined it, because create-or-replace rewrites the
-- whole body. tier_limits() stays the single source of truth for the numbers,
-- and the TS mirror in src/features/billing/entitlementsService.ts (FREE_LIMITS)
-- moves with it.
--
-- Existing rows are untouched: a free account that already provisioned students
-- keeps them, and those students keep signing in. What changes is that the
-- account can no longer add more (student-provision returns 402) and the client
-- hides the roster, since limits.students = 0 now reads as "no roster on this
-- plan". Check for such accounts before deploying:
--
--   select ms.teacher_id, count(*)
--   from public.managed_students ms
--   left join public.subscriptions s
--     on s.user_id = ms.teacher_id and s.status = 'active'
--   where s.tier is null
--   group by 1;
create or replace function public.tier_limits (p_tier text) returns jsonb language sql immutable
set search_path = public as $$
    select case p_tier
        -- students = 0 is what makes Personal a solo plan: no roster, no seats.
        when 'personal' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', 0
        )
        when 'teacher' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        when 'academy' then jsonb_build_object(
            'cloud_scores', -1, 'omr_runs', -1, 'vision_reads', 500, 'smart_imports', -1, 'pdf_exports', -1, 'students', -1
        )
        -- Not purchasable: a provisioned student account. It creates nothing of
        -- its own -- every score it can reach is one a teacher assigned -- and it
        -- is never export-gated, because there is nobody to sell an upgrade to.
        when 'student' then jsonb_build_object(
            'cloud_scores', 0, 'omr_runs', 0, 'vision_reads', 0, 'smart_imports', 0, 'pdf_exports', -1, 'students', 0
        )
        -- Free: the whole practice tool in small amounts, for one player.
        else jsonb_build_object(
            'cloud_scores', 3, 'omr_runs', 3, 'vision_reads', 5, 'smart_imports', 2, 'pdf_exports', 1, 'students', 0
        )
    end;
$$;
