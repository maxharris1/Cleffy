/* global IDBObjectStore, DOMException */
// Launchfix P2 fix round 3: the conflict banner's Dismiss / Discard (and Export
// for an overtaken erase), and the new app-wide signed-out-ink banner after a
// real sign-out in another tab, on phones and desktop, in the running app.
// A full disk is simulated as in rounds 1–2 (IDBObjectStore.add throws for the
// outbox), so nothing reaches the server. "Another tab" is a second page in
// the same browser context calling the app's own signOut().
import { readFileSync } from 'node:fs';

import { open, login, audit, shot, close, BASE } from '/home/user/Cleffy/scripts/ui/uifuzz.mjs';

const VPS = (process.argv[2] ?? 'iphone-14,iphone-se,android-small,desktop-1440').split(',');
const results = {};

const stripOf = async (page, selector = '[role="status"]') =>
    page
        .locator(selector)
        .first()
        .evaluate((el) => {
            const box = el.getBoundingClientRect();
            const shown = [...el.querySelectorAll('p span')]
                .filter((s) => getComputedStyle(s).display !== 'none')
                .map((s) => s.textContent)
                .join('');
            return {
                top: Math.round(box.top),
                height: Math.round(box.height),
                width: Math.round(box.width),
                shown,
                buttons: [...el.querySelectorAll('button')].map((b) => b.textContent),
            };
        });

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

const failingDisk = () => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
        if (window.__full && this.name === 'ops') {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return add.apply(this, args);
    };
};

