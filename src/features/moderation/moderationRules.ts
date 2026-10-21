/**
 * The numbers the Copyright and Content Policy promises and the moderation
 * tooling applies. Import-free, so the policy text, the admin page and the
 * Edge Functions' mirror (supabase/functions/_shared/contentReports.ts) can
 * all read them; tests/moderation/contentReports.test.ts holds the mirror equal.
 */

/** Active copyright strikes at which an account is considered for closing. */
export const REPEAT_INFRINGER_STRIKES = 3;

/** How far back a strike counts. */
export const STRIKE_WINDOW_MONTHS = 12;
