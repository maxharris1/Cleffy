DRAFT — not reviewed by counsel; not a statement of compliance.

# Information security program (internal draft)

Internal. Not published. Written in the shape of the written security program
described in 16 CFR 312.8(b), with its five elements below. Counsel must review
it before anyone relies on it. Open questions are in `docs/LEGAL_REVIEW.md` §23.

## 1. Coordinator

Max is the coordinator. Max owns this program, the risk assessment, vendor
assurances and incident response. Who acts when Max is unavailable is not
decided yet; settle it at the first annual review.

## 2. Risk assessment (annual)

Once a year, and before a feature that changes what personal information
Cleffy holds, list:

- what personal information is held, where, and who can reach it;
- internal risks (mistakes in RLS, grants or Edge Functions; leaked keys;
  over-broad access) and external ones (account takeover, abuse of share or
  view links, vendor incidents);
- whether the safeguards below still cover them.

Record the date, findings and follow-up issues in the repo or the tracker.

## 3. Safeguards

- Row-level security on every table in the `public` schema, with explicit
  grants; nothing relies on default privileges.
- Storage buckets are private. Files are reached through signed URLs or
  policies, never public buckets for user content.
- The Supabase service-role key lives only in Edge Function secrets. It is
  never shipped to the browser or committed to git.
- View-link tokens (when view links ship) are random, revocable by the teacher
  and expire.
- No storage of children's information: children under 13 do not get accounts
  (`docs/CHILDREN_DATA_RETENTION.md`).
- Sign-in through Supabase Auth; secrets in the hosting providers' secret
  stores, not in the repo.

## 4. Testing and monitoring

- CI runs SQL proofs against a fresh local stack (`tests/sql/*.sql`,
  `supabase/sql-tests/`), lint, typecheck, unit tests, a production build, and
  `npm audit --omit=dev --audit-level=high`.
- Supabase security and performance advisors are checked after each schema
  change and at least monthly.
- Dependencies are updated regularly; high-severity advisories are handled
  first.
- Access review at least once a year: who can reach Supabase, Vercel, Stripe,
  Resend, GitHub and the support mailbox. Remove anyone who no longer needs it.

## 5. Evaluation (annual)

Once a year, and after any incident or material change to the product or the
vendors, re-read this program and the retention policy, update them, and note
what changed and why.

## Vendor assurances

Cleffy shares personal information only with processors that have agreed to
protect it:

- Vercel (web hosting): DPA on file.
- Supabase (database, auth, storage, Edge Functions): DPA on file.
- Resend (email): DPA on file.

Check that each DPA is still current at the annual evaluation, and before
adding a vendor.

## Incident response

1. Contain: revoke the exposed key, token or access; take the affected
   feature offline behind its flag if needed.
2. Assess: what information, whose, how many people, since when.
3. Preserve evidence: logs, timelines, commits.
4. Notify: decide with counsel who must be told (users, parents, schools,
   regulators) and by when, as the law requires.
5. Fix the root cause and add a test or proof that would have caught it.
6. Write a short post-incident note and update this program.
