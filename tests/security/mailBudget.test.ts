// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUEST_EMAIL_LIMITS } from '../../supabase/functions/_shared/guestEmail';
import {
    allocatedMailCaps,
    AUTH_MAIL_RESERVE,
    BILLING_CANCEL_SHARE,
    DEFAULT_MAIL_BUDGET,
    discretionaryMailBudget,
    GUEST_AND_AUTOMATED_MAIL_CAP,
    MAIL_BUDGET_ENV,
    MAIL_CATEGORIES,
    MAIL_CATEGORY_CAPS,
    MAIL_WINDOW_MS,
    MAIL_WINDOWS,
    mailBudget,
    mailBudgetProblems,
    mailLimit,
    type EnvLookup,
} from '../../supabase/functions/_shared/mailBudget';

/**
 * The reserve held back for auth mail, and the invariant that keeps it whole.
 *
 * This file is the deliverable, not the numbers it checks. Password resets and
 * sign-up confirmations are mail somebody is locked out of their account
 * without; the guest-email code is mail nobody is waiting on. They leave
 * through one Resend account on one key from one domain, so the second kind can
 * eat the first kind's quota — and before mailBudget.ts existed, nothing said
 * how much of the budget was the first kind's. The failure mode is silent: a
 * raised ceiling or a newly added sender, and then a user who cannot reset
 * their password and no error anywhere that explains why.
 *
 * So the test that matters is the first one. An edit that over-allocates fails
 * CI instead.
 */

const env =
    (values: Record<string, string>): EnvLookup =>
    (name) =>
        values[name];

describe('the auth-mail reserve', () => {
    it('cannot be allocated to the senders we control', () => {
        // THE invariant. If this fails, the fix is to lower a cap in
        // MAIL_CATEGORY_CAPS or raise DEFAULT_MAIL_BUDGET to the plan's real
        // quota — never to shrink AUTH_MAIL_RESERVE to make room, which is
        // exactly the silent trade this module exists to prevent.
        expect(mailBudgetProblems()).toEqual([]);

        for (const window of MAIL_WINDOWS) {
            expect(allocatedMailCaps(window), window).toBeLessThanOrEqual(discretionaryMailBudget(window));
        }
    });

    it('says which window over-allocates and by how much, rather than just failing', () => {
        // Proving the guard really catches it — the assertion above only shows
        // today's numbers are fine. A budget of 50/hour leaves 10 after the
        // 40 reserved, and the 60 the caps add up to does not fit in 10.
        const tight = env({ [MAIL_BUDGET_ENV.hour]: '50' });
        const problems = mailBudgetProblems(tight);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('per hour');
        expect(problems[0]).toContain(String(allocatedMailCaps('hour')));
        expect(problems[0]).toContain(String(AUTH_MAIL_RESERVE.hour));
    });

    it('is kept whole by narrowing the discretionary senders, never the other way round', () => {
        // The clamp in mailLimit(). With a budget below the declared caps —
        // which is what a corrected, smaller Resend quota looks like — the
        // senders we control are cut down and the reserve still stands. The
        // alternative is the first sender to ask taking everything, and
        // password resets being the thing that stops working.
        const tight = env({ [MAIL_BUDGET_ENV.hour]: '50' });
        const allowed = MAIL_CATEGORIES.reduce(
            (total, category) => total + mailLimit(category, 'hour', tight).limit,
            0,
        );
        expect(allowed).toBeLessThanOrEqual(discretionaryMailBudget('hour', tight));
        expect(mailBudget('hour', tight) - allowed).toBeGreaterThanOrEqual(AUTH_MAIL_RESERVE.hour);
    });

    it('holds for a budget of any size, including one smaller than the reserve', () => {
        for (const budget of ['1', '5', '40', '41', '99', '100', '1000']) {
            const lookup = env({ [MAIL_BUDGET_ENV.hour]: budget });
            const allowed = MAIL_CATEGORIES.reduce(
                (total, category) => total + mailLimit(category, 'hour', lookup).limit,
                0,
            );
            // Never negative, never into the reserve, never above the cap.
            expect(allowed, budget).toBeGreaterThanOrEqual(0);
            expect(allowed, budget).toBeLessThanOrEqual(discretionaryMailBudget('hour', lookup));
            expect(allowed, budget).toBeLessThanOrEqual(allocatedMailCaps('hour'));
        }
    });

    it('reserves something in every window, or it is not a reserve', () => {
        for (const window of MAIL_WINDOWS) {
            expect(AUTH_MAIL_RESERVE[window], window).toBeGreaterThan(0);
            expect(AUTH_MAIL_RESERVE[window], window).toBeLessThan(DEFAULT_MAIL_BUDGET[window]);
        }
    });
});

