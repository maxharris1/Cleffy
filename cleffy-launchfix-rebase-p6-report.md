# Cleffy launchfix rebase P6 report: PR #67 (go-live docs) onto dev

**Status:** Complete

- Repo: maxharris1/Cleffy, PR #67 (draft, base `dev`; title, body, draft state and base untouched)
- Branch: `mh/launchfix-p6-golive-docs`
- Starting head: `7ae2ee5694f720f71738449f9983ef803e9bf8e9` (confirmed after `git fetch`; equal to `origin/mh/launchfix-p6-golive-docs`)
- Rebased onto `origin/dev`: `d387b69f8de13dd468aaa2b6242b4c66685f95ae` (exactly the expected #66 merge; no newer dev commit)
- New PR #67 head: `bc070bd407bc7e96109f28830ed3263ae78f154c`
- Environment: Cleffy cloud environment `env_01WAd3yiz3qpSnsofpyEwCh2` (`environment_kind: anthropic_cloud`, from `get_session`), not Sandbox.
- Date: 2026-10-22

## 1. Pushes

| #   | Command                                                                                                                                    | Result                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1   | `git push --force-with-lease=mh/launchfix-p6-golive-docs:7ae2ee5694f720f71738449f9983ef803e9bf8e9 origin HEAD:mh/launchfix-p6-golive-docs` | **Lease held**: `+ 7ae2ee5...b98597a (forced update)`. The only non-fast-forward push. |
| 2   | `git push origin HEAD:mh/launchfix-p6-golive-docs`                                                                                         | Fast-forward: `b98597a..bc070bd`.                                                      |
| 3   | report branch `claude/launchfix-rebase-p6-report` (new branch from `bc070bd` plus one report commit)                                       | new branch, no force                                                                   |

Every commit (the five rebased ones and the new one) has author and committer `Max Harris <drumaxter@gmail.com>`.

## 2. Rebase and conflicts

`git rebase origin/dev` replayed all five commits with **no conflicts**. dev's only change to the three docs since the old merge-base `47e9b38f` was `c15cdd9` (Turnstile CSP smoke line in DEPLOY.md's release checklist, step 12). It is kept (`CSP_SMOKE_TURNSTILE=1`, DEPLOY.md:2955). No file outside `.env.example`, `DEPLOY.md` and `SETUP_SUPABASE.md` differs from dev: `git diff --stat origin/dev bc070bd` shows exactly those three.

### Range-diff (`git range-diff origin/dev 7ae2ee5694f720f71738449f9983ef803e9bf8e9 bc070bd`)

```
1:  472747b = 1:  855d04f docs(deploy): go-live runbook for a fresh production, webhook events, refunds, PITR, STRIPE_MODES
2:  4ca5287 = 2:  53c73fc docs(deploy): name P5's district retention migrations in the go-live runbook
3:  7bb274d = 3:  88b9fcd docs(deploy): gated manual go-live, traffic freeze, backup, retention pauses
4:  beb5c00 = 4:  4ab28e8 docs(deploy): no data restore, session drain, paginated Stripe replay, P5 pepper
5:  7ae2ee5 = 5:  b98597a docs(deploy): fail-closed Stripe lists, ban-state-preserving freeze, r3 gates
-:  ------- > 6:  bc070bd docs(deploy): P1-P5 names settled on dev d387b69f; storage UPDATE preflight, P3/P4/P5 deploy order, recovery runbooks
```

The five rebased commits are identical (`=`) to the old series. The only change versus 7ae2ee56 is the new commit 6.

## 3. Commits added

| SHA                                        | Summary                                                                                                               | Files                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `bc070bd407bc7e96109f28830ed3263ae78f154c` | docs(deploy): P1-P5 names settled on dev d387b69f; storage UPDATE preflight, P3/P4/P5 deploy order, recovery runbooks | `DEPLOY.md` (+351/-80 at commit time) |

(The rebased commits are `855d04f`, `53c73fc`, `88b9fcd`, `4ab28e8`, `b98597a`: content unchanged.)

