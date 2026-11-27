import { open, login, close, shot, audit } from '/home/claude-bot/factory-work/jobs/1f2bb58d046741f9a053a9573203f46f/repo/scripts/ui/uifuzz.mjs';
import { stub, seen, user } from './stub.mjs';
const entitlements = { user_id: user.id, tier: 'free', status: null, source: 'none', current_period_end: null,
    limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 0 } };
const handlers = {
    '/rpc/library_bootstrap': { documents: [], has_more: false, favorite_ids: [], tags: [], document_tags: [], entitlements },
    '/rpc/get_entitlements': entitlements,
};
for (const vp of ['desktop-1440', 'ipad-portrait', 'iphone-14']) {
    const { page, context, consoleErrors } = await open(vp);
    await stub(page, handlers);
    await login(page);
    for (const r of ['/library', '/search', '/students', '/account']) {
        await page.goto('http://localhost:5173' + r);
        await page.waitForTimeout(2500);
        const gap = await page.evaluate(() => {
            const h = document.querySelector('.page-head');
            if (!h) return null;
            const c = h.nextElementSibling;
            const first = document.querySelector('main input[type=search]') && location.pathname === '/search' ? document.querySelector('input[type=search]') : location.pathname === '/account' ? h.nextElementSibling.querySelector('section') : c;
            const g = () => Math.round(first.getBoundingClientRect().top - h.getBoundingClientRect().bottom);
            const a = g(); h.style.marginBottom = '0px'; const b = g(); h.style.marginBottom = '';
            return { gap: a, withoutHeadMargin: b };
        });
        const name = `${r.slice(1)}-${vp}`;
        const findings = await audit(page);
        console.log(name, JSON.stringify(gap), await shot(page, name), 'audit:', findings.length, (await page.locator('main').innerText().catch(() => '')).slice(0, 120).replace(/\n+/g, ' | '));
    }
    if (consoleErrors.length) console.log(vp, 'console errors:', consoleErrors.map((e) => e.slice(0, 160)));
    await context.close();
}
console.log([...seen].join('\n'));
await close();
