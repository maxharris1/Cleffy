import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const REPO = process.env.CLEFFY_REPO ?? process.cwd();
const { chromium } = createRequire(`${REPO}/`)('playwright');
const DIR = process.argv[2];
const probes = JSON.parse(readFileSync(`${DIR}/probes.json`, 'utf8'));
const INK = [0x1c, 0x19, 0x17];
const CAPTION = { paper: [0x57, 0x53, 0x4e], ink: [0xd6, 0xd3, 0xd1] };
const AGREEMENT = [0x6b, 0x63, 0x5d];
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
const failures = [];
const check = (ok, line) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
    if (!ok) failures.push(line);
};

for (const [name, p] of Object.entries(probes)) {
    const png = readFileSync(`${DIR}/${name}.png`).toString('base64');
    await page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.getElementById('c');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
    }, `data:image/png;base64,${png}`);
    const region = (box) =>
        page.evaluate(
            ({ box, dpr }) => {
                const c = document.getElementById('c');
                const x = Math.max(0, Math.floor(box.x * dpr));
                const y = Math.max(0, Math.floor(box.y * dpr));
                const w = Math.min(c.width - x, Math.ceil(box.w * dpr));
                const h = Math.min(c.height - y, Math.ceil(box.h * dpr));
                if (w <= 0 || h <= 0) return null;
                const d = c.getContext('2d').getImageData(x, y, w, h).data;
                const px = [];
                for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
                return px;
            },
            { box, dpr: p.dpr },
        );
    const visible = (box) => box.y >= 0 && box.y + box.h <= (p.viewportHeight ?? Infinity);
    const textColor = (px, bg) => {
        const counts = new Map();
        for (const c of px) {
            if (dist(c, bg) < 40) continue;
            const key = hex(c);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const [top] = [...counts].sort((a, b) => b[1] - a[1]);
        return top ? top[0].match(/[0-9a-f]{2}/g).map((v) => parseInt(v, 16)) : bg;
    };

    if (p.headingLines !== undefined) {
        check(p.headingCloseOverlaps === 0, `${name}: heading text boxes overlapping Close = ${p.headingCloseOverlaps}`);
        if (name.endsWith('-desktop')) check(p.headingLines === 1, `${name}: heading lines = ${p.headingLines}`);
    }
    for (const card of p.cards ?? []) {
        if (!card.caption) continue;
        const current = card.background !== 'rgba(0, 0, 0, 0)';
        const bgPx = await region({ x: card.box.x + 8, y: card.caption.box.y, w: 2, h: 2 });
        if (!bgPx || !card.caption.box.visible) continue;
        const bg = bgPx[0];
        if (current) check(dist(bg, INK) <= 2, `${name}: ${card.name} (current) card pixel ${hex(bg)} vs ${hex(INK)}`);
        const want = CAPTION[current ? 'ink' : 'paper'];
        if (p.dpr === 1) {
            check(card.caption.color === `rgb(${want.join(', ')})`, `${name}: ${card.name} price caption computed ${card.caption.color} vs ${hex(want)}`);
            continue;
        }
        const got = textColor(await region(card.caption.box), bg);
        check(dist(got, want) <= 12, `${name}: ${card.name} price caption pixels ${hex(got)} vs ${hex(want)}`);
    }
    if (p.agreement) {
        check(p.agreement.color === `rgb(${AGREEMENT.join(', ')})`, `${name}: agreement note computed ${p.agreement.color} vs ${hex(AGREEMENT)}`);
        if (p.agreement.box.visible && p.dpr > 1) {
            const px = await region(p.agreement.box);
            const got = textColor(px, px[0]);
            check(dist(got, AGREEMENT) <= 12, `${name}: agreement note pixels ${hex(got)} vs ${hex(AGREEMENT)}`);
        }
    }
    if (p.checkoutTitle) check(p.checkoutTitle.fontSize === '28px', `${name}: checkout title ${p.checkoutTitle.fontSize}`);
}
await browser.close();
console.log(failures.length ? `${failures.length} failed` : 'all checks passed');
process.exit(failures.length ? 1 : 0);
