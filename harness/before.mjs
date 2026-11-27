import { open, login, stubApi, shot, audit, close, BASE } from '../before/scripts/ui/uifuzz.mjs';
const ROUTES = ["/account"];
const SIZES = ["iphone-14"];
for (const vp of SIZES) {
    const { page, context, consoleErrors } = await open(vp);
    await stubApi(page);
    await login(page);
    for (const route of ROUTES) {
        await page.goto(BASE + route);
        await page.waitForTimeout(2000);
        const boundary = await page.getByText('Something went wrong').count();
        const h1 = (await page.locator('main h1, h1').first().innerText().catch(() => '')).trim();
        const nav = await page.locator('nav').first().boundingBox({ timeout: 1000 }).catch(() => null);
        const kinds = {};
        for (const f of await audit(page)) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
        const path = await shot(page, `${route.slice(1).replace('/', '-')}-${vp}`);
        console.log([vp, route, `boundary=${boundary}`, `h1="${h1}"`, `nav=${nav && [nav.x, nav.y, nav.width, nav.height].map(Math.round).join(',')}`, JSON.stringify(kinds), path].join(' | '));
    }
    console.log(vp, 'page errors:', consoleErrors.filter((e) => e.startsWith('pageerror')).length);
    await context.close();
}
await close();
