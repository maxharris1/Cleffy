import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const REPO = process.env.CLEFFY_REPO ?? process.cwd();
const { VIEWPORTS } = await import(`${REPO}/scripts/ui/uifuzz.mjs`);

const { chromium } = createRequire(`${REPO}/`)('playwright');
const OUT = process.argv[2];
const CONF = 'http://127.0.0.1:5181/pr243-harness/index.html';
const UNCONF = 'http://127.0.0.1:5182/pr243-harness/index.html';
const SIZES = { desktop: VIEWPORTS['desktop-1440'], tablet: VIEWPORTS['ipad-portrait'], phone: VIEWPORTS['iphone-14'] };
const F5_WIDTHS = [640, 700, 780, 820, 1024];

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const probes = {};

const probe = (page) =>
    page.evaluate(() => {
        const box = (el) => {
            const r = el.getBoundingClientRect();
            const shows = (y) => {
                const hit = document.elementFromPoint(r.x + r.width / 2, y);
                return Boolean(hit && el.contains(hit));
            };
            return { x: r.x, y: r.y, w: r.width, h: r.height, visible: shows(r.top + 1) && shows(r.bottom - 1) };
        };
        const out = {};
        const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent.startsWith('Free to start'));
        if (heading) {
            const lineHeight = parseFloat(getComputedStyle(heading).lineHeight);
            out.headingLines = Math.round(heading.getBoundingClientRect().height / lineHeight);
            const close = document.querySelector('button[aria-label="Close"]');
            const range = document.createRange();
            range.selectNodeContents(heading);
            const c = close.getBoundingClientRect();
            out.headingCloseOverlaps = [...range.getClientRects()].filter(
                (r) => r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom,
            ).length;
        }
        out.cards = [...document.querySelectorAll('section')]
            .filter((s) => s.querySelector('h3'))
            .map((s) => {
                const caption = s.querySelector('p.tabular-nums.text-\\[13px\\]');
                return {
                    name: s.querySelector('h3').firstChild.textContent,
                    background: getComputedStyle(s).backgroundColor,
                    box: box(s),
                    caption: caption && { color: getComputedStyle(caption).color, box: box(caption) },
                };
            });
        const agreement = [...document.querySelectorAll('p')].find((p) => p.textContent.startsWith('By subscribing'));
        if (agreement) {
            out.agreement = { color: getComputedStyle(agreement).color, box: box(agreement) };
        }
        const title = document.querySelector('section[aria-labelledby] h3');
        if (title) {
            out.checkoutTitle = { text: title.textContent, fontSize: getComputedStyle(title).fontSize };
        }
        return out;
    });

const capture = async (name, size, url, after) => {
    const context = await browser.newContext({ ...size, locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('[role="dialog"]');
    if (after) {
        await after(page);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    probes[name] = { dpr: size.deviceScaleFactor ?? 1, width: size.viewport.width, viewportHeight: size.viewport.height, ...(await probe(page)) };
    await context.close();
};

for (const [vp, size] of Object.entries(SIZES)) {
    await capture(`plans-free-${vp}`, size, `${CONF}?tier=free`);
    await capture(`plans-paid-${vp}`, size, `${CONF}?tier=teacher`);
    await capture(`review-${vp}`, size, `${CONF}?tier=free`, (page) =>
        page.getByRole('button', { name: 'Choose Teacher' }).click(),
    );
    await capture(`unconfigured-${vp}`, size, UNCONF);
}
for (const width of F5_WIDTHS) {
    const tablet = SIZES.tablet;
    await capture(`f5-plans-free-${width}`, { ...tablet, viewport: { ...tablet.viewport, width } }, `${CONF}?tier=free`);
}
await browser.close();
writeFileSync(`${OUT}/probes.json`, JSON.stringify(probes, null, 2));
console.log(Object.keys(probes).length, 'captures');
