# Share v2, PR 3: privacy and legal docs (plan)

Ticket #106 · PR #111 · branch `factory/issue-106` off `dev` (at `566231b6`, which includes #104 as #107 and #105 as #108) · risk low · builder claude-bot · reviewer codex.

This PR changes only copy and docs. It updates the Privacy Policy, the Children's Privacy Notice, their versions, `docs/CHILDREN_DATA_RETENTION.md` and `docs/LEGAL_REVIEW.md` so they say what each Share v2 path collects, where it goes and how long it is kept. All new public text is gated on `features.shareV2` (`VITE_FEATURE_SHARE_V2`, off by default). With the flag off, every document and version reads exactly as it does on `dev`.

Expected files: `.ts`, `.test.ts`, `.md`, plus one test snapshot file. The PR also edits `src/features/legal/LegalPage.test.tsx`. That is a `.tsx` file, so it matches the `src/**/*.tsx` glob in `hold.paths`, even though it is a test. See §6 for how to avoid that.

## 1. Facts from `dev` that the text must follow

The numbers below are what #104 (#107) enforces. The ticket's numbers agree with them, with one addition: links can also be set to "Never".

| Item                            | Code                                                                                                                                                                                                             | Value                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link expiry                     | `share_link_expiry()` and trigger in `20261113120000_share_v2_links.sql:146-192`; `LINK_EXPIRY_CHOICES_V2` in `src/features/share/shareService.ts:248-257`                                                       | 1 hour to 365 days, **or never**; default 7 days (`:60`, `:383`, `:502`). UI choices: 1 day, 7 days, 30 days, 90 days, 1 year, Never. Renew is `renew_share_link`. Reset is `reset_share_link`, which keeps the expiry, or uses 7 days if the link has lapsed (`:446-492`).                            |
| Revoked or expired links purged | `retention_purge_share_links` in `20261113120200_share_v2_invites.sql:488-499`, cron `retention-share-links`                                                                                                     | 30 days after revoke or expiry                                                                                                                                                                                                                                                                         |
| Invites                         | `document_invites.expires_at` default and resend (`…invites.sql:30,350,387`); `retention_purge_share_invites` (`:513-522`)                                                                                       | Expire after 14 days. Deleted 30 days after accept, cancel or expiry.                                                                                                                                                                                                                                  |
| Link-guest idle deletion        | `share_owner_settings.link_guest_idle_days` (`20261113120300_share_v2_link_guests.sql:136`), `set_link_guest_retention` (`:162-174`), `retention_guest_idle_window` (`:195-217`), `LINK_GUEST_RETENTION_CHOICES` | The owner chooses. UI offers 7, 14, 30, 60 or 90 days. The server accepts 1 to 90. Default 30. A guest on several owners' scores is kept until the longest window passes, never more than 90 days. Other guests: 90 days (cron `retention-stale-guests`, `20261021120300_retention_jobs.sql:179-192`). |
| Anonymous viewer name           | `src/features/share/anonymousAnimals.ts:100`                                                                                                                                                                     | "Anonymous <animal>"                                                                                                                                                                                                                                                                                   |
| Link-guest name field           | `ShareLinkPage.tsx:283-295`                                                                                                                                                                                      | "Your name (optional)"; "Leave it blank to stay anonymous."                                                                                                                                                                                                                                            |
| Server use of versions          | `stripe-checkout/index.ts:97`, `_shared/checkoutFlow.ts:402`                                                                                                                                                     | Only `terms` and `refunds` are recorded. `privacy` and `children` exist on the server only as a mirror.                                                                                                                                                                                                |
| Re-consent                      | grep for re-consent or consent-version comparison in `src/`                                                                                                                                                      | None. Bumping a version never prompts anyone.                                                                                                                                                                                                                                                          |

**Wording choices that follow the code:**

- **Link expiry.** The ticket says "from 1 hour to 1 year, 7 days by default". The code also offers "Never" as an explicit owner choice, as the ticket's own technical defaults note. The text will say: "after a time the owner chooses, from 1 hour to 1 year (7 days by default), or never if the owner chooses that."
- **Idle deletion.** The ticket says "7 to 90 days". The server also accepts 1 to 6 days, but no UI offers them. The text will say "between 7 and 90 days", matching what an owner can choose. The PR body will name the gap. Counsel may prefer "up to 90 days", which is true for every value the server accepts.