describe('the split between the launch senders', () => {
    it('holds the guest and automated mail to its cap (about 35/hour, 190/day)', () => {
        for (const window of MAIL_WINDOWS) {
            expect(MAIL_CATEGORY_CAPS.guestEmailCode[window], window).toBeLessThanOrEqual(
                GUEST_AND_AUTOMATED_MAIL_CAP[window],
            );
        }
        expect(GUEST_AND_AUTOMATED_MAIL_CAP).toEqual({ hour: 35, day: 190 });
    });

    it('leaves the signed-out cancel link (#62) its share, so both PRs together fit 60/300', () => {
        // #62 registers billingCancelLink in MAIL_CATEGORY_CAPS; until it does,
        // its share must still be free, or the merge would over-allocate.
        const claimed = (window: (typeof MAIL_WINDOWS)[number]): number =>
            allocatedMailCaps(window) + ('billingCancelLink' in MAIL_CATEGORY_CAPS ? 0 : BILLING_CANCEL_SHARE[window]);
        for (const window of MAIL_WINDOWS) {
            expect(claimed(window), window).toBeLessThanOrEqual(discretionaryMailBudget(window));
        }
        expect(discretionaryMailBudget('hour')).toBe(60);
        expect(discretionaryMailBudget('day')).toBe(300);
    });
});

describe('the budget override', () => {
    it('ignores a value that is not a positive whole number', () => {
        // A typo must not quietly become a ceiling of zero — which would stop
        // every guest upgrade — or of Infinity, which would make the reserve
        // decorative.
        for (const raw of ['', ' ', '0', '-10', 'lots', '12.5', 'NaN', 'Infinity', '1e3x']) {
            expect(mailBudget('hour', env({ [MAIL_BUDGET_ENV.hour]: raw })), raw).toBe(DEFAULT_MAIL_BUDGET.hour);
        }
        expect(mailBudget('hour', env({ [MAIL_BUDGET_ENV.hour]: '250' }))).toBe(250);
    });

    it('is per window, and names variables that do not collide with anything', () => {
        expect(new Set(Object.values(MAIL_BUDGET_ENV)).size).toBe(MAIL_WINDOWS.length);
        for (const name of Object.values(MAIL_BUDGET_ENV)) {
            expect(name).toMatch(/^MAIL_BUDGET_PER_(HOUR|DAY)$/);
        }
    });
});

describe('guest-email derives its ceilings from the budget', () => {
    it('no longer carries global literals of its own', () => {
        // The two keys that used to hold 60 and 300 are gone from
        // GUEST_EMAIL_LIMITS; the handler takes them through `deps.mailBudget`
        // instead, wired from mailLimit() in guest-email-start/index.ts.
        // (guestEmail.ts takes no runtime imports, so it cannot read
        // mailBudget.ts directly — see its note.)
        expect(GUEST_EMAIL_LIMITS).not.toHaveProperty('startGlobal');
        expect(GUEST_EMAIL_LIMITS).not.toHaveProperty('startGlobalDaily');
        // The limits that are genuinely this flow's — per IP, per guest, per
        // mailbox — stay where they were: they protect a person, not a quota.
        for (const key of ['startPerIp', 'startPerUser', 'startPerRecipient', 'startPerRecipientDaily'] as const) {
            expect(GUEST_EMAIL_LIMITS[key].limit).toBeGreaterThan(0);
        }
    });

    it('gets its declared cap in full: the clamp is inert at the declared budget', () => {
        // The same size as the literals this module replaced (60/300) until the
        // legal and transactional senders needed room in October 2026 — a
        // deliberate retune, pinned here so the next one is too.
        expect(mailLimit('guestEmailCode', 'hour')).toEqual({ limit: 35, windowMs: MAIL_WINDOW_MS.hour });
        expect(mailLimit('guestEmailCode', 'day')).toEqual({ limit: 190, windowMs: MAIL_WINDOW_MS.day });
        expect(mailLimit('contentReportAck', 'hour').limit).toBe(MAIL_CATEGORY_CAPS.contentReportAck.hour);
        expect(mailLimit('moderationNotice', 'day').limit).toBe(MAIL_CATEGORY_CAPS.moderationNotice.day);
    });

    it('counts over windows a rate limiter can actually use', () => {
        expect(MAIL_WINDOW_MS.hour).toBe(60 * 60_000);
        expect(MAIL_WINDOW_MS.day).toBe(24 * 60 * 60_000);
        for (const window of MAIL_WINDOWS) {
            for (const category of MAIL_CATEGORIES) {
                const limit = mailLimit(category, window);
                expect(limit.windowMs, `${category}/${window}`).toBe(MAIL_WINDOW_MS[window]);
                expect(Number.isInteger(limit.limit), `${category}/${window}`).toBe(true);
            }
        }
    });

    it('lets a day hold more than an hour, for every declared sender', () => {
        for (const category of MAIL_CATEGORIES) {
            expect(MAIL_CATEGORY_CAPS[category].day, category).toBeGreaterThan(MAIL_CATEGORY_CAPS[category].hour);
        }
    });
});

describe('the module stays loadable by the edge runtime', () => {
    it('takes no runtime imports, which is why env arrives as a function', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/mailBudget.ts'), 'utf8');
        expect((source.match(/^import .*$/gm) ?? []).filter((line) => !line.startsWith('import type'))).toEqual([]);
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toContain('Deno.');
    });

    it('states that the budget is an assumption, so nobody reads it as a measurement', () => {
        // The Resend plan's real quota is not visible from this repo. The
        // honest thing is to say so where the number lives, and the PR asks
        // Max to confirm it — the invariant above is what holds either way.
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/mailBudget.ts'), 'utf8');
        expect(source).toMatch(/ASSUMPTION/);
        expect(source).toContain('rate_limit_email_sent');
    });
});
