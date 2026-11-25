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
ship: merge
hold:
  approver: maxharris1
  paths: ["src/**/*.tsx", "src/**/*.css", "src/ui/**", "src/assets/**", "public/**", "index.html"]
skills: []
qa:
  enabled: false
  gate: report
  visual_hold: true
  runners: [local-docker]
  local_docker:
    environment: qa-local
  profile: full-stack
  setup: bash scripts/qa/cloud-setup.sh
  lane:
    boot: npm run qa:boot
    doctor:
      - npm run qa:doctor
    recover: npm run qa:recover
    base_url: http://127.0.0.1:5173
---

## Review
One reviewer from a different model family than the builder gives the final verdict. `review.verify` is `none`. The `ui-check` skill stays available for UI changes. Low-risk changes get one round; leftover minors are batched into a follow-up issue. High-risk changes get up to three rounds; every extra round needs Max's own words.

## Ship
`ship: merge` with a UI hold (Max 2026-11-12 10:50 PM ET: "Yes, switch Cleffy back to ship: merge with the UI hold"; maxharris1/factory#86). On APPROVE of the covered head with green CI the factory merges into `dev`, except a PR whose diff touches a `hold.paths` glob or carries the `factory:hold` label: it waits in `orch:state/awaiting-ok` for maxharris1's `kind=ok head=<sha>` at the current head. `dev` → `main` is Max's merge. Never push to `dev` or `main` directly.

## QA
The QA lane runs on the `local-docker` runner using the scripts in `scripts/qa/` (`docs/qa-lane.md`). `qa-local` uses the runner's default Playwright image unless replaced with a prepared image name (containing `:` or `/`). `profile: full-stack` only labels the result comment's `env=` field: the factory starts no service for any profile; `npm run qa:boot` starts local Supabase, the Deno edge functions server, and Vite at `http://127.0.0.1:5173`. `gate: report` posts the result and never gates a ship. `visual_hold: true` holds a passing UI-changing PR with screenshots or video in `awaiting-ok` until an approver posts `/ok <sha>`. To turn QA on, add `projects[maxharris1/Cleffy].qa_storage` in `orch.local.yml`, then flip `qa.enabled` to `true`.

## Context
- Risky areas: migrations, RLS, Edge Functions under `supabase/`, and billing/Stripe. Never apply migrations or change config on a hosted Supabase project from an agent session.
- Privacy policy forbids tracking pixels. Never add analytics pixels or third-party trackers.
- Marketing surfaces (landing, demo, ads landing pages) use public-domain repertoire only. Never surface play-along, the fingering tool, AI-generated marks or the Founding offer. On the landing page the filled button is "Try it now" (the `/try` demo), in the hero and the closing band; "Start free" is the secondary action everywhere on that page (the outline button beside it, and the nav's button).
- PRs target `dev` (`dev.cleffy.io`, Supabase branch `qdbnlrgylelelvwbkvnm`). `main` is production (`cleffy.io`). The Supabase GitHub integration deploys migrations on merge to `main`.
- Branches: work on a GitHub issue goes on a `factory/issue-<n>` branch off the base branch (`dev`), where `<n>` is the issue number.
- UI changes: check them with the `ui-check` skill (`scripts/ui/uifuzz.mjs`, desktop, iPad and phone viewports). Backend changes: read `supabase-ops` first.
- Before pushing, run what CI's `checks` job runs: `npm run lint:check`, `npm run typecheck`, `npm run test` and `npm run build`. CI also runs `supabase-local`, `omr-service`, `supabase-drift` and `edge-functions-deno`.
