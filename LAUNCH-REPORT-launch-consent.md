# Launch report: Session A (`mh/launch-consent`, items 1-10)

- **PR:** https://github.com/maxharris1/Cleffy/pull/64 (draft, `mh/launch-consent` → `dev`, no reviewers requested)
- **Head SHA:** `d342b2ff35469fea8d1408f0899dd69515c95965`
- **Base:** `dev` at `282b30a`
- **Screenshots:** `docs/screenshots/launch-consent/` on `claude/launch-consent-6sji39` (not for merge), embedded in the PR description

## What was done, by item

| #             | Item                                                                    | Commit               | Status                                                           |
| ------------- | ----------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| 1             | Consent-age table                                                       | `65d3b4a`            | Done                                                             |
| 2             | Age screen on /register and /join, and the Auth hook                    | `c1804ad`            | Done; Max switches the hook on hosted                            |
| 3             | Teacher attestation and student country                                 | `5d5be22`            | Done                                                             |
| 4             | Delete student, with markings scrubbed                                  | `5d5be22`            | Done                                                             |
| 5             | Retention cron jobs                                                     | `7beb311`            | Done, except district data (see open questions)                  |
| 6             | Presence never shows emails                                             | `f70e549`            | Done                                                             |
| 7             | `VITE_FEATURE_SMART_IMPORT`                                             | `f70e549`            | Done                                                             |
| 8             | Younger-students copy                                                   | `5d5be22`, `29e7b0b` | Done                                                             |
| 9             | resend-inbound subject tags                                             | `bff0c9f`            | Done                                                             |
| 10            | No Sentry user ids for students                                         | `d5b62e7`            | Done                                                             |
| 4 (follow-up) | Delete student in one transaction, under the roster lock                | `e332f85`            | Pushed by a separate Claude session after this one opened the PR |
| 5 (follow-up) | Retention purges lock and re-check each candidate                       | `1a1cf89`            | Same separate session                                            |
| 5 (follow-up) | Devices back after tombstone compaction resync in full                  | `61c4394`            | Same separate session                                            |
| 5 (follow-up) | District data purged 30 days after the contract ends                    | `784718a`            | Same separate session; ships paused                              |
| 3 (follow-up) | Restore carries the teacher's attestation into the account's `age_gate` | `017df18`            | Same separate session                                            |
| 5 (follow-up) | Hold the sync cursor until the first full sync after an upgrade         | `cbb10f7`            | Another separate session (`01VQ9k…`), committed as Max Harris    |
| 5 (follow-up) | District purge takes only the students the district provided            | `10cfe1d`            | Committed as Max Harris                                          |
| 5 (follow-up) | `district_billing` defined exactly as in #61                            | `d342b2f`            | Committed as Max Harris                                          |

Items 3 and 4 share one commit, as do 6 and 7, because each pair edits the same files (student-provision and RosterPage; ViewerPage).

### 1. Consent-age table

- The table exists in three places:
    - `supabase/functions/_shared/consentAge.ts`, the Edge Functions' copy;
    - `src/features/legal/consentAge.ts`, the browser's mirror;
    - `public.consent_age()` in migration `20261021120000`.
- Ages: 13 by default and in the UK. Every EU/EEA state is listed: 14 in AT/BG/CY/IT/LT/ES; 15 in CZ/FR/GR/SI; 16 in HR/DE/HU/IE/LU/NL/PL/RO/SK/LI; 13 for the rest.
- `tests/legal/consentAgeInSync.test.ts` fails the build if the three copies disagree.

### 2. Age screen and server enforcement

- `src/features/auth/AgeScreen.tsx` and `ageCheck.ts` ask for country, then birth month and year.
- The answer is compared with the country's age and dropped. Only `{country, min_age, source, v}` is stored, as `user_metadata.age_gate`.
- A refusal is neutral: it names no age, and is remembered on the device for 24 hours.
- On `/join` the screen comes after the link check, so a dead link never asks anyone's age, and before the guest is created.
- **Server:** `public.hook_before_user_created`, with `config.toml` turning it on locally and off for `[remotes.dev]`. Verified against local GoTrue v2.197:

    | Creation path       | Hook fires?                                                |
    | ------------------- | ---------------------------------------------------------- |
    | Email sign-up       | Yes                                                        |
    | Anonymous sign-in   | Yes                                                        |
    | `inviteUserByEmail` | Yes                                                        |
    | Admin `createUser`  | No; student-provision's attestation check covers that path |

    Because the hook fires for anonymous sign-ins, no `auth.users` trigger was needed.

- `live-e2e.mjs` now answers the age screen before the guest's name.

### 3. Teacher attestation

