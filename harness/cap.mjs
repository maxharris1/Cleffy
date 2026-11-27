import { open, audit, shot, close } from '/home/claude-bot/factory-work/jobs/30273896762e485292c6ac5b318784d4/repo/scripts/ui/uifuzz.mjs';

const URL0 = 'http://localhost:5199/shots217/index.html';
const VIEWS = {
    'share-owner': async (p) => { await p.goto(`${URL0}?view=share-owner`); await p.getByRole('dialog').getByText('Maya Chen').first().waitFor(); },
    'share-member': async (p) => { await p.goto(`${URL0}?view=share-member`); await p.getByRole('dialog').getByText('Maya Chen').first().waitFor(); },
    'notes': async (p) => { await p.goto(`${URL0}?view=notes`); await p.getByRole('dialog').getByText('Bars 9').first().waitFor(); },
    'history': async (p) => { await p.goto(URL0); await p.getByRole('button', { name: 'History' }).click(); await p.getByRole('dialog').getByRole('button', { name: 'Restore' }).first().waitFor(); },
    'export-menu': async (p) => { await p.goto(URL0); await p.getByRole('button', { name: 'Export' }).click(); await p.getByRole('menuitem').first().waitFor(); },
    'export-result': async (p) => {
        await p.goto(URL0);
        await p.getByRole('button', { name: 'Export' }).click();
        await p.getByRole('menuitem', { name: /Send page 1 as photo/ }).click();
        await p.getByText('isn’t available on this device').first().waitFor();
    },
};
const only = process.argv[2];
for (const vp of ['desktop-1440', 'ipad-portrait', 'iphone-14']) {
    for (const [name, go] of Object.entries(VIEWS)) {
        if (only && only !== name) continue;
        const { page, consoleErrors, context } = await open(vp);
        await go(page);
        await page.waitForTimeout(400);
        console.log(vp, name, 'audit', JSON.stringify(await audit(page)));
        console.log(vp, name, await shot(page, `${name}-${vp}`));
        console.log(vp, name, 'console errors', JSON.stringify(consoleErrors));
        await context.close();
    }
}
await close();
