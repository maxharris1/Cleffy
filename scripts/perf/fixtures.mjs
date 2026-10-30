// Benchmark fixtures, written to $CLEFFY_PERF_DIR/fixtures:
//   scan-24.pdf   — 24-page "scanned" score (one 2480x3508 JPEG per page, like an IMSLP scan; ~23 MB)
//   vector-16.pdf — 16-page born-digital score (vector staves + noteheads)
//   cover-<n>.jpg — 12 library cover JPEGs, the size of a published thumbnail
//   node scripts/perf/fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument, rgb } = require('pdf-lib');
const { chromium } = require('playwright');

const OUT = `${process.env.CLEFFY_PERF_DIR ?? '/tmp/cleffy-perf'}/fixtures`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium
    .launch()
    .catch(() => chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' }));
const page = await browser.newPage();

// Draw a scan-like page into a canvas and return a JPEG data URL.
const drawPage = (seed, w, h, quality) =>
    page.evaluate(
        ({ seed, w, h, quality }) => {
            let s = seed;
            const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const g = c.getContext('2d');
            // Off-white paper with grain, like a real scan.
            g.fillStyle = '#f4f0e6';
            g.fillRect(0, 0, w, h);
            const img = g.getImageData(0, 0, w, h);
            for (let i = 0; i < img.data.length; i += 4) {
                const n = (rnd() - 0.5) * 18;
                img.data[i] += n;
                img.data[i + 1] += n;
                img.data[i + 2] += n;
            }
            g.putImageData(img, 0, 0);
            g.fillStyle = '#1a1a1a';
            g.strokeStyle = '#1a1a1a';
            const margin = w * 0.08;
            const systems = 6;
            const sysH = (h - margin * 2) / systems;
            for (let sy = 0; sy < systems; sy++) {
                for (let staff = 0; staff < 2; staff++) {
                    const top = margin + sy * sysH + staff * sysH * 0.42;
                    const gap = sysH * 0.045;
                    g.lineWidth = Math.max(2, w / 1200);
                    for (let l = 0; l < 5; l++) {
                        g.beginPath();
                        g.moveTo(margin, top + l * gap + (rnd() - 0.5) * 2);
                        g.lineTo(w - margin, top + l * gap + (rnd() - 0.5) * 2);
                        g.stroke();
                    }
                    // Notes
                    const notes = 28 + Math.floor(rnd() * 20);
                    for (let n = 0; n < notes; n++) {
                        const x = margin + 60 + (n / notes) * (w - margin * 2 - 80);
                        const y = top + Math.floor(rnd() * 9) * (gap / 2) - gap;
                        g.beginPath();
                        g.ellipse(x, y, gap * 0.62, gap * 0.45, -0.4, 0, Math.PI * 2);
                        g.fill();
                        g.lineWidth = Math.max(2, w / 1500);
                        g.beginPath();
                        g.moveTo(x + gap * 0.58, y);
                        g.lineTo(x + gap * 0.58, y - gap * 3.2);
                        g.stroke();
                    }
                    // Bar lines
                    for (let b = 0; b <= 4; b++) {
                        const x = margin + (b / 4) * (w - margin * 2);
                        g.beginPath();
                        g.moveTo(x, top);
                        g.lineTo(x, top + 4 * gap);
                        g.stroke();
                    }
                }
            }
            g.font = `${Math.round(w / 40)}px serif`;
            g.fillText(`Page ${seed}`, w / 2 - 60, margin * 0.6);
            return c.toDataURL('image/jpeg', quality);
        },
        { seed, w, h, quality },
    );

const b64 = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

// 1. Scanned score.
{
    const pdf = await PDFDocument.create();
    for (let i = 1; i <= 24; i++) {
        const jpg = await pdf.embedJpg(b64(await drawPage(i, 2480, 3508, 0.72)));
        const p = pdf.addPage([595.28, 841.89]);
        p.drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }
    const bytes = await pdf.save();
    writeFileSync(`${OUT}/scan-24.pdf`, bytes);
    console.log('scan-24.pdf', (bytes.length / 1e6).toFixed(1), 'MB');
}

// 2. Born-digital vector score.
{
    const pdf = await PDFDocument.create();
    let s = 7;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    for (let i = 1; i <= 16; i++) {
        const p = pdf.addPage([595.28, 841.89]);
        for (let sy = 0; sy < 6; sy++) {
            for (let staff = 0; staff < 2; staff++) {
                const top = 780 - sy * 125 - staff * 50;
                for (let l = 0; l < 5; l++) {
                    p.drawLine({ start: { x: 50, y: top - l * 6 }, end: { x: 545, y: top - l * 6 }, thickness: 0.6 });
                }
                for (let n = 0; n < 40; n++) {
                    const x = 70 + n * 11.8;
                    const y = top - Math.floor(rnd() * 9) * 3;
                    p.drawEllipse({ x, y, xScale: 3.6, yScale: 2.6, color: rgb(0, 0, 0) });
                    p.drawLine({ start: { x: x + 3.4, y }, end: { x: x + 3.4, y: y + 19 }, thickness: 0.7 });
                }
            }
        }
    }
    const bytes = await pdf.save();
    writeFileSync(`${OUT}/vector-16.pdf`, bytes);
    console.log('vector-16.pdf', (bytes.length / 1e6).toFixed(2), 'MB');
}

// 3. Covers (published thumbnails are JPEG, long side THUMB_MAX_SIDE).
for (let i = 0; i < 12; i++) {
    const jpg = b64(await drawPage(100 + i, 296, 418, 0.8));
    writeFileSync(`${OUT}/cover-${i}.jpg`, jpg);
}
console.log('covers done');
await browser.close();
