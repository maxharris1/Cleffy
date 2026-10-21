/**
 * How much of this project's outbound mail the senders we CONTROL may spend —
 * and how much is held back for the mail a user is waiting on.
 *
 * NO runtime imports, for the usual reason (Deno wants the `.ts` extension,
 * vitest wants it gone): the env lookup arrives as an injected function, the
 * way `stripeMode.ts` takes one. `_shared/guestEmail.ts` cannot import this
 * either, so `guest-email-start/index.ts` — the Deno wiring, which can — reads
 * the limits from here and passes them into the handler through `deps`.
 *
 * ---------------------------------------------------------------------------
 * The problem this exists for
 * ---------------------------------------------------------------------------
 * Every email this project sends leaves through one Resend account, on one API
 * key, from one verified domain — and by two different routes:
 *
 *  * GoTrue sends password resets and sign-up confirmations over Resend SMTP.
 *    Those are the mails a human is sitting in front of their inbox waiting
 *    for, and the ones whose absence locks somebody out of their account.
 *  * Our own Edge Functions send through the Resend HTTP API — the guest-email
 *    verification code (`_shared/guestEmail.ts`), the content-report and
 *    moderation notices (`_shared/contentReports.ts`), the billing cancel link
 *    and purchase/cancellation confirmations (`_shared/billingMail.ts`), and
 *    the district retention notice (`district-retention-notices`). Nobody is
 *    locked out when one of those is delayed.
 *
 * The second kind is discretionary and the first is not, but until this module
 * existed nothing said so. `GUEST_EMAIL_LIMITS` carried the bare numbers 60/h
 * and 300/day with a comment admitting these mails "share the Resend key, quota
 * and domain reputation with password resets and sign-ups" — a correct
 * observation with nothing enforcing anything about it. A future sender added
 * with its own generous literal, or a raise to the guest-email ceiling, would
 * eat the reset budget silently, and the symptom would be a user who cannot
 * reset their password and no error anywhere that says why.
 *
 * So: a budget per window, a RESERVE carved out of it for auth mail that no
 * discretionary sender may consume, and a per-category cap for each sender we
 * control. `mailBudgetProblems()` states the invariant — the caps may add up to
 * at most budget minus reserve — and `tests/security/mailBudget.test.ts` fails
 * CI when they do not. That invariant, not the budget number, is the point of
 * this file: it holds whatever the real quota turns out to be.
 *
 * ---------------------------------------------------------------------------
 * What the numbers are and are not
 * ---------------------------------------------------------------------------
 * `DEFAULT_MAIL_BUDGET` is an ASSUMPTION, not a reading. The Resend plan's
 * actual monthly and daily ceiling is visible only in the Resend dashboard;
 * the Supabase secrets API exposes `RESEND_API_KEY` by name and hash only, so
 * it cannot be derived from this repo or from the project config. The figures
 * below were reverse-engineered from the guest-email literals they replace —
 * 60/hour and 300/day — by asking what whole budget those numbers would be a
 * sane discretionary share of. They are deliberately the same size as before,
 * so this change moves no behaviour.
 *
 * **Max must confirm or correct `DEFAULT_MAIL_BUDGET` against the Resend
 * plan.** Changing it is the only edit that needs making: the caps are clamped
 * to whatever is left after the reserve (see `mailLimit`), so lowering the
 * budget narrows the senders we control and never the reserve. It can also be
 * set per project without a deploy, through the env names in `MAIL_BUDGET_ENV`.
 *
 * Two other knobs are his and live outside this repo, and neither is a
 * substitute for the reserve:
 *  * the Resend plan's monthly quota — the hard ceiling everything shares;
 *  * `rate_limit_email_sent` per Supabase project (production: 100/hour) —
 *    GoTrue's OWN hourly ceiling, which bounds resets and confirmations
 *    TOGETHER and cannot be split between them by anything in our code. That
 *    is the limit of this approach, and why the Turnstile gate on sign-up
 *    matters: it is what stops sign-up abuse burning the ceiling resets share.
 */

