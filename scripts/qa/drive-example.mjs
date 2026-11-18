import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

const APP_URL = process.env.CLEFFY_QA_APP_URL ?? 'http://127.0.0.1:5173';
const EVIDENCE_DIR = process.env.CLEFFY_QA_EVIDENCE_DIR ?? '/tmp/cleffy-qa-evidence/drive-example';
const EMAIL = 'qa-new@cleffy.test';
const PASSWORD = 'cleffy-local-test';
const TIMEOUT = 20_000;

const evidence = (name) => join(EVIDENCE_DIR, name);
const step = (message) => console.log(`[drive-example] ${message}`);

const fullyOpaque = (element) => {
    for (let node = element; node; node = node.parentElement) {
        if (window.getComputedStyle(node).opacity !== '1') return false;
    }
    return true;
};

// Visible is not enough: a fading-in element is visible at opacity 0.1, and a
// screenshot taken then shows a ghost of the screen.
const settle = async (locator) => {
    await locator.waitFor({ state: 'visible', timeout: TIMEOUT });
    const deadline = Date.now() + TIMEOUT;
    while (!(await locator.evaluate(fullyOpaque, undefined, { timeout: TIMEOUT }))) {
        if (Date.now() > deadline) throw new Error(`${locator} still not fully opaque after ${TIMEOUT}ms`);
        await locator.page().waitForTimeout(100);
    }
};

mkdirSync(EVIDENCE_DIR, { recursive: true });
const result = { scenario: 'sign-in-new-user' };
let browser;
let page;

try {
    browser = await chromium.launch(
        process.env.CLEFFY_UI_CHROMIUM ? { executablePath: process.env.CLEFFY_UI_CHROMIUM } : {},
    );
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    step(`open ${APP_URL}/login`);
    await page.goto(`${APP_URL}/login`);
    step(`fill credentials for ${EMAIL}`);
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    const logIn = page.getByRole('button', { name: 'Log in' });
    await settle(logIn);
    await page.screenshot({ path: evidence('before.png') });

    step('click Log in');
    await logIn.click();
    await page.waitForURL(/\/library$/, { timeout: TIMEOUT });
    step(`landed on ${page.url()}`);
    const emptyLibrary = page.getByText('No scores yet');
    const accountMenu = page.getByRole('button', { name: `Account menu (${EMAIL})` });
    await settle(emptyLibrary);
    await settle(accountMenu);
    step('empty library and account menu settled');
    await page.screenshot({ path: evidence('after.png') });

    Object.assign(result, {
        url: page.url(),
        emptyLibraryText: (await emptyLibrary.textContent())?.trim(),
        accountMenuLabel: await accountMenu.getAttribute('aria-label'),
        pass: true,
    });
} catch (error) {
    step(`FAILED: ${error.message}`);
    await page?.screenshot({ path: evidence('failure.png') }).catch(() => {});
    Object.assign(result, { url: page?.url(), pass: false, error: error.message });
    process.exitCode = 1;
} finally {
    writeFileSync(evidence('result.json'), `${JSON.stringify(result, null, 2)}\n`);
    await browser?.close();
}

step(`${result.pass ? 'PASS' : 'FAIL'} evidence in ${EVIDENCE_DIR}`);
for (const name of result.pass ? ['before.png', 'after.png', 'result.json'] : ['failure.png', 'result.json']) {
    console.log(`  ${evidence(name)}`);
}
