// Renders public/marketing/og.jpg (1200x630 social card) in headless Chromium
// using the app's own self-hosted fonts, served by a running dev server.
// Run: npm run dev (any port) then: node scripts/generate-og.mjs [devServerUrl]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE_URL = process.argv[2] ?? 'http://localhost:5173/';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'marketing', 'og.jpg');

const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    const dataUrl = await page.evaluate(async () => {
        await document.fonts.load('600 170px "Bodoni Moda Variable"');
        await document.fonts.load('400 44px "Instrument Sans Variable"');
        const c = document.createElement('canvas');
        c.width = 1200;
        c.height = 630;
        const ctx = c.getContext('2d');

        // Paper + faint staves (brand tokens from src/index.css @theme).
        ctx.fillStyle = '#f7f5ef';
        ctx.fillRect(0, 0, 1200, 630);
        const staff = (y) => {
            ctx.strokeStyle = 'rgba(28,25,23,0.10)';
            ctx.lineWidth = 1;
            for (let i = 0; i < 5; i++) {
                ctx.beginPath();
                ctx.moveTo(0, y + i * 14 + 0.5);
                ctx.lineTo(1200, y + i * 14 + 0.5);
                ctx.stroke();
            }
        };
        staff(58);
        staff(516);

        // Wordmark.
        ctx.fillStyle = '#1c1917';
        ctx.font = '600 170px "Bodoni Moda Variable", serif';
        ctx.textBaseline = 'alphabetic';
        const x0 = 96;
        const base = 330;
        ctx.fillText('Cleffy', x0, base);

        // Teacher's red ink around the "ff" — fortissimo, hiding in the name.
        const wCle = ctx.measureText('Cle').width;
        const wCleff = ctx.measureText('Cleff').width;
        const cx = x0 + (wCle + wCleff) / 2 + 8;
        const cy = base - 58;
        ctx.strokeStyle = 'rgba(220,38,38,0.85)';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.ellipse(cx, cy, (wCleff - wCle) / 2 + 12, 86, -0.05, 0.35, 0.25 + Math.PI * 2);
        ctx.stroke();

        // Accent rule + tagline.
        ctx.fillStyle = 'rgba(67,56,202,0.55)';
        ctx.fillRect(x0 + 4, 372, 120, 3);
        ctx.fillStyle = '#57534e';
        ctx.font = '400 44px "Instrument Sans Variable", system-ui, sans-serif';
        ctx.fillText('Annotate scores together, in real time', x0 + 4, 448);

        return c.toDataURL('image/jpeg', 0.82);
    });
    const base64 = dataUrl.split(',')[1];
    writeFileSync(OUT, Buffer.from(base64, 'base64'));
    console.log(`wrote public/marketing/og.jpg (${Buffer.byteLength(base64, 'base64')} bytes)`);
} finally {
    await browser.close();
}