/** A ceiling and the window it is counted over — the shape `checkRateLimit` takes. */
export interface MailWindow {
    limit: number;
    windowMs: number;
}

export const MAIL_WINDOW_MS = {
    hour: 60 * 60_000,
    day: 24 * 60 * 60_000,
} as const;

export type MailWindowName = keyof typeof MAIL_WINDOW_MS;

/** `Deno.env.get`, or a plain object lookup under test. */
export type EnvLookup = (name: string) => string | undefined;

export const MAIL_WINDOWS: readonly MailWindowName[] = ['hour', 'day'];

/** The project's whole mail allowance per window. An assumption — see the header. */
export const DEFAULT_MAIL_BUDGET: Record<MailWindowName, number> = {
    hour: 100,
    day: 500,
};

/** Per-project override, so a corrected figure needs no deploy. */
export const MAIL_BUDGET_ENV: Record<MailWindowName, string> = {
    hour: 'MAIL_BUDGET_PER_HOUR',
    day: 'MAIL_BUDGET_PER_DAY',
};

/**
 * Held back for auth mail — password resets and sign-up confirmations — and
 * never spendable by anything in `MAIL_CATEGORY_CAPS`.
 *
 * Sized against the kind of load the reserved mail actually has: resets and
 * confirmations are one-per-person events, so 40 an hour is a busy signup day
 * for a studio-scale product, while the discretionary senders are the ones an
 * attacker can aim in volume. Note this is NOT a counter we increment — no
 * reset is ever refused for being "over the reserve". It is subtracted from
 * what the other senders may claim, which is the only way round that works:
 * GoTrue sends its own mail and will not ask us first.
 */
export const AUTH_MAIL_RESERVE: Record<MailWindowName, number> = {
    hour: 40,
    day: 200,
};

/**
 * The launch mail split: every sender we control, and what each may spend per
 * window. Binding (Max, October 2026), and the ONE place these numbers live.
 *
 * The launch PRs (#63 legal pages, #62 checkout, #64 consent) merge separately
 * but spend one budget, so this file is byte-identical on all three: checkout
 * (#62) owns it and the others copy it from origin/mh/launch-checkout. A
 * category whose sender is not on a branch yet keeps its entry anyway, which is
 * what keeps the merged total what each branch tests:
 *
 *     guestEmailCode          28/150  guest and automated: share-link codes
 *     contentReportAck         8/35   legal: report acknowledgments (#63)
 *     moderationNotice         4/20   legal: statements of reasons (#63)
 *     billingCancelLink        8/40   transactional: signed-out cancel link (#62)
 *     billingConfirmation      7/30   transactional: purchase and cancellation
 *                                     confirmations (#62)
 *     retentionNotice          5/25   legal: district export notice before purge (#64)
 *                             ------
 *                             60/300  = budget 100/500 minus the 40/200 reserve
 *
 * Adding a sender is the whole registration step, and no sender sends outside
 * one: if the total then exceeds budget minus reserve,
 * `tests/security/mailBudget.test.ts` fails rather than the reset budget
 * quietly shrinking. A sender whose window is spent waits (its outbox retries
 * when the window reopens); it never sends past it.
 */
