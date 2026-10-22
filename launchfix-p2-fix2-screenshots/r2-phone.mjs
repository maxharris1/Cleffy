/* global IDBObjectStore, DOMException */
// Launchfix P2 fix round 2: the banner's new states (conflict, overflow) and
// the export menu's marks notice, on phones and desktop, in the running app.
// A full disk is simulated as in round 1 (IDBObjectStore.add throws for the
// outbox). "Another tab" is simulated by writing the mirror row through the
// app's own Dexie module; the registry bound by holding filler ops through the
// app's own inkRecovery module (the same module instances Vite serves the app).
import { open, login, audit, shot, close, BASE } from '/home/user/Cleffy/scripts/ui/uifuzz.mjs';

const VPS = (process.argv[2] ?? 'iphone-14,iphone-se,android-small,desktop-1440').split(',');
const results = {};

const bannerText = async (page) =>
    page
        .locator('[role="status"]')
        .first()
        .evaluate((el) => {
            const box = el.getBoundingClientRect();
            const shown = [...el.querySelectorAll('p span')]
                .filter((s) => getComputedStyle(s).display !== 'none')
                .map((s) => s.textContent)
                .join('');
            return { height: Math.round(box.height), shown, buttons: [...el.querySelectorAll('button')].map((b) => b.textContent) };
        });

const openLocalScore = async (page) => {
    await page.goto(`${BASE}/library`);
    const input = page.locator('label:has-text("Open locally without uploading") input[type=file]').first();
    await input.setInputFiles('/home/user/Cleffy/e2e-fixtures/test-score.pdf');
    await page.waitForURL(/\/doc\/local-/);
    await page.waitForSelector('canvas', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Pen' }).first().click();
};

const drawStroke = async (page, dy = 0) => {
    const vs = page.viewportSize();
    const x0 = vs.width * 0.3;
    const y0 = vs.height * 0.45 + dy;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + i * 10, y0 + (i % 2) * 15);
    await page.mouse.up();
    await page.waitForTimeout(600);
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
    const r = {};

    // 1. Conflict: a stroke is stored; its erase fails (Undo, disk full); "another tab" then stores a newer version.
    await openLocalScore(page);
    const docId = new URL(page.url()).pathname.split('/').pop();
    await drawStroke(page);
    await page.evaluate(() => (window.__full = true));
    await page.keyboard.press('Control+z');
    await page.locator('[role=\"status\"] p').filter({ hasText: /aren’t saved on this device|couldn’t be saved on this device/ }).first().waitFor({ timeout: 10000 });
    await page.evaluate(async (doc) => {
        const { getDb } = await import('/src/sync/db.ts');
        const db = getDb();
        const [row] = await db.annotations.where('docId').equals(doc).toArray();
        await db.annotations.put({ ...row, color: '#16a34a', deletedAt: null, updatedAt: new Date(Date.now() + 60000).toISOString(), pending: 1 });
        window.__full = false;
    }, docId);
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('button', { name: 'Dismiss' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    r.conflict = { banner: await bannerText(page), audit: await audit(page) };
    r.shotConflict = await shot(page, `banner-conflict-erase-${vp}`);

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForTimeout(400);

    // 2. A held recolour that a newer version overtook: drawable, so Export keeps it, and its menu says so.
    await page.evaluate(async (doc) => {
        const { getDb } = await import('/src/sync/db.ts');
        const { holdOps } = await import('/src/sync/inkRecovery.ts');
        const db = getDb();
        const [row] = await db.annotations.where('docId').equals(doc).toArray();
        const { pending: _pending, ...prev } = row;
        holdOps(db, doc, [
            { author: null, op: { type: 'update', annotation: { ...prev, color: '#dc2626', updatedAt: new Date().toISOString() }, prev } },
        ]);
        await db.annotations.put({ ...row, color: '#2563eb', updatedAt: new Date(Date.now() + 120000).toISOString(), pending: 1 });
    }, docId);
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.locator('[role=\"status\"] p').filter({ hasText: /Export keeps yours|Export a copy to keep yours/ }).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    r.conflictExportable = { banner: await bannerText(page), audit: await audit(page) };
    r.shotConflictExportable = await shot(page, `banner-conflict-exportable-${vp}`);
    await page.locator('[role="status"]').first().getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: /as photo/ }).click();
    await page.getByText(/changed elsewhere before it could be saved here/).waitFor({ timeout: 20000 });
    await page.waitForTimeout(400);
    r.exportNotice = { audit: await audit(page) };
    r.shotExportNotice = await shot(page, `export-conflict-notice-${vp}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForTimeout(400);

    // 3. Overflow: the registry is at its bound; a new failed stroke is not made, and the banner says so.
    await page.evaluate(async () => {
        const { holdOps, MAX_HELD_OPS } = await import('/src/sync/inkRecovery.ts');
        const { getDb } = await import('/src/sync/db.ts');
        const now = new Date().toISOString();
        holdOps(
            getDb(),
            'local-ui-filler',
            Array.from({ length: MAX_HELD_OPS }, (_, i) => ({
                author: null,
                op: {
                    type: 'create',
                    annotation: {
                        id: `filler-${i}`,
                        docId: 'local-ui-filler',
                        page: 0,
                        kind: 'stroke',
                        color: '#000000',
                        payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
                        createdBy: null,
                        createdAt: now,
                        updatedAt: now,
                        deletedAt: null,
                        seq: 0,
                    },
                },
            })),
        );
        window.__full = true;
    });
    await drawStroke(page, 60);
    await page.locator('[role=\"status\"] p').filter({ hasText: /new ones weren’t made|can’t keep any more unsaved marks/ }).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    r.overflow = { banner: await bannerText(page), audit: await audit(page) };
    r.shotOverflow = await shot(page, `banner-overflow-${vp}`);
    await page.evaluate(async () => {
        const { forgetDocInk } = await import('/src/sync/inkRecovery.ts');
        forgetDocInk('local-ui-filler');
        window.__full = false;
    });

    r.consoleErrors = consoleErrors;
    results[vp] = r;
    console.error('RESULT ' + JSON.stringify({ [vp]: r }));
    await context.close();
}
await close();
console.log(JSON.stringify(results, null, 2));