- The add-student form and a new Restore dialog ask for the student's country and a ticked "I confirm this student is at least N years old, the minimum age to use Cleffy in {country}."
- student-provision runs `readTeacherAttestation` before the seat check or any write. It recomputes N from the country and refuses wording that names a lower age.
- Storage:
    - on the roster row: `managed_students.country`, `age_attested_at`, `age_attested_min_age` (migration `20261021120100`);
    - a log row in the new `teacher_attestations` table on every create or restore;
    - in the account's `age_gate`.
- No birthday is asked.

### 4. Delete student

- "Delete student…" in the row menu, for active and archived students.
- `scrub_student_markings()` (migration `20261021120200`) runs first:
    - it tombstones the student's marks, so `seq` bumps and every device converges;
    - it replaces their payload with the smallest valid shape;
    - it removes them from lesson-history snapshots and clears the snapshot author.
- Then the auth user is deleted, and its cascades remove the roster row, assignments and practice notes.

### 5. Retention

Migration `20261021120300` adds bounded, service-role-only functions and pg_cron jobs, all off the hour:

| Data                                                    | Kept for     | Runs                 |
| ------------------------------------------------------- | ------------ | -------------------- |
| Archived students (scrubbed like Delete student)        | 12 months    | Daily, 03:17         |
| Guests with no sign-in, update or session refresh       | 90 days idle | Daily, 03:27         |
| Rate-limit and login buckets                            | 1 day        | Daily, 03:37         |
| `support_messages`                                      | 24 months    | Daily, 03:47         |
| Annotation tombstones (`compact_annotation_tombstones`) | 90 days      | Weekly, Sunday 04:23 |

### 6. Presence

- `presenceNameOf` in `session.ts` announces the display name, falling back to Guest or Collaborator. A display name that looks like an email is treated as no name.
- `realtimeChannel` cleans the names it receives with the same rule, in `src/lib/presenceName.ts`.

### 7. Smart import flag

- `features.smartImport` (`VITE_FEATURE_SMART_IMPORT`, off by default) gates:
    - the viewer's import button, on cloud and local scores;
    - the `?import=1` auto-open;
    - the library's post-upload offer, whose prescan no longer runs while the flag is off.
- Documented in `.env.example` and DEPLOY.md step 5. Session B's `aiFeatures.ts` can now read `features.smartImport`.

### 8. Copy

- The setup-code option now says "No email needed — a printed card they set up once" instead of "best for younger students".
- The landing page's share step adds "For ages 13 and up (older in some countries)."
- I found no other child-directed copy in the marketing or pricing surfaces.

### 9. resend-inbound

- Forwarded subjects start with `[privacy]`, `[legal]` or `[support]`, taken from `received_for` with `to` as the fallback.
- If a message reached several inboxes, the most sensitive tag wins.
- The logic lives in `inboxTagFor` and `forwardedSubject` in `_shared/supportMail.ts`.

### 10. Sentry

- In the browser, `monitoringUserIdOf` returns null for an account whose `app_metadata.user_type` is `student`, and `main.tsx` uses it. Students' error reports still arrive, without an id.
- The Edge Functions' `errorLog` drops `studentUserId`, `studentId` and `username` from report context.

### Follow-up `e332f85` (not from this session)

After the PR opened, a separate Claude session pushed `e332f85` to `mh/launch-consent`. It closes a race in Delete student: a mark drawn between the scrub and the account delete could escape the scrub.