## 4. Required additions (c) to (h), with final DEPLOY.md lines at `bc070bd`

All placed in the existing go-live order (steps 4, 8, 11, 12, 14, 16, 18, 20, and the reference subsections after _Abort and recovery_). No step was renumbered, moved or removed. One new reference subsection was added among the existing ones (_Recovery runbooks_), between _Before scheduling `retention-district`_ and _Stripe webhook events_.

**(c) Storage UPDATE preflight.** Existing TRIGGER preflight updated in place, with the UPDATE check next to it.

- Step 4, DEPLOY.md:459–483: "`select has_table_privilege('postgres', 'storage.objects', 'UPDATE') as can_lock_storage_objects;` -- must be t: 20261022101000 uses SELECT ... FOR UPDATE in the quota function" (line 476). "If either is `f`, **stop**: the sitting does not start."
- Step 8 re-check before the wipe, DEPLOY.md:1017–1020: "run step 4's two `storage.objects` privilege checks once more (`TRIGGER` and `UPDATE`): both must still be `t`."
- Step 11 before batch 1, DEPLOY.md:1213–1224: both `has_table_privilege` queries, "If either is `f`, stop before applying any migration".
- The preflight also now names the three further `storage.objects` triggers that `20261022100900` / `20261022101000` add.

**(d) P3 deploy order (110700/110800, student-provision first).**

- Step 11.3 migration check (updated in place from the old three-row P3 check), DEPLOY.md:1308–1346: now 17 rows, P3's nine (incl. `20261022110700 student_code_reset_worker`, `20261022110800 student_code_reset_quarantine`), P4's four, P5's four. "Fewer than 17 rows … **Do not deploy any function**".
- DEPLOY.md:1348–1367, Codex r4's text fitted to the freeze: "**P3's code reset: `20261022110700` / `20261022110800` and the `student-provision` deploy go back to back, inside the freeze** (decision 64) … Keep the interval between this batch and deploying `student-provision` minimal. Keep the freeze in place, finish the mandatory migration check above and the retention pause, then deploy `student-provision` **first** in step 12, before the remaining functions."
- Step 12, DEPLOY.md:1384–1402: `supabase functions deploy student-provision --project-ref jibgwgosihadbjgxdsfe   # first` (line 1391), then all 23; "If the `student-provision` deploy fails, do not end the freeze: retry the deploy."

**(e) P3 fix-round runbook entries.**

- Deploy-order entry: as (d) above (DEPLOY.md:1348–1367, 1384–1402). Steps 1 and 6 of the P3 text map to this runbook's freeze (step 6 starts it, step 20 ends it), and the P3 smoke check ("reset one test code student") became part of step 18's roster smoke test, DEPLOY.md:1867–1871: "reset their code from the roster once: a new card appears, with no "The reset did not finish…" message". Production holds no students between the wipe and step 17, so the step 18 reset is the first place a reset can be run.
- `supabase/functions/deno.json` note, step 12, DEPLOY.md:1408–1418: "`{ "nodeModulesDir": "none", "lock": false }` … Deno finds its config from the working directory, not from the entry file, so CI's `edge-functions-deno` job passes it explicitly". Step 1's CI list now includes `edge-functions-deno` (DEPLOY.md:151).
- New subsection _Recovery runbooks: provisioning, deletion, inbound mail (P3)_, DEPLOY.md:2159–2267:
  - decision 64 marker note, DEPLOY.md:2164–2169: "**The `code_reset_worker` marker stays.** … Under decision 64 it is left there … Clearing stale markers is a follow-up, not a launch step. Do not clear it by hand."
  - orphaned provisioning accounts (fix round 2's full entry, replacing fix round 1's short one), DEPLOY.md:2171–2232;
  - half-deleted accounts, DEPLOY.md:2234–2252;
  - inbound mail marked `failed`, DEPLOY.md:2254–2268.
- Step 20's watch list points to them, DEPLOY.md:1983–1985.

