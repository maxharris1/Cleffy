# Launch-compliance merge into dev: progress report

Merging PRs #63, #62, #61 and #64 into `dev`, in that order, as merge commits.
Max authorized this on 2026-10-21. This report is updated after each merge.

- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (confirmed with
  `get_session` at the start; type `anthropic_cloud`, not Sandbox).
- `dev` at the start: `282b30ab956a2f6d2dc04d9e1aa7c6477a894ec9`.
- All four PR heads matched their reviewed SHAs on both `origin` and GitHub at the start.

## 1. #63 `mh/launch-legal-pages`: merged

- Reviewed SHA: `c12b0230be6c9b2b14bb8ae8dcd3681e17f0a78a`. It was still the head on
  origin and on GitHub right before the merge.
- Conflict resolution: none. The PR was cut from `dev` at `282b30a` and `dev` had not
  moved, so GitHub reported it `clean`. Nothing was pushed to the PR branch.
- Local checks on `c12b023`: `lint:check` ✅, `typecheck` ✅, `test` ✅ (199 files
  passed, 1 skipped; 2893 tests passed, 2 skipped), `build` ✅.
- CI on `c12b023` (push and pull_request runs): `checks` ✅, `supabase-drift` ✅,
  `omr-service` ✅, Vercel Preview Comments ✅, Supabase Preview skipped. supabase-local
  doesn't exist yet; it arrives with #62. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` at 2026-10-21 23:42:37Z.
- **Merge commit on dev: `9b106e0ccaf9b0e407baab4c04b066ec77a248e5`**, with parents
  `282b30a` (dev) and `c12b023` (the reviewed head). GitHub shows #63 merged into `dev`.

## 2. #62 `mh/launch-checkout`: merged

- Reviewed SHA: `553f5d2544f85bee52034f38859ea762fb9b7a5e`. It was still the head on
  origin and on GitHub before I touched the branch.
- It conflicted with dev after #63, so I merged `origin/dev` (`9b106e0`) into the branch:
  - **Conflict-resolution merge commit `438ad800fd1d07b351db7e15dd25bbff94573efb`**, with
    parents `553f5d2` (the reviewed head, first parent) and `9b106e0`. Authored by Max
    Harris. It went to `mh/launch-checkout` as a fast-forward push.
  - Conflicted files and how I resolved them:
    - `scripts/apply-migrations.sql`: regenerated with `npm run migrations:mirror` (77
      files, 75 mirrored). The output is the same whichever side is checked out first.
    - `tests/migrationRecoverability.test.ts`: the job map is now the union of
      billing-mail-outbox, content-notice-retry, imslp-sync and omr-sweep. #62's static
      replay blocks (160300–160700) are kept.
    - `src/app/routes.tsx`, `supabase/config.toml`, `SETUP_SUPABASE.md`: both sides only
      added entries, so I kept both (`/cancel`, `/refunds`, `/copyright`, `/report`; the
      billing-cancel, billing-mail-outbox, content-report, content-moderation and
      content-notices function blocks; both outbox runbook paragraphs).
      `SETUP_SUPABASE.md` was already not Prettier-formatted on dev, on #62 and at the
      base, so I left its formatting alone.
  - Shared files after the merge are byte-identical to #62's: `_shared/mailBudget.ts`,
    `_shared/resendDelivery.ts`, `_shared/legalVersions.ts`,
    `tests/security/mailBudget.test.ts`, `tests/security/resendDelivery.test.ts`.
- Local checks on `438ad80`: `lint:check` ✅, `typecheck` ✅, `test` ✅ (203 files
  passed, 2 skipped; 3067 tests passed, 10 skipped), `build` ✅.
- CI on `438ad80` (push and pull_request runs): `checks` ✅, **`supabase-local` ✅**,
  `supabase-drift` ✅, `omr-service` ✅, Vercel Preview Comments ✅, Supabase Preview
  skipped. No flake re-runs were needed.
- Marked ready for review, then merged with `merge_method=merge` at 2026-10-21 23:51:38Z.
- **Merge commit on dev: `225bd64afb5a61502f3308c5018b1df0cceab7cd`**, with parents
  `9b106e0` (dev) and `438ad80`. GitHub shows #62 merged into `dev`.