for (const vp of VPS) {
    const r = {};
    // ---- A. Conflict banner on a device-only score: an overtaken erase.
    {
        const { page, context, consoleErrors } = await open(vp);
        await context.addInitScript(failingDisk);
        await login(page);
        await page.goto(`${BASE}/library`);
        await page
            .locator('label:has-text("Open locally without uploading") input[type=file]')
            .first()
            .setInputFiles('/home/user/Cleffy/e2e-fixtures/test-score.pdf');
        await page.waitForURL(/\/doc\/local-/);
        await page.waitForSelector('canvas', { timeout: 30000 });
        await page.waitForTimeout(2500);
        await page.getByRole('button', { name: 'Pen' }).first().click();
        const docId = new URL(page.url()).pathname.split('/').pop();
        await drawStroke(page);
        await page.evaluate(() => (window.__full = true));
        await page.keyboard.press('Control+z');
        await page.locator('[role="status"] p').filter({ hasText: /saved on this device/ }).first().waitFor({ timeout: 10000 });
        await page.evaluate(async (doc) => {
            const { getDb } = await import('/src/sync/db.ts');
            const db = getDb();
            const [row] = await db.annotations.where('docId').equals(doc).toArray();
            await db.annotations.put({ ...row, color: '#16a34a', deletedAt: null, updatedAt: new Date(Date.now() + 60000).toISOString(), pending: 1 });
            window.__full = false;
        }, docId);
        await page.getByRole('button', { name: 'Retry' }).click();
        await page.getByRole('button', { name: 'Discard' }).waitFor({ timeout: 10000 });
        await page.waitForTimeout(800);
        r.conflictErase = { banner: await stripOf(page), audit: await audit(page) };
        r.shotConflictErase = await shot(page, `banner-conflict-erase-${vp}`);

        await page.locator('[role="status"]').first().getByRole('button', { name: 'Discard' }).click();
        await page.getByRole('dialog', { name: 'Discard your unsaved versions?' }).waitFor();
        await page.waitForTimeout(400);
        r.discardDialog = { audit: await audit(page) };
        r.shotDiscardDialog = await shot(page, `conflict-discard-confirm-${vp}`);
        await page.getByRole('button', { name: 'Cancel' }).click();

        await page.getByRole('button', { name: 'Dismiss' }).click();
        await page.waitForTimeout(500);
        r.afterDismiss = {
            bannerGone: (await page.getByRole('button', { name: 'Dismiss' }).count()) === 0,
            conflictsKept: await page.evaluate(async (doc) => {
                const { heldInkForExport } = await import('/src/sync/inkRecovery.ts');
                return heldInkForExport(null, doc).conflicts.length;
            }, docId),
        };
        r.consoleErrorsA = consoleErrors;
        await context.close();
    }

    // ---- B. Signed out in another tab while this tab holds ink on a cloud score.
    {
        const { page, context, consoleErrors } = await open(vp);
        await context.addInitScript(failingDisk);
        await login(page);
        // The seeded cloud scores' PDFs do not load on the local stack, so the
        // held ink is put on a seeded score through the app's own inkRecovery
        // module, with the fixture PDF as the viewer would have registered it.
        await page.goto(`${BASE}/library`);
        const href = await page.locator('a[href^="/doc/"]').first().getAttribute('href', { timeout: 20000 });
        const cloudDoc = href.split('/').pop();
        const pdf = [...readFileSync('/home/user/Cleffy/e2e-fixtures/test-score.pdf')];
        r.heldBefore = await page.evaluate(
            async ({ doc, bytes }) => {
                const { getSupabase } = await import('/src/lib/supabase.ts');
                const { getDb } = await import('/src/sync/db.ts');
                const { holdOps, rememberScoreSource, unsavedMarkCount } = await import('/src/sync/inkRecovery.ts');
                const { data } = await getSupabase().auth.getSession();
                const author = data.session.user.id;
                rememberScoreSource(doc, 'Test score', new Uint8Array(bytes).buffer);
                const now = new Date().toISOString();
                const mark = (id, y) => ({
                    id,
                    docId: doc,
                    page: 0,
                    kind: 'stroke',
                    color: '#dc2626',
                    payload: { pts: [0.2, y, 0.5, 0.6, y + 0.02, 0.5, 0.8, y, 0.5], w: 0.006 },
                    createdBy: null,
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: null,
                    seq: 0,
                });
                holdOps(getDb(), doc, [
                    { author, op: { type: 'create', annotation: mark(crypto.randomUUID(), 0.3) } },
                    { author, op: { type: 'create', annotation: mark(crypto.randomUUID(), 0.4) } },
                ]);
                return unsavedMarkCount(author);
            },
            { doc: cloudDoc, bytes: pdf },
        );

        // The other tab signs out with the app's own sign-out.
        const other = await context.newPage();
        await other.goto(`${BASE}/library`);
        await other.waitForTimeout(1500);
        await other.evaluate(async () => {
            const { signOut } = await import('/src/features/auth/session.ts');
            await signOut();
        });
        await other.close();

        await page.locator('[role="status"]').filter({ hasText: /signed out in another tab/ }).first().waitFor({ timeout: 15000 });
        await page.waitForTimeout(1500);
        const notice = '[role="status"]:has-text("signed out in another tab")';
        r.signedOut = { url: page.url(), banner: await stripOf(page, notice), audit: await audit(page) };
        r.shotSignedOut = await shot(page, `banner-signed-out-other-tab-${vp}`);

        await page.locator(notice).getByRole('button', { name: 'Export' }).click();
        await page.getByRole('dialog', { name: 'Export your unsaved ink' }).waitFor();
        await page.waitForTimeout(400);
        r.exportDialog = { audit: await audit(page) };
        r.shotExportDialog = await shot(page, `signed-out-export-${vp}`);
        await page.getByRole('dialog', { name: 'Export your unsaved ink' }).getByRole('button', { name: 'Export', exact: true }).click();
        await page.getByRole('menuitem', { name: /as photo/ }).click();
        await page.getByText(/You’re signed out, so this export has only/).waitFor({ timeout: 20000 });
        await page.waitForTimeout(400);
        r.exportNotice = { audit: await audit(page) };
        r.shotExportNotice = await shot(page, `signed-out-export-notice-${vp}`);
        await page.keyboard.press('Escape');
        if (await page.getByRole('dialog', { name: 'Export your unsaved ink' }).count()) {
            await page.getByRole('button', { name: 'Close' }).click();
        }

        await page.locator(notice).getByRole('button', { name: 'Discard' }).click();
        await page.getByRole('dialog', { name: 'Discard your unsaved ink?' }).waitFor();
        await page.waitForTimeout(400);
        r.discardSignedOut = { audit: await audit(page) };
        r.shotDiscardSignedOut = await shot(page, `signed-out-discard-confirm-${vp}`);
        await page.getByRole('dialog', { name: 'Discard your unsaved ink?' }).getByRole('button', { name: 'Discard' }).click();
        await page.waitForTimeout(500);
        r.afterDiscard = { bannerGone: (await page.locator(notice).count()) === 0 };
        r.consoleErrorsB = consoleErrors;
        await context.close();
    }
    results[vp] = r;
    console.error('RESULT ' + JSON.stringify({ [vp]: r }));
}
await close();
console.log(JSON.stringify(results, null, 2));
