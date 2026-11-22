// @vitest-environment node
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The QA seeded states (docs/qa-lane.md, "Seeded states") signed in through
 * the app's own login form in a real browser, then checked on the page they
 * land on: the library's scores and the plan in the account menu.
 *
 * Needs the app served against a freshly reset and seeded local stack. CI
 * runs it with CLEFFY_REQUIRE_LOCAL_DB=1; by hand, after
 * `npm run qa:boot` and `supabase db reset --local`:
 *
 *     CLEFFY_E2E_BASE=http://127.0.0.1:5173 npx vitest run tests/qa/qaSeedStatesLogin.test.ts
 */

const BASE = process.env.CLEFFY_E2E_BASE ?? '';
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';

if (REQUIRED && !BASE) {
    throw new Error('CLEFFY_REQUIRE_LOCAL_DB=1 but CLEFFY_E2E_BASE is missing');
}

const PASSWORD = 'cleffy-local-test';

const STATES = [
    { email: 'qa-new@cleffy.test', plan: 'Free', scores: [] },
    { email: 'qa-one-score@cleffy.test', plan: 'Free', scores: ['Satie — Gymnopédie No. 1'] },
    { email: 'qa-subscribed@cleffy.test', plan: 'Personal', scores: [] },
    { email: 'qa-lapsed@cleffy.test', plan: 'Free', scores: [] },
] as const;

describe.skipIf(!BASE)('QA seeded states sign in through the login form', () => {
    let browser: Browser;

    beforeAll(async () => {
        browser = await chromium.launch(
            process.env.CLEFFY_UI_CHROMIUM ? { executablePath: process.env.CLEFFY_UI_CHROMIUM } : {},
        );
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
    });

    it.each(STATES)(
        '$email lands on its library with the $plan plan',
        async (state) => {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            try {
                const page = await context.newPage();
                await page.goto(`${BASE}/login`);
                await page.getByLabel('Email').fill(state.email);
                await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
                await page.getByRole('button', { name: 'Log in' }).click();
                await page.waitForURL(/\/library$/, { timeout: 20_000 });

                if (state.scores.length === 0) {
                    await page.getByText('No scores yet').waitFor({ timeout: 20_000 });
                } else {
                    await page.getByText(`${state.scores.length} score`, { exact: true }).waitFor({ timeout: 20_000 });
                    for (const title of state.scores) {
                        await page.getByText(title).first().waitFor({ timeout: 20_000 });
                    }
                }

                await page.getByRole('button', { name: `Account menu (${state.email})` }).click();
                const menu = page.getByRole('menu');
                await menu.getByText(state.email).waitFor();
                await expect
                    .poll(async () => (await menu.textContent()) ?? '', { timeout: 20_000 })
                    .toContain(state.plan);
                const badge = menu.getByText(state.plan, { exact: true });
                expect(await badge.count()).toBe(1);
            } finally {
                await context.close();
            }
        },
        60_000,
    );
});
