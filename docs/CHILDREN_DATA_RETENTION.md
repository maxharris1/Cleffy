DRAFT — not reviewed by counsel; not a statement of compliance.

# Children's data retention policy (internal draft)

Internal. Not published. Written in the shape of a written retention policy
under 16 CFR 312.10: for each kind of information, why we hold it, the
business need, and when it is deleted. Counsel must review it before anyone
relies on it. Open questions are in `docs/LEGAL_REVIEW.md` §23.

Owner: Max (see `docs/INFORMATION_SECURITY_PROGRAM.md`). Reviewed at least once
a year, and whenever a feature that could touch children's information ships.

## Starting point

- Children under 13 do not get Cleffy accounts. Self sign-up, invite
  acceptance and guest upgrade pass the neutral age screen
  (`src/features/auth/AgeScreen.tsx`). Teachers confirm each student meets the
  minimum age before `student-provision` creates an account.
- With Share v2 (`VITE_FEATURE_SHARE_V2`, off in production), people who open a
  score by link no longer pass the age screen. A link viewer gives nothing. A
  link guest who edits gets an anonymous guest profile and may type a name, so
  a child can be a link guest.
- So Cleffy aims to hold as little as possible from children under 13. This
  policy covers the edges: a teacher using Cleffy with a young student, link
  viewers and link guests, share links and invites, our processors' logs, and
  information we learn was collected from a child by mistake.

## Retention by item

| Item                                                                                                      | Purpose                                                  | Business need                                  | Deletion                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Teacher-device use (a teacher shows a score to a young student on the teacher's own screen)               | Teaching in a lesson                                     | None from the student                          | Nothing is collected from the student, so nothing to delete. The teacher's own account data follows the Privacy Policy.                                                                    |
| Age-screen refusal marker (`cleffy.ageCheck.refusedAt` in the browser's localStorage)                     | Stop a refused person retrying at once with another year | Keeps the age screen neutral                   | Stays on that device only, never sent to us, holds a time and no age. Ignored after 24 hours.                                                                                              |
| Link viewer (Share v2, signed out)                                                                        | Show the score                                           | None                                           | Nothing in Cleffy's database. On the device: memory only. Realtime presence (random key, "Anonymous <animal>") is held in memory and gone when the tab closes.                             |
| Link guest (Share v2, edits by link): `auth.users` row, optional name, IP in the GoTrue audit log         | Let the guest edit and sync markings                     | Needed while the guest uses the score          | Deleted after a period without use the score's owner chooses: 7 to 90 days, default 30 (`retention_guest_idle_window`); never more than 90 days. Markings stay on the score, unattributed. |
| `share_links` rows: which score, which owner, token, role, expiry, revocation time                        | Let the owner create, renew, reset and revoke links      | Owner's own data, needed while the link exists | Expiry the owner chooses: 1 hour to 1 year, default 7 days, or never. Deleted 30 days after revoke or expiry (`retention-share-links`).                                                    |
| `document_invites` rows: invitee email, role, inviter, token hash, dates                                  | Let the owner invite a person by email                   | Needed until the invite is accepted or closed  | Expires after 14 days. Deleted 30 days after it is accepted, cancelled or expires.                                                                                                         |
| Processor logs: Vercel runtime logs                                                                       | Deliver the page, keep it secure and working             | Debugging and abuse handling                   | Vercel Hobby runtime logs: about 1 hour. Vercel security handling: per Vercel's DPA.                                                                                                       |
| Processor logs: Supabase                                                                                  | Same                                                     | Same                                           | About 7 days.                                                                                                                                                                              |
| Processor logs: Resend (invite mail)                                                                      | Send the invitation email                                | Delivery and abuse handling                    | Per Resend's DPA.                                                                                                                                                                          |
| Information we learn was collected from a child under 13 (for example a student account created in error) | None                                                     | None                                           | Deleted as soon as we confirm it, including the account and its markings. Backups age out on the provider's schedule.                                                                      |

## Deletion method

- Database rows: hard delete, or the existing account-deletion path
  (`delete-account` logic) for an account.
- Device storage: the refusal marker expires by itself; nothing else is kept.
- Processor logs: deleted by the processor on its own schedule. We do not
  export or copy them.
- Requests from parents go to privacy@cleffy.io. We answer and delete without
  asking the parent to create an account.

## Not covered yet

- Exact log windows for Vercel and Supabase on the plans in use must be
  re-checked when a plan changes.
- Share v2 replaced the planned `view_links` table with `share_links`,
  `document_invites` and link guests. Re-read this policy against the v2
  schema before `VITE_FEATURE_SHARE_V2` is switched on in production.
