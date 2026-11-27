import fs from 'fs';
import { BASE, STUB_USER, open, login, close, shot, audit, stubApi, reply } from '../repo/scripts/ui/uifuzz.mjs';

const injected = reply(500, { code: 'XX000', details: null, hint: null, message: 'injected failure (#228)' });
const entitlements = {
    user_id: STUB_USER.id,
    tier: 'free',
    status: null,
    source: 'none',
    current_period_end: null,
    limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 0 },
};
const handlers = {
    '/rpc/library_bootstrap': injected,
    '/rest/v1/documents': injected,
    '/rpc/get_entitlements': entitlements,
};

const lines = [];
for (const vp of ['desktop-1440', 'ipad-portrait', 'iphone-14']) {
    const { page, context, consoleErrors } = await open(vp);
    await stubApi(page, handlers);
    await login(page);
    await page.goto(BASE + '/library');
    await page.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 30000 });
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const gap = await page.evaluate(() => {
        const head = document.querySelector('.page-head');
        const first = head.nextElementSibling;
        const measure = () => Math.round(first.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
        const rendered = measure();
        head.style.marginBottom = '0px';
        const withoutHeadMargin = measure();
        head.style.marginBottom = '';
        return { gap: rendered, withoutHeadMargin, firstContent: first.className };
    });
    const findings = await audit(page);
    const text = (await page.locator('main').innerText()).replace(/\n+/g, ' | ');
    const path = await shot(page, `library-failed-${vp}`);
    lines.push(`${vp} ${JSON.stringify(gap)}`);
    console.log(vp, JSON.stringify(gap), path, 'audit:', JSON.stringify(findings), 'main:', text);
    console.log(vp, 'console errors:', consoleErrors.map((e) => e.slice(0, 160)));
    await context.close();
}
fs.writeFileSync(new URL('./gaps.txt', import.meta.url), lines.join('\n') + '\n');
await close();
