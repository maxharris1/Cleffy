/* global getComputedStyle, IDBObjectStore, DOMException */
import { open, login, audit, shot, close, BASE } from '/home/user/Cleffy/scripts/ui/uifuzz.mjs';

const VPS = (process.argv[2] ?? 'iphone-14,iphone-se,android-small').split(',');
const results = {};

const measure = async (page) => {
    const banner = page
        .locator('[role="status"]')
        .filter({ hasText: /saved|save/ })
        .first();
    const box = await banner.boundingBox();
    const text = banner.locator('p');
    const lines = await text.evaluate((p) => {
        const lh = parseFloat(getComputedStyle(p).lineHeight);
        return Math.round(p.getBoundingClientRect().height / lh);
    });
    const shown = await text.evaluate((p) =>
        [...p.querySelectorAll('span')]
            .filter((s) => getComputedStyle(s).display !== 'none')
            .map((s) => s.textContent)
            .join(''),
    );
    return { height: Math.round(box?.height ?? 0), textLines: lines, shown };
};

for (const vp of VPS) {
    const { page, context, consoleErrors } = await open(vp);
    await context.addInitScript(() => {
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
            if (window.__full && this.name === 'ops') {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            return add.apply(this, args);
        };
    });
    await login(page);
    await page.goto(`${BASE}/library`);
    const input = page.locator('label:has-text("Open locally without uploading") input[type=file]').first();
    await input.setInputFiles('/home/user/Cleffy/e2e-fixtures/test-score.pdf');
    await page.waitForURL(/\/doc\/local-/);
    const docUrl = page.url();
    await page.waitForSelector('canvas', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Pen' }).first().click();
    await page.evaluate(() => (window.__full = true));
    const vs = page.viewportSize();
    const x0 = vs.width * 0.3,
        y0 = vs.height * 0.45;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + i * 10, y0 + (i % 2) * 15);
    await page.mouse.up();
    await page
        .getByText(/aren’t saved on this device|couldn’t be saved on this device/)
        .first()
        .waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);
    const r = { banner: await measure(page), audit: await audit(page) };
    r.shotBanner = await shot(page, `banner-${vp}`);

    await page.getByRole('button', { name: 'Retry' }).click();
    await page
        .getByText(/Still not saved/)
        .first()
        .waitFor({ timeout: 10000 });
    r.retryFailed = await measure(page);
    r.shotRetryFailed = await shot(page, `banner-retry-failed-${vp}`);

    // Leave the score and open it again in the same tab: a new viewer and store.
    await page.goBack();
    await page.waitForURL(/\/library/);
    await page.waitForTimeout(800);
    await page.goForward();
    await page.waitForURL(docUrl);
    await page.waitForSelector('canvas', { timeout: 30000 });
    await page
        .getByText(/aren’t saved on this device|couldn’t be saved on this device/)
        .first()
        .waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    r.reopened = await measure(page);
    r.shotReopened = await shot(page, `banner-reopened-${vp}`);

    await page.evaluate(() => (window.__full = false));
    await page.getByRole('button', { name: 'Retry' }).click();
    await page
        .locator('[role="status"]')
        .filter({ hasText: /saved/ })
        .first()
        .waitFor({ state: 'detached', timeout: 10000 });
    r.shotCleared = await shot(page, `banner-cleared-${vp}`);
    r.consoleErrors = consoleErrors;
    results[vp] = r;
    await context.close();
}
await close();
console.log(JSON.stringify(results, null, 2));
