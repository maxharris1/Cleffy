// Hit-tests the /try pager and zoom buttons under each bottom overlay, and
// under the drawing hint and value card together. Exits non-zero on any miss.
//
//   CLEFFY_UI_BASE=http://localhost:5173 node scripts/ui/phone-controls-hit.mjs
//
// Needs Vite serving the app (`npm run dev`): the ink notice is seeded by
// importing the app's own modules from the dev server. With --desktop it
// prints the boxes of the viewer chrome at 1280 × 800 instead, to compare
// two builds.
import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.CLEFFY_UI_BASE ?? 'http://localhost:5173';
const CONTROLS = ['Previous page', 'Next page', 'Zoom in', 'Zoom out'];
const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

const seedInkNotice = (page) =>
    page.evaluate(async () => {
        const recovery = await import('/src/sync/inkRecovery.ts');
        const { ScribblerDb } = await import('/src/sync/db.ts');
        const docId = 'c0ffee00-0000-4000-8000-0000000000f1';
        const at = '2026-10-22T00:00:00.000Z';
        const annotation = {
            id: 'probe-1',
            docId,
            page: 0,
            kind: 'stroke',
            color: '#111111',
            payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
            createdBy: null,
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
            seq: 0,
        };
        const close = recovery.rememberScoreSource(docId, 'Probe score', new ArrayBuffer(4));
        recovery.holdOps(new ScribblerDb(`probe-${crypto.randomUUID()}`), docId, [
            { op: { type: 'create', annotation }, author: 'probe-user' },
        ]);
        close();
        recovery.retireAccountInk('probe-user');
    });

const scale = (page) =>
    page.evaluate(async () => (await import('/src/state/store.ts')).useViewerStore.getState().view.scale);

const SCENARIOS = {
    card: { hint: false, card: true, ink: false },
    'ink notice': { hint: false, card: false, ink: true },
    'hint + card': { hint: true, card: true, ink: false },
};

const open = async (browser, viewport, scenario) => {
    const context = await browser.newContext({ viewport, ...PHONE });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${BASE}/try`);
    await page.getByRole('button', { name: 'Next page' }).waitFor();
    await page.getByText(/^p\. 1 \/ \d+$/).waitFor();
    if (!scenario.hint) {
        await page.locator('.demo-hint').getByRole('button', { name: 'Dismiss' }).click();
    }
    if (scenario.ink) {
        await seedInkNotice(page);
        await page.getByText(/unsaved ink is still on this device/).waitFor();
    }
    if (scenario.card) {
        await page.clock.fastForward(26_000);
        await page.getByRole('dialog', { name: 'What Cleffy does' }).waitFor();
    }
    await page.waitForTimeout(600);
    return { context, page };
};

const hitTest = (page) =>
    page.evaluate((labels) => {
        const describe = (el) => {
            if (!el) {
                return 'nothing';
            }
            const owner = el.closest('[aria-label], [role="dialog"], .demo-hint, [role="alert"]');
            return `${el.tagName.toLowerCase()} in ${owner?.getAttribute('aria-label') ?? owner?.className.split(' ')[0] ?? el.className}`;
        };
        return labels.map((label) => {
            const button = document.querySelector(`button[aria-label="${label}"]`);
            const box = button.getBoundingClientRect();
            const x = Math.round(box.left + box.width / 2);
            const y = Math.round(box.top + box.height / 2);
            const hit = document.elementFromPoint(x, y);
            return { label, x, y, ok: !!hit && button.contains(hit), hit: describe(hit) };
        });
    }, CONTROLS);

const phone = async (browser) => {
    let misses = 0;
    for (const height of [844, 480]) {
        for (const [name, scenario] of Object.entries(SCENARIOS)) {
            const { context, page } = await open(browser, { width: 390, height }, scenario);
            const clearance = await page.evaluate(() =>
                window.getComputedStyle(document.documentElement).getPropertyValue('--toolbar-bottom-clearance'),
            );
            for (const row of await hitTest(page)) {
                misses += row.ok ? 0 : 1;
                console.log(
                    `390x${height} clearance=${clearance.trim()} ${name.padEnd(11)} ${row.label.padEnd(13)} (${row.x}, ${row.y}) ${row.ok ? 'OK' : `MISS: ${row.hit}`}`,
                );
            }
            if (height === 480 && name === 'hint + card') {
                await page.getByRole('button', { name: 'Next page' }).click();
                const label = await page.getByText(/^p\. \d+ \/ \d+$/).textContent();
                const before = await scale(page);
                await page.getByRole('button', { name: 'Zoom in' }).click();
                await page.waitForTimeout(600);
                const after = await scale(page);
                const advanced = label.startsWith('p. 2 /');
                const zoomed = after > before;
                misses += (advanced ? 0 : 1) + (zoomed ? 0 : 1);
                console.log(`390x480 hint + card: Next page -> "${label}" ${advanced ? 'OK' : 'MISS'}`);
                console.log(
                    `390x480 hint + card: Zoom in -> scale ${before.toFixed(3)} -> ${after.toFixed(3)} ${zoomed ? 'OK' : 'MISS'}`,
                );
            }
            await context.close();
        }
    }
    return misses;
};

const desktop = async (browser) => {
    for (const [name, scenario] of Object.entries({ card: SCENARIOS.card, 'hint + card': SCENARIOS['hint + card'] })) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.clock.install();
        await page.goto(`${BASE}/try`);
        await page.getByRole('button', { name: 'Next page' }).waitFor();
        if (!scenario.hint) {
            await page.locator('.demo-hint').getByRole('button', { name: 'Dismiss' }).click();
        }
        await page.clock.fastForward(26_000);
        await page.getByRole('dialog', { name: 'What Cleffy does' }).waitFor();
        await page.waitForTimeout(600);
        const boxes = await page.evaluate(() => {
            const box = (el) => {
                if (!el) {
                    return 'absent';
                }
                const r = el.getBoundingClientRect();
                return [r.left, r.top, r.width, r.height].map(Math.round).join(',');
            };
            return {
                header: box(document.querySelector('header')),
                hint: box(document.querySelector('.demo-hint')),
                card: box(document.querySelector('.demo-value-card')),
                pager: box(document.querySelector('button[aria-label="Next page"]')?.parentElement),
                zoom: box(document.querySelector('button[aria-label="Zoom in"]')?.parentElement),
            };
        });
        for (const [part, value] of Object.entries(boxes)) {
            console.log(`1280x800 ${name.padEnd(11)} ${part.padEnd(6)} ${value}`);
        }
        await context.close();
    }
    return 0;
};

const browser = await chromium.launch();
try {
    const misses = await (process.argv.includes('--desktop') ? desktop(browser) : phone(browser));
    console.log(misses === 0 ? 'all OK' : `${misses} miss(es)`);
    process.exitCode = misses === 0 ? 0 : 1;
} finally {
    await browser.close();
}