## 2. Work items

### W1. Pin the flag-off text first (proves AC1)

The first commit lands before any copy changes. It adds `src/features/legal/legalFlagOff.test.ts`, which renders the flag-off plain text (summary plus `legalText`) of `PRIVACY_POLICY` and `CHILDREN_NOTICE`, and the flag-off `LEGAL_VERSIONS` and `LEGAL_LAST_UPDATED`, into `toMatchSnapshot()`. The flag is forced off with `vi.doMock('@/lib/features')`, the way `childrenNotice.test.ts:35-46` forces it on. The snapshot is generated at `dev`'s text and committed with it. Later commits must leave it unchanged, so the reviewer can see in the history that the flag-off output never moved.

### W2. Privacy Policy (`src/features/legal/privacyPolicy.ts`)

Import `features` from `@/lib/features` (import-free and tiny). Each change below picks between the `dev` string and the v2 string with `features.shareV2`. Comments cite the code each statement describes, as the file's convention asks.

- **a. Information we collect (`:101-106`).** With the flag on, the age-screen line drops "or join as a guest" and says only "When you sign up". The "If you open a share link without an account… name you type" line is replaced by three bullets:
    - **Viewing by link.** You don't need an account, nothing is asked and nothing about you is stored. Vercel and Supabase process your IP address to deliver the page and keep it secure, and their logs keep it briefly (about 7 days at most). Others on the score see an anonymous viewer such as "Anonymous Otter". The owner sees how many people are viewing, not who.
    - **Editing by link.** You can give a name or stay anonymous. A temporary guest profile holds that name (if any) and your markings. The profile is deleted after a period without use that the score's owner chooses, between 7 and 90 days (30 days unless they change it). Your markings stay on the score.
    - **Invites.** The email address and the invitation are stored until it is accepted or expires (14 days), then deleted 30 days later.
