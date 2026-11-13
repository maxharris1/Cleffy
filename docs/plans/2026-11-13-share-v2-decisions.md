# Share v2: Max's decisions on the plan

Plan: [2026-11-13-share-v2-plan.md](2026-11-13-share-v2-plan.md) (written 2026-11-13, 12:12 PM ET).

Max's direction (2026-11-13, 11:59 AM ET): Cleffy sharing should work like Google Docs and replace
PR #98's separate view-link system. #98 must not merge. One system, no duplicated code.

Approval (2026-11-13, 1:08-1:09 PM ET): "all but the delete idle after 30 days (should be a user
defined setting) and the link expiry, can default to 7, but should be configurable by the user as
well. Otherwise good to ship. Build it with the factory". At 1:11 PM ET: "We want you to put it into
the factory."

## Decisions (plan section 15)

| # | Decision |
| --- | --- |
| D1 | Close #98 (not merged); port the pieces in plan section 9 into PR 1 and PR 2 with credit. |
| D2 | One "General access" link per score, with Reset link. Existing extra links stay working under "Older links". |
| D3 | A signed-in visitor opening a link gets membership, as today. Signed-out visitors take the ephemeral path. |
| D4 | Revoke or Restricted always removes the people who joined through that link. |
| D5 | Invites to an email with no account: pending invite, account created on accept (age screen and password on the accept step). |
| D6 | Only the owner can share. |
| D7 | Inviting a roster student's email by anyone but their teacher is refused (point to Assign). |
| D8 **changed** | Idle link-guest deletion is an **owner-configurable setting**, not a fixed 30 days. Default 30 days, bounded choices enforced by the server. Schema, the cleanup cron and the Share dialog support it; the privacy docs describe it as owner-configurable with its bounds. Other guests stay at 90 days. |
| D9 | JWT signing: a dedicated asymmetric key if the project is on asymmetric signing keys, otherwise the HS256 secret as `SHARE_JWT_SECRET`. Max checks Dashboard > JWT Keys before prod; not a blocker for dev. |
| D10 | Cap of 40 simultaneous link viewers per score, adjustable as an Edge secret; a friendly "busy" with retry above it. |
| D11 | Short question to counsel before prod about the no-age-screen editor path; does not block dev. |
| D12 | Bump the Privacy Policy and Children's Notice versions when the flag turns on in prod; no re-consent prompt. |
| D13 | Viewers do not see who else is on the score; the owner sees the count. |
| D14 | Link URL shape `/s#<token>`; `/join/<token>` keeps working. |
| D15 **changed** | Link expiry defaults to 7 days but is **owner-configurable per link** (choices, absolute date shown, Renew). The server enforces the bounds. |

## Delivery

- PR 1: backend and realtime auth. PR 2: UI and flows (waits for Max's OK under `hold.paths`).
  PR 3: privacy and legal docs.
- Everything sits behind `VITE_FEATURE_SHARE_V2` and the `SHARE_V2_ENABLED` server switch, OFF by
  default. Production stays off until Max says so. Agents set no hosted secrets, config or migrations.
