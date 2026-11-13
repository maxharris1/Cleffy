---
base_branch: dev
tickets: github
builder:
  harness: claude
reviewer:
  harness: codex
review:
  rounds:
    low: 1
    high: 3
  verify: none
ship: handoff
skills: []
---

## Review
One reviewer from a different model family than the builder gives the final verdict. `review.verify` is `none`. The `ui-check` skill stays available for UI changes. Low-risk changes get one round; leftover minors are batched into a follow-up issue. High-risk changes get up to three rounds; every extra round needs Max's own words.

## Ship
Temporary (Max 2026-11-12 8:28 PM ET: "switch Cleffy to wait for my OK on every merge until #86 lands"): `ship: handoff`. On APPROVE of the covered head with green CI, the factory marks the PR ready and stops; Max merges into `dev` or OKs the merge in his own words. Revert to `ship: merge` plus `hold.paths` for UI files once maxharris1/factory#86 lands. `dev` → `main` is Max's merge. Never push to `dev` or `main` directly.

## Context
- Risky areas: migrations, RLS, Edge Functions under `supabase/`, and billing/Stripe. Never apply migrations or change config on a hosted Supabase project from an agent session.
- Privacy policy forbids tracking pixels. Never add analytics pixels or third-party trackers.
- Marketing surfaces (landing, demo, ads landing pages) use public-domain repertoire only. Never surface play-along, the fingering tool, AI-generated marks or the Founding offer. The primary CTA is always "Start free".
- PRs target `dev` (`dev.cleffy.io`, Supabase branch `qdbnlrgylelelvwbkvnm`). `main` is production (`cleffy.io`). The Supabase GitHub integration deploys migrations on merge to `main`.
- UI changes: check them with the `ui-check` skill (`scripts/ui/uifuzz.mjs`, desktop, iPad and phone viewports). Backend changes: read `supabase-ops` first.
- Before pushing, run what CI's `checks` job runs: `npm run lint:check`, `npm run typecheck`, `npm run test` and `npm run build`. CI also runs `supabase-local`, `omr-service`, `supabase-drift` and `edge-functions-deno`.