- **b. Who can see your scores (`:187-190`).** With the flag on, the share-link line says links expire after a time the owner chooses (1 hour to 1 year, 7 days by default, or never), that the owner can renew or reset a link, and that revoked or expired links are deleted 30 days later. The presence line adds anonymous viewers ("Anonymous <animal>") and the live viewer count only the owner sees. It keeps "email addresses are never shown", so `LegalPage.test.tsx:190-211` still passes.
- **c. Children (`:261`).** With the flag on: "To create an account, you must be at least 13 (or older where your country sets a higher age…). Opening or editing a shared score by link does not create an account; if you later want to keep your work in an account, we ask the age question then." This matches `guest-email-confirm` and `UpgradeBanner`, which ask a link guest the age question before upgrading.
- **d. Retention (`:286`).** With the flag on: guest profiles from a link are deleted after the owner-chosen idle period (7 to 90 days, default 30; at most 90 when a guest is on several owners' scores). Other guest profiles are deleted after 90 days. Both still say "unless an email address has been added to keep them". New bullets: shared links and invites as in (a) and (b).
- **e. Deleting a guest profile (`:325-327`).** No change. The `deleteGuest` path is the same for link guests.

### W3. Children's Privacy Notice (`src/features/legal/childrenNotice.ts`)

- **a.** Replace the flag-on `view-links` section (`:21-41`) with a section `opening-by-link`, headed "Opening a shared score by link". It says:
    - Viewing collects nothing, sets nothing on the device and leaves no record.
    - Vercel and Supabase process the IP address to deliver the page and keep it secure. Vercel's runtime logs keep it for about 1 hour and Supabase's for about 7 days.
    - The owner sees only an anonymous count of viewers.
    - A link guest who edits may type a name. We suggest a first name or nickname, and it is optional. The guest profile is deleted after the idle period the owner chooses (7 to 90 days, default 30).
    - Parents can ask us to delete it at the privacy@ address (`emails.privacy`).

    The counsel placeholder (`placeholder('Counsel: …')`) stays, reworded for the R7 question (D11).

- **b.** In the `no-accounts` age-check sentence (`:64`), "or joins a shared score as a guest through a share link" is dropped when the flag is on. With the flag off, the `dev` string stays.
- **c.** `childrenNotice.test.ts`: the flag-on test (`:68-81`) now checks the new heading, each statement above, the dropped clause, and that the `view-links` id is gone. The flag-off test (`:63-66`) and every "no COPPA compliance claim" test (`:83-125`) stay unchanged and must still pass.

### W4. Versions (D12): `legalVersions.ts`, `_shared/legalVersions.ts`, `legalVersions.test.ts`

The server mirror cannot read the Vite flag. The server records only `terms` and `refunds`, so `privacy` and `children` there are only a mirror. The plan:

- In `src/features/legal/legalVersions.ts`, keep today's stamps as the base. Add `SHARE_V2_LEGAL_VERSIONS = { privacy: '<date>-draft', children: '<date>-draft' }` and matching `SHARE_V2_LEGAL_LAST_UPDATED`, where `<date>` is the day the text lands. `LEGAL_VERSIONS` and `LEGAL_LAST_UPDATED` are then the base with those overlaid when `features.shareV2` is on.
    - The module then imports `@/lib/features`. That module is import-free, so the comment's goal still holds: no document text enters checkout or billing bundles.
    - With the flag off, both objects equal today's values exactly.
- In `supabase/functions/_shared/legalVersions.ts`, `LEGAL_VERSIONS` keeps the base stamps, which are what any server code would record. Add the same `SHARE_V2_LEGAL_VERSIONS` literal, with no imports.
- `legalVersions.test.ts`:
    - With the flag off, the server and client values are equal (today's test, unchanged).
    - The server's `SHARE_V2_LEGAL_VERSIONS` equals the client's.
    - `PUBLISHED_VERSIONS` stays pinned for the flag-off build.
    - A new pinned `PUBLISHED_SHARE_V2_VERSIONS` and a `vi.doMock` flag-on case prove the client shows the bumped `privacy` and `children` stamps and the base for the other three.
- No re-consent prompt. There is none to trigger (§1), and none is added.
- The PR body explains this approach, as the ticket asks, and notes that no consent or server legal-version logic changes.

### W5. `docs/CHILDREN_DATA_RETENTION.md`

- **Starting point (`:15-22`).** Link guests no longer pass the age screen, so a child can be a link guest. Self sign-up, invite acceptance and guest upgrade still do. The flag is `VITE_FEATURE_SHARE_V2`, not `VITE_FEATURE_VIEW_LINKS`.
- **Table.** Replace the two view-link rows and fix the processor rows:
    - Link viewer: nothing in the DB; on the device, memory only; Realtime presence held in memory.
    - Link guest: the auth row, the optional name, and the IP in the GoTrue audit log; deleted after the owner-chosen idle period (7 to 90 days, default 30).
    - `share_links`: expiry the owner chooses, from 1 hour to 1 year (default 7 days) or never; deleted 30 days after revoke or expiry.
    - `document_invites`: expire after 14 days; deleted 30 days after closing.
    - Processor logs: Vercel about 1 hour, Supabase about 7 days, Resend per its DPA.

    "only if the signed-URL fallback is used" is removed.

- **Not covered yet (`:46-51`).** The `view_links` note becomes "re-read against the v2 schema before `VITE_FEATURE_SHARE_V2` is switched on in production".
- The first line stays "DRAFT — not reviewed by counsel; not a statement of compliance." (checked by `childrenNotice.test.ts:111-116`).

### W6. `docs/LEGAL_REVIEW.md`

- **§4 (`:80`).** Resend also sends invite mail to people who don't have an account.
- **§9 (`:140-145`).** The age gate applies to account creation only: self sign-up, invite acceptance and guest upgrade. It does not apply to link viewers or link guests. Note the counsel question (D11/R7).
- **§12 (`:190`).** Replace "Anonymous guest accounts… are never cleaned up". `retention-stale-guests` exists. Link guests follow the owner-chosen 7 to 90 days (default 30), and other guests get 90.
- **§15.** Link viewers store nothing on the device. Link guests get the normal app storage.
- **§23 (`:299-339`).** Replace the view-links bullets with a v2 summary: the three paths and their retention, R7 and its mitigations, and the reworded placeholder. Update the "Versions" paragraph for the W4 bump.

### W7. In-app copy

No `.tsx` change is planned. #105 already shipped the share copy. One gap is out of scope: the editor join field on `ShareLinkPage.tsx:283` reads "Your name (optional)", not "first name or nickname" (R7's mitigation wording). The notice text (W3) carries the suggestion. Relabelling the field is a `.tsx` change that holds the PR, so it goes in the PR body as a follow-up for Max to decide.

### W8. Gates

Before every push: `npm run lint:check`, `npm run typecheck`, `npm run test`, `npm run build`. Also run the suite once with `VITE_FEATURE_SHARE_V2=1` to catch flag-on breakage that the mocked tests miss, such as the "view link" and presence assertions in `LegalPage.test.tsx`. No migrations, Edge Function logic, hosted config or flag changes.

## 3. Acceptance criteria → work

| #   | Criterion                                                                                                                                                   | Work                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Flag unset: privacy policy, children's notice and versions render exactly as on `dev`, proven by snapshot or string tests                                   | W1 (snapshot committed before edits), W2/W3 flag-gated, W4 base unchanged and `PUBLISHED_VERSIONS` pinned |
| 2   | Flag on: three plain bullets (viewing, editing, invites) replace the guest/name lines                                                                       | W2a, with tests in `LegalPage.test.tsx` or a new `privacyPolicyShareV2.test.ts` (W2)                      |
| 3   | Sharing and presence: anonymous viewers, viewer count, owner-chosen expiry from 1 hour to 1 year (default 7 days), renew or reset, 30-day purge             | W2b ("or never" added to follow the code; §1)                                                             |
| 4   | New age sentence; guest retention of 7 to 90 days (default 30) for link guests and 90 for others                                                            | W2c, W2d                                                                                                  |
| 5   | Children's notice: "Opening a shared score by link" section with every listed point; guest clause dropped from the age check; COPPA test passes             | W3a, W3b, W3c                                                                                             |
| 6   | D12: privacy and children versions bumped for shareV2 text, no re-consent, client and server consistent, `legalVersions.test.ts` passes, approach explained | W4 (flag-gated overlay mirrored on the server; PR body explains)                                          |
| 7   | `CHILDREN_DATA_RETENTION.md`: starting point, five rows, fallback phrase removed, `view_links` note reworded                                                | W5                                                                                                        |
| 8   | `LEGAL_REVIEW.md`: §4, §9, §12, §15, §23                                                                                                                    | W6                                                                                                        |
| 9   | Every number matches what #104 enforces; differences named in the PR body                                                                                   | §1 table, applied in W2–W6; PR body names "Never" and the 1–6-day server range                            |
| 10  | No COPPA claim anywhere; CI `checks` green at the PR head                                                                                                   | W3c (existing scans over every document, flag off and on, the drafts and app source); W8                  |

All ten criteria are mapped.

## 4. Order of commits

1. W1: the flag-off snapshot, at `dev`'s text.
2. W4: versions, with tests.
3. W2: Privacy Policy, with tests.
4. W3: Children's Notice, with tests.
5. W5 and W6: the docs.
6. Gates green, then the PR body (W4 approach, §1 differences, W7 follow-up).

## 5. Risks

- **A flag-on assertion that a mocked test misses.** W8 runs the whole suite with the flag on.
- **Version overlay.** If importing `@/lib/features` into `legalVersions.ts` turns out to break a bundle-size or import-free guard, fall back to reading `import.meta.env.VITE_FEATURE_SHARE_V2 === '1'` directly, with a comment pointing to `features.ts`.
- **COPPA wording.** The new text describes what is collected and never says anything is "compliant". The existing scan covers it, flag off and on.

## 6. Hold

The planned diff touches no UI file but does edit `src/features/legal/LegalPage.test.tsx`, which matches `src/**/*.tsx`. To keep the PR off hold, put the flag-on Privacy Policy assertions in a new `privacyPolicyShareV2.test.ts` instead and leave `LegalPage.test.tsx` untouched unless a flag-on run forces a change. If it does, the PR body says so and the PR waits for Max's `ok`.