**(f) P5 deploy order (decisions 67–69).**

- Step 11.3, DEPLOY.md:1369–1382: "**P5's district barrier comes first too** … Every P5 migration (`20261022130000`, `130100`, `130300` and `130400`) is in this batch, inside the freeze, before step 12 deploys `student-provision` (decision 68(4))", then the two expected refusals: "SQLSTATE `55P03` and the message `district_busy` … Make roster corrections through `public.admin_set_student_district()`, which waits its turn, or retry" and "`admin_set_student_district()` can refuse a correction that raced another one with SQLSTATE `40001`. Retry it."
- Step 11.3, DEPLOY.md:1304–1306: "`retention-district` is not scheduled by any migration, and stays unscheduled: `retention_district_run()` does not run until Max has reviewed its dry-run counts".
- _Before scheduling `retention-district`_ updated in place, DEPLOY.md:2102–2157: item 1 now lists all four P5 migrations (130300's barrier and late-student sweep, 130400's lock order with 55P03/40001); item 3 "**Max has reviewed the dry-run counts**"; the accepted behaviours from decisions 68 and 69 (DEPLOY.md:2146–2153) and the follow-ups (DEPLOY.md:2155–2157).
- `20261022130200`: DEPLOY.md:76–78 ("There is no `20261022130200`: P5 dropped it before the merge. Never apply or repair a version of that name."), 1346 and 2108–2109. No line tells anyone to apply it.

**(g) Production `content_strike_pepper`.** Existing step 14 entry updated in place, DEPLOY.md:1598–1601: "**Production must have its own real `content_strike_pepper` before launch**: nothing opens (step 20) until it exists and step 18's struck-account deletion has passed. The local and CI value is never copied to a hosted project." Step 20 gate, DEPLOY.md:1957–1959. Only the name appears; the existing command generates the value inside the database (`gen_random_bytes`), so no value or value-like placeholder is written anywhere. (The packet labels (g) "P1"; the pepper's migration is P5's `20261022130100_content_strikes_survive_deletion`, and the doc keeps calling it P5.)

**(h) P4 migrations with the frontend deploy.** Step 16, DEPLOY.md:1662–1675: "**P4's migrations `20261022120200_realtime_archive_recovery` and `20261022120300_realtime_rotation_queue_service_role_grant` go with this frontend deploy.** They were applied in step 11's batch 3, inside the freeze, and step 11.3's check showed both recorded remotely … Never deploy this frontend without them." With why: the new bundle calls `realtime_topic_access()` (created by 120200; `src/sync/realtimeChannel.ts:276`).

**Already present at 7ae2ee56 and updated in place, not duplicated:** the TRIGGER preflight (steps 4, 8, 11) for (c); the P3 "recorded remotely" check in step 11.3 for (d); the pepper in step 14 and the step 20 gate for (g); _Before scheduling `retention-district`_ for (f).

## 5. Other doc fixes to match dev (same commit)

- Counts, DEPLOY.md:70–89: 124 migrations at d387b69f (P1 11, P3 9, P4 4, P5 4), step 11's batch 3 is **34** (was 111 / 21 from the P1–P5 branch heads); 12 cron jobs. Batch 3 text, DEPLOY.md:1275–1280. Superseded-checklist note ("pushes the rest (98 at `d387b69f`)").
- Every "(confirm after P<N>)" marker resolved after checking the name on dev (section 6). The intro paragraph (DEPLOY.md:115–119) now says the names were checked against d387b69f and must be re-checked if `GOLIVE_SHA` is later.
- Grants check (step 13.3): added P3's `account_deletion_attempts` and `student_provision_intents` to `server_only` (both revoke all from anon and authenticated on dev). The claim about the earlier local run was reworded so it no longer says it ran on all migrations (it ran on 111, at the earlier branch heads); same for step 21's counts.
- Step 9 footnote: the Edge-secret table was re-checked against every `Deno.env.get` / `env('…')` name on dev.

## 6. Names checked against dev `d387b69f`