- `revoke_and_scrub_student` (migration `20261021120400`) locks the roster row, archives it, ends the student's sessions and scrubs their marks, all in one transaction.
- A guard trigger makes every annotation and lesson-history write by a roster student wait on that lock and then re-check the roster row.
- The commit adds `tests/sql/launch_consent_concurrency.mjs`, 7 more checks in `tests/sql/launch_consent.sql` (36/36 locally, by that session's account), and `tests/legal/deleteStudentTransaction.test.ts`.

### Follow-up `1a1cf89` (not from this session)

The same session then pushed `1a1cf89`. It closes a race in the retention purges: a student restored, or a guest who signed back in, after the purge had read its list was deleted anyway.

- Migration `20261021120500` redefines both purges. Each candidate is locked (`FOR UPDATE SKIP LOCKED`) and re-checked before it is deleted.
- Guest activity is read through one function, `retention_guest_last_active()`, so the list and the re-check can't disagree.
- student-provision's restore now only updates a row that is still archived. It answers 404 if the purge took the student first.
- Tests: the concurrency script gains this case, `tests/sql/launch_consent.sql` is 37/37 locally (by that session's account), and `retentionJobs.test.ts` pins the lock-then-recheck shape.

### Follow-up `61c4394` (not from this session)

The same session then pushed `61c4394`. It covers a gap the weekly tombstone compaction (item 5) would otherwise open: a device that had been offline longer than the 90-day window would never learn about marks deleted and then compacted while it was away.

- Migration `20261021120600` adds a resync floor.
- The sync engine (`src/sync/syncEngine.ts`, `src/sync/db.ts`) does a full resync for a device whose last sync is older than that floor.
- It adds new `syncEngine` tests and more checks in `tests/sql/launch_consent.sql`.

### Follow-up `784718a` (not from this session)

The same session then pushed `784718a`, which builds the district item I had left open: district data is purged 30 days after the contract ends (migration `20261021120700`, the new `district-retention-notices` Edge Function, `tests/sql/district_retention.sql`).

- **The contract end date.** It lives on `district_billing.contract_ends_at`. The commit creates that table with the same shape as Session D's PR #61 (`create table if not exists`), so the two merge in either order.
- **The timeline:**
    - day 16 after the contract ends: the owner is sent an export notice;
    - day 30, and at least 14 days after the notice was actually sent: soft delete. The district's roster students are archived and signed out;
    - 7 days after that: hard delete. Each student is scrubbed and deleted as Delete student does, then the district studio goes.
- **Cancelling.** Clearing or moving the end date (a renewal, an admin correction) cancels whatever stage the purge reached and un-archives the students.
- **Ships paused.** Nothing schedules `retention_district_run()`, and nothing is purged before its notice has been sent. See the hosted steps below.

### Follow-up `017df18` (not from this session)

`017df18` fixes a gap in item 3: restore wrote the new attestation to the roster row and to `teacher_attestations`, but left the account's `user_metadata.age_gate` as it was at creation. student-provision's restore now updates it too, and `teacherAttestation.test.ts` pins that.

### Follow-up `cbb10f7` (not from this session)

`cbb10f7`, from another session (`01VQ9k…`), hardens `61c4394`. On a device upgrading from a build that predates the resync floor, a live broadcast arriving before the first full pull could move the sync cursor past a deletion that had been compacted meanwhile, so the device would never see that deletion. `applyServerRow` now leaves the cursor where it is until a pull has run the compaction check. It touches only `src/sync/syncEngine.ts` and adds tests.

### Follow-ups `10cfe1d` and `d342b2f` (not from this session)

`10cfe1d` answers a review finding on #64. The district purge used to select every roster student of the district's owner and of whoever held a seat on the day it ran. So a teacher who joined a district exposed their private roster to its purge, and a teacher who left took the district's students out of it.

- Migration `20261021120800` stores on each roster row the district it was provisioned under, `managed_students.district_studio_id`, and the purge now selects on that alone.
- A `BEFORE INSERT` trigger writes the value. A value a client supplies is ignored, an `UPDATE` that changes it is refused, and only the service role's logged `admin_set_student_district()` may change it.
- Existing rows are backfilled from a seat held since before the student was created. A private student is never guessed into a district.
- New proof: `tests/sql/district_student_scope.sql`.

`d342b2f` makes `20261021120700`'s `district_billing` definition match #61's exactly. `districtBillingCanonical.test.ts` and `tests/sql/district_billing_canonical.sql` check that the two stay identical, so the branches merge in either order.

For all eight follow-ups I reviewed the diffs for scope (they touch only Delete student, restore, retention, district retention, and the sync engine's handling of compacted tombstones) but did not re-run their tests myself. CI on all eight is green (below).

## Local results (head `d5b62e7`)

| Check                                                                     | Result                      |
| ------------------------------------------------------------------------- | --------------------------- |
| `npm run lint:check`                                                      | Pass                        |
| `npm run typecheck`                                                       | Pass                        |
| `npm run test`                                                            | Pass: 196 files, 2799 tests |
| `npm run build`                                                           | Pass                        |
| `tests/sql/launch_consent.sql` against the local stack (PostgreSQL 17.11) | All 29 checks pass          |

Tests ran with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` blanked. The `.env.local` that `npm run cloud:up` writes points tests at the live local stack, and two existing tests then fail (`tests/auth/turnstileField.test.tsx`, `src/sync/syncEngine.test.ts`), on `dev` too. CI has no `.env.local`.

The new code is formatted with `npx prettier --write`.

## CI

Green on the current PR head `d342b2f`, in push runs 39657548167 and 39657540469:

| Check                                              | Result  |
| -------------------------------------------------- | ------- |
| `checks` (npm audit, lint, typecheck, test, build) | Pass    |
| `omr-service`                                      | Pass    |
| `supabase-drift`                                   | Pass    |
| Vercel Preview                                     | Pass    |
| Supabase Preview                                   | Skipped |

Earlier heads were green too:

- `10cfe1d`.
- `cbb10f7`: push runs 39655286674 and 39655279965.
- `017df18`: push runs 39617850021 and 39617843672.
- `784718a`: PR run 39550588916, push run 39550582288.
- `61c4394`: PR run 39549244202, push run 39549238770.
- `1a1cf89`: PR run 39548456170, push run 39548451018.
- `e332f85`: PR run 39547843662, push run 39547839267.
- `d5b62e7` (this session's last commit): PR run 39543836217, push run 39543252673.

## ui-check

- Ran `scripts/ui/uifuzz.mjs` on all 9 viewports. Surfaces:
    - `/register`: age screen, its validation error, the form behind it, and the refusal (which still shows after a reload);
    - `/join`: age screen, then the name prompt;
    - `/students`: add form with the attestation, archived-row menu, Restore dialog, Delete dialog;
    - the landing page's student step.
- The roster checks used a throwaway local Teacher-plan account with local fixtures, removed afterwards. The seeded accounts were not touched.
- About 20 screenshots were inspected by eye across desktop, iPad and phone sizes.
- No layout defects found. The audit flags were:
    - controls behind the modal scrim (expected);
    - the sticky header over scrolled content (expected);
    - inline text links in agreement notes and footers, small tap targets the audit measures without their touch extension (pre-existing).
- On the last roster row, the row menu opens below the fold and the page scrolls to it. The existing menus do the same.

## Hosted steps for Max (also in the PR)

1. Merge and deploy the front end before switching on the hook. A build from before this PR sends no `age_gate`, so with the hook on, its sign-ups and joins would fail.
2. Apply the migrations `20261021120000` through `20261021120800`. `config.toml` keeps the hook off for `[remotes.dev]`, so the branch deploy doesn't switch it on.
3. Switch on the Auth hook on dev, then prod: Dashboard → Authentication → Hooks → Before User Created → Postgres → `public.hook_before_user_created`. Then test one sign-up and one share-link join.
4. Before the first 03:17 UTC run, check how many archived students (over 12 months), idle guests (over 90 days) and support messages (over 24 months) will be purged. The SQL is in the PR.
5. On Vercel, leave `VITE_FEATURE_SMART_IMPORT` unset or `0`.
6. Optional: run `tests/sql/launch_consent.sql` against the dev branch project. It rolls back.
7. **District retention (paused until you start it).**
    1. Deploy the function with `supabase functions deploy district-retention-notices --no-verify-jwt`, and set `DISTRICT_NOTICE_SECRET` in its environment.
    2. Create two vault secrets: `district_notice_url`, the function's URL, and `district_notice_secret`, the same value as `DISTRICT_NOTICE_SECRET`.
    3. Read the counts from `select public.retention_district_dry_run();` against production.
    4. Then schedule it: `select cron.schedule('retention-district', '57 3 * * *', $$select public.retention_district_run()$$);`

## Open questions, and what was skipped

- **student-provision has not run end to end.** The local Edge runtime can't fetch `npm:` packages through the sandbox's TLS-intercepting proxy. I tried `DENO_CERT`, `DENO_TLS_CA_STORE=system` and adding the CA to the container's store; none worked, and no function booted. The function is covered by:
    - unit tests of `readTeacherAttestation`;
    - a source-order guard (attestation before the seat check; scrub before the account delete);
    - the SQL proof of everything it calls.

    Worth one manual add, restore and delete on dev after deploy.

- **Birthday month.** Month and year can't settle someone whose birthday month is the current month, so they are refused for 24 hours. A day field would remove that edge, at the cost of collecting more.
- **Ages outside the EEA and UK** default to 13, per the packet. Some places differ (for example South Korea, China and Québec use 14); not added.
- **District data 30 days after contract end.** Now built by follow-up `784718a`. It ships paused until you take step 7 above. Its contract end date (`contract_ends_at`) is set by Session D's flow, so it needs PR #61 to be useful.
- **Guests purged at 90 days** keep their marks on the teacher's score with no name attached, the same as a self-deleted account. Only roster students' marks are scrubbed. Say if guest marks should be scrubbed too.
- **Privacy policy (Session B).** `src/features/legal/legalContent.ts` still says presence falls back to the email; I left it alone because it's Session B's file. The new policy should state:
    - presence shows the display name, else Guest or Collaborator;
    - the age screen keeps only country and age;
    - teacher attestations are recorded;
    - the retention periods above;
    - Delete student removes the student's marks.
- **Possible merge conflicts with the other sessions' PRs:**
    - `scripts/apply-migrations.sql` is generated; rerun `npm run migrations:mirror` after merging;
    - `src/types/database.ts`, `supabase/config.toml` and `LibraryShell.tsx` change in different places in each branch;
    - `LandingPage.tsx` also changes in Session C's branch.
