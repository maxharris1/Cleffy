import { open, login, stubApi, shot, audit, close, BASE } from '../repo/scripts/ui/uifuzz.mjs';
for (const vp of ['ipad-portrait', 'iphone-14']) {
    const { page, context } = await open(vp);
    await stubApi(page);
    await login(page);
    await page.goto(BASE + '/account');
    await page.waitForTimeout(2000);
    console.log(vp, JSON.stringify(await audit(page), null, 0));
    const sh = await page.evaluate(() => [document.documentElement.scrollHeight, innerHeight]);
    console.log('scrollHeight/innerHeight', sh);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const clear = await page.evaluate(() => {
        const nav = [...document.querySelectorAll('nav')].find((n) => getComputedStyle(n).position === 'fixed');
        const main = document.querySelector('main');
        const last = main && [...main.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 0).at(-1);
        return { navTop: nav?.getBoundingClientRect().top ?? null, lastBottom: last?.getBoundingClientRect().bottom, last: last?.outerHTML.slice(0, 120) };
    });
    console.log('bottom', JSON.stringify(clear));
    console.log(await shot(page, `account-${vp}-bottom`));
    await context.close();
}
await close();