**Migrations** (every `2026…_name` the three docs cite exists as `supabase/migrations/<name>.sql`): all P1–P5 files `20261022100000_explicit_service_role_grants` … `20261022101000_storage_quota_lock_and_cover_reuse`; `20261022110000_student_claim_reservation`, `110100_account_deletion_pending`, `110200_support_inbound_lease`, `110300_support_inbound_retry_window`, `110400_account_deletion_attempts`, `110500_student_code_reset_holder`, `110600_account_deletion_barrier`, `110700_student_code_reset_worker`, `110800_student_code_reset_quarantine`; `20261022120000_realtime_revocation_rotation`, `120100_realtime_revocation_races`, `120200_realtime_archive_recovery`, `120300_realtime_rotation_queue_service_role_grant`; `20261022130000_district_retention_reattribution`, `130100_content_strikes_survive_deletion`, `130300_district_retention_late_students`, `130400_district_retention_moveout_locks`. Also every older one cited (`20260829130000_support_messages`, `20260902120000_imslp_category_index`, `20261021120300_retention_jobs`, `20261021120700`, `20261021120900`, the `20261007*`–`20261011*` release-checklist files, etc.). `20261022130200` does not exist on dev (checked). Five versions the docs cite do not exist on dev **by design**, all in pre-existing text (R2 / old checklist, not P6's go-live steps): `20260916140000_playalong_corpus`, `20260918042925_tmp_ledger_cleanup`, `20260921141103`…`141127`, `20260924120000` (remote-only history / PR #52).

Totals: 124 migrations; `main` has 26 (`git ls-tree origin/main`).

**SQL functions** (defined in `supabase/migrations` on dev): `complete_student_code_reset` (5-arg, 110700; 3-arg dropped at 110700:64), `end_student_sessions_fenced` (110800:132), `stop_student_code_reset_worker` (110700), `finish_student_provision` and `student_provision_intents_for` (110600), `district_provisionable` and `district_provision_refusal` (130300), `admin_set_student_district` (130400 latest), `retention_district_run` / `retention_district_dry_run` (120700, later 130000/130300/130400), `retention_purge_content_strikes`, `content_strike_pepper`, `content_strike_subject_key`, `active_content_strikes` (130100), `entitling_billing_modes` and the `deployment_config` upsert (100200), `realtime_topic_access` (120200) and `realtime_topic_epoch` (120100), `storage_objects_enforce_quota`, `storage_objects_charge_insert` (100800/101000), `hook_before_user_created` (20261021120000), `is_content_moderator` (20261020150000), `peek_share_link` (20261009120200), `admin_set_studio_seat_override` (20261020180400), `reconcile_district_seats`, `support_inbound_retry_tick` (110200/110300), `imslp_sync_tick`, `retention_guest_last_active` (20261021120500).

**SQLSTATEs / codes:** `55P03` + `district_busy` (130400:133–134), `40001` (130400:189), `district_deletion_pending` 409 (130300; `supabase/functions/_shared/districtProvision.ts`).

**Tables / columns:** `student_provision_intents` (roster_id, teacher_id, auth_email, student_user_id, created_at, expires_at; 110600:151), `account_deletions` (user_id, started_at, updated_at, attempts, last_error; 110100) + `destructive_started_at` (110400:35), `account_deletion_attempts` (user_id, lease_until, ended_at; 110400:37), `support_messages` status `failed` (110300:30), `first_send_attempt_at` (110300:25), `completed_at` (110200:47), `forward_error`, `resend_email_id`, `from_address`, `subject`, `attempts`; all nine P1–P5 tables in the grants check (`deployment_config`, `studio_supersede_log`, `student_claim_reservations`, `account_deletions`, `account_deletion_attempts`, `student_provision_intents`, `document_realtime_rotation_queue`, `district_retention_restores`, `thumbnail_storage_cleanup`). `app_metadata` keys `user_type` / `teacher_id` (`student-provision/index.ts:465,591`) and `code_reset_worker` (`_shared/studentCodeReset.ts:40`).

**Storage triggers:** `storage_objects_enforce_quota`, `thumbnails_record_superseded` (100800:209,287), `thumbnails_enforce_folder_cap` (100900:248), `storage_objects_charge_insert`, `thumbnails_keep_published_cover` (101000:226,270); `FOR UPDATE` on `storage.objects` at 101000:112–115, 140–143.

**Cron jobs** (`git grep cron.schedule` on dev): 12, `omr-sweep`, `imslp-sync`, `content-notice-retry`, `billing-mail-outbox`, `district-seat-reconcile`, `retention-archived-students`, `retention-stale-guests`, `retention-rate-limits`, `retention-support-messages`, `retention-compact-tombstones` (20261021120300), `support-inbound-retry` (110200:353), `retention-content-strikes` (130100:270). Each scheduled once. `retention-district` only in a comment (20261021120700:551). No hourly district notice-sender cron on dev (doc says so).

**Edge Functions:** 23 directories under `supabase/functions/` (plus `_shared` and the file `deno.json`). The `verify_jwt` split in step 13.5 (10 false / 13 true) matches `supabase/config.toml`. `student-provision`, `student-claim`, `stripe-checkout`, `imslp-download`, `score-analyze`, `resend-inbound`, `delete-account`, `district-retention-notices` all exist.

**Edge secrets / env:** every name in step 9's table is read in `supabase/functions` on dev (ANTHROPIC_API_KEY, ANALYZE_NOTES_MODEL, APP_URL, BILLING__, CONTENT__, DISTRICT_NOTICE__, GUEST_EMAIL__, IMSLP__, LOGIN_THROTTLE_SECRET, MAIL_BUDGET_PER_HOUR/DAY, OMR__, RESEND_API_KEY, RESEND_WEBHOOK_SECRET, SENTRY__, STRIPE__ incl. `_TEST`/`_LIVE`/legacy aliases/`STRIPE_PRICE_*`/`STRIPE_PRICE_LIVE_*`/`STRIPE_MODES`/origins, SUPPORT_FORWARD_TO/FROM, SUPPORT_RETRY_SECRET, TURNSTILE_SECRET_KEY), and no function reads an env name the doc leaves out. Mail budget figures (`AUTH_MAIL_RESERVE` 40/200, `LAUNCH_MAIL_SPLIT` 60/300 incl. `studentAccountMail`) match `_shared/mailBudget.ts`. `VITE_STRIPE_PUBLISHABLE_KEY` is read nowhere in `src` (matches `.env.example`/SETUP_SUPABASE.md).

**Vault secrets** (names only): `imslp_sync_*`, `billing_outbox_*`, `content_notice_*`, `district_notice_*`, `support_inbound_url` / `support_inbound_secret` (110200), `omr_service_*`, `content_strike_pepper` (130100; local value in `supabase/seed.sql:164`).

**Scripts / CI:** `npm run migrations:mirror` (`scripts/build-apply-migrations.mjs`), `scripts/csp-smoke.mjs`, `scripts/stripe/configure-tax.mjs`; CI jobs `checks`, `supabase-local`, `omr-service`, `supabase-drift`, `edge-functions-deno` (`.github/workflows/ci.yml`), the last running `deno check --config supabase/functions/deno.json supabase/functions/*/index.ts`. `supabase/functions/deno.json` = `{"nodeModulesDir": "none", "lock": false}`.

## 7. migrations:mirror

Ran `npm run migrations:mirror`: no change (`git status` showed only my DEPLOY.md edit). Nothing generated was committed.

## 8. Local checks (on `bc070bd`'s tree, before its push; the same also passed on `b98597a` before the lease push)

- `npm run lint:check`: exit 0. `npm run lint` (eslint --fix): exit 0, changed nothing.
- `npm run typecheck`: exit 0.
- `npm test` (vitest, incl. `tests/applyMigrationsInSync.test.ts`, `tests/migrationRecoverability.test.ts` and the other tests that read the docs): **242 files passed, 6 skipped; 3769 tests passed, 20 skipped**.
- `npm run build`: exit 0.
- `npx prettier --check DEPLOY.md SETUP_SUPABASE.md`: clean. `.env.example` has no Prettier parser (`--ignore-unknown`: clean; it is unchanged by this pass anyway).
- No local Supabase stack was started.

## 9. CI on the final head `bc070bd`

**All green, both runs complete.** Workflow `CI` on `bc070bd407bc7e96109f28830ed3263ae78f154c`:

| Check                 | pull_request run 39829191224 | push run 39829182542       |
| --------------------- | ---------------------------- | -------------------------- |
| `checks`              | success (job 120000486006)   | success (job 120000456493) |
| `supabase-local`      | success (job 120000486379)   | success (job 120000456532) |
| `omr-service`         | success (job 120000486278)   | success (job 120000456207) |
| `supabase-drift`      | success (job 120000486357)   | success (job 120000456291) |
| `edge-functions-deno` | success (job 120000486331)   | success (job 120000455958) |

- Vercel commit status: **success**, "Deployment has completed" (not rate limited this time). Vercel Preview Comments check run 120000765746: success.
- Supabase Preview check run 120000447101: skipped (as on 7ae2ee56).

On the intermediate rebase head `b98597a` (runs 39828029779 pull_request / 39828023751 push), `supabase-drift` failed in both runs with `check-supabase-drift: /v1/projects/jibgwgosihadbjgxdsfe/database/query: HTTP 502` (Supabase "502: Bad gateway"), a Management API outage, not the docs; every other job passed. I did not re-run it; it passed on its own on `bc070bd` minutes later.

## 10. Follow-ups (not done here, by instruction)

- Clearing stale `code_reset_worker` markers (decision 64(1)).
- Hard delete detaching restored students (clearing `district_studio_id`) (decision 68(2)); lifting the district barrier at once on a renewal (68(3)).
- Hourly district notice-sender cron (decision 11; not on dev).
- Scheduled sweep for orphaned provisioning cases 1–3 (decision 49(6)).
- P3 follow-up 7 live HTTP smoke tests (reset with an Auth timeout, `app_metadata.code_reset_worker` confirmation against hosted GoTrue, 503 `deletion_check_unavailable` / 409 path, function boot with `deno.json`, fix-round-2 items) are not written into DEPLOY.md by this pass; packet (e) did not list them. Worth adding to step 18 in a later round.
- Re-run step 13.3's grants check and step 21's counts on a local stack with all 124 migrations (they last ran at 111).

## 11. Open questions

1. **PR #67's body is stale** (it still says 111 migrations, the three-row P3 check, and the "confirm after" list). I was told not to edit it. Max or Cleffy should update it.
2. The packet labels (g) as "P1"; the pepper belongs to P5's `20261022130100`. The doc keeps "P5". Confirm that is the intent.
3. (d) is satisfied by ordering inside one batch 3 push (110700/110800 and 130000–130400 are in it; then the 17-row check; then `student-provision` first). I did not split batch 3 so that 110700/110800 are pushed separately right before the deploy: on a wiped production with no students the gap is harmless, and splitting would restructure step 11. If Max wants a separate sub-batch, that is a later round.

## 12. Hosted steps left for Max (none performed)

Everything in the go-live runbook, in particular: the step 4/8/11 `TRIGGER` and `UPDATE` preflights on production; batch 3 and the 17-row check; deploying `student-provision` first in step 12; creating production's own `content_strike_pepper` in Vault (step 14); confirming P4's migrations are recorded before the #54 merge (step 16); reviewing `retention_district_dry_run()` before ever scheduling `retention-district`. No hosted Supabase, Vercel, Stripe or other hosted service was touched by this session, and no secret value was printed or written.

## 13. Couldn't do

Nothing in scope was left undone, apart from the items under Open questions. No messages were sent to any session or agent; no Codex review was requested.
