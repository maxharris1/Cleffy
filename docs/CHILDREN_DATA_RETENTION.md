DRAFT — not reviewed by counsel; not a statement of compliance.

# Children's data retention policy (internal draft)

Internal. Not published. Written in the shape of a written retention policy
under 16 CFR 312.10: for each kind of information, why we hold it, the
business need, and when it is deleted. Counsel must review it before anyone
relies on it. Open questions are in `docs/LEGAL_REVIEW.md` §23.

Owner: Max (see `docs/INFORMATION_SECURITY_PROGRAM.md`). Reviewed at least once
a year, and whenever a feature that could touch children's information ships.

## Starting point

- Children under 13 do not get Cleffy accounts. Self sign-up and share-link
  guests pass the neutral age screen (`src/features/auth/AgeScreen.tsx`).
  Teachers confirm each student meets the minimum age before
  `student-provision` creates an account.
- So Cleffy aims to hold no personal information from children under 13. This
  policy covers the edges: a teacher using Cleffy with a young student, view
  links (not live; behind `VITE_FEATURE_VIEW_LINKS`), our processors' logs, and
  information we learn was collected from a child by mistake.

## Retention by item

| Item                                                                                                      | Purpose                                                  | Business need                                    | Deletion                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Teacher-device use (a teacher shows a score to a young student on the teacher's own screen)               | Teaching in a lesson                                     | None from the student                            | Nothing is collected from the student, so nothing to delete. The teacher's own account data follows the Privacy Policy. |
| Age-screen refusal marker (`cleffy.ageCheck.refusedAt` in the browser's localStorage)                     | Stop a refused person retrying at once with another year | Keeps the age screen neutral                     | Stays on that device only, never sent to us, holds a time and no age. Ignored after 24 hours.                           |
| View-link viewer data (when view links ship)                                                              | —                                                        | None                                             | Cleffy stores no viewer data in its database.                                                                           |
| `view_links` rows (when view links ship): which score, which teacher, token, expiry, revocation time      | Let the teacher create, list and revoke links            | Teacher's own data, needed while the link exists | Deleted 30 days after the teacher revokes the link, or when it expires.                                                 |
| Processor logs: Vercel runtime logs                                                                       | Deliver the page, keep it secure and working             | Debugging and abuse handling                     | Vercel Hobby runtime logs: 1 hour. Vercel security handling: per Vercel's DPA.                                          |
| Processor logs: Supabase                                                                                  | Same                                                     | Same                                             | About 7 days, and only if the signed-URL fallback for view links is used. Otherwise a view does not reach Supabase.     |
| Information we learn was collected from a child under 13 (for example a student account created in error) | None                                                     | None                                             | Deleted as soon as we confirm it, including the account and its markings. Backups age out on the provider's schedule.   |

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
- The `view_links` table does not exist yet (packet U13-2). This policy must be
  re-read against the real schema when it lands.