export const LAUNCH_MAIL_SPLIT = {
    /**
     * `guest-email-start`: the one-time code a share-link guest proves an
     * address with — the guest and automated mail, which anyone can trigger.
     * 60/300 until October 2026, when the legal and transactional senders
     * needed room.
     */
    guestEmailCode: { hour: 28, day: 150 },
    /**
     * `content-report`: the acknowledgment a reporter gets, blind-copied to the
     * legal mailbox. The endpoint is open to anyone, so it is the aimable one.
     */
    contentReportAck: { hour: 8, day: 35 },
    /**
     * `content-moderation`: statements of reasons and decisions mailed after a
     * moderator acts. Moderator-initiated, so a handful a day; capped anyway so
     * a runaway client cannot spend the reserve.
     */
    moderationNotice: { hour: 4, day: 20 },
    /**
     * `billing-cancel`: the signed-out "cancel my subscription" link, queued in
     * the billing mail outbox and sent when the window has room.
     */
    billingCancelLink: { hour: 8, day: 40 },
    /**
     * The purchase and cancellation confirmations the webhook queues in the
     * billing mail outbox. One per Stripe event; a confirmation the window
     * holds back stays queued and goes out when it reopens, never dropped.
     */
    billingConfirmation: { hour: 7, day: 30 },
    /**
     * `district-retention-notices`: the 14-day export notice a district owner
     * gets before its data is purged. Deferred, never dropped, when spent.
     */
    retentionNotice: { hour: 5, day: 25 },
} as const;

/** The caps the budget functions below read: the launch split. */
export const MAIL_CATEGORY_CAPS = LAUNCH_MAIL_SPLIT;

export type MailCategory = keyof typeof MAIL_CATEGORY_CAPS;

export const MAIL_CATEGORIES = Object.keys(MAIL_CATEGORY_CAPS) as MailCategory[];

const noEnv: EnvLookup = () => undefined;

/**
 * The configured budget for a window. A value that is not a positive whole
 * number is ignored rather than guessed at: a typo'd override must not quietly
 * become a ceiling of zero (which would stop every guest upgrade) or of
 * Infinity (which would make the reserve meaningless).
 */
export const mailBudget = (window: MailWindowName, env: EnvLookup = noEnv): number => {
    const raw = env(MAIL_BUDGET_ENV[window])?.trim();
    if (raw) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_MAIL_BUDGET[window];
};

/** What is left for the senders we control once the reserve is taken out. */
export const discretionaryMailBudget = (window: MailWindowName, env: EnvLookup = noEnv): number =>
    Math.max(0, mailBudget(window, env) - AUTH_MAIL_RESERVE[window]);

/** What the declared caps add up to for a window. */
export const allocatedMailCaps = (window: MailWindowName): number =>
    MAIL_CATEGORIES.reduce((total, category) => total + MAIL_CATEGORY_CAPS[category][window], 0);

/**
 * The invariant, as a list of sentences — empty when it holds.
 *
 * Returned rather than thrown so the test can print exactly which window
 * over-allocates and by how much, and so importing this module can never take
 * a function down at boot.
 */
export const mailBudgetProblems = (env: EnvLookup = noEnv): string[] => {
    const problems: string[] = [];
    for (const window of MAIL_WINDOWS) {
        const allocated = allocatedMailCaps(window);
        const available = discretionaryMailBudget(window, env);
        if (allocated > available) {
            problems.push(
                `per ${window}: the mail categories allocate ${allocated}, but only ${available} is available ` +
                    `(budget ${mailBudget(window, env)} minus the ${AUTH_MAIL_RESERVE[window]} reserved for auth mail)`,
            );
        }
    }
    return problems;
};

/**
 * What one category may actually spend — its declared cap, clamped to its
 * pro-rata share of what the reserve leaves.
 *
 * The clamp is what makes a corrected (or mistyped-small) budget safe: with a
 * budget BELOW the declared caps the senders we control are narrowed in
 * proportion and the reserve is still whole, rather than the first sender to
 * ask taking everything and resets being the thing that stops working. With
 * the declared budget the clamp is inert — the caps are sized to fit — and
 * `tests/security/mailBudget.test.ts` is what keeps it that way.
 */
export const mailLimit = (category: MailCategory, window: MailWindowName, env: EnvLookup = noEnv): MailWindow => {
    const cap = MAIL_CATEGORY_CAPS[category][window];
    const allocated = allocatedMailCaps(window);
    const available = discretionaryMailBudget(window, env);
    const share = allocated > available ? Math.floor((available * cap) / allocated) : cap;
    return { limit: Math.max(0, Math.min(cap, share)), windowMs: MAIL_WINDOW_MS[window] };
};
