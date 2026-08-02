// Generates the PWA icon set as PNGs with zero image dependencies:
// an accent tile with a paper-colored quarter note, encoded by a minimal
// PNG writer, antialiased by 4x4 supersampling.
// Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [67, 56, 202]; // brand accent #4338ca (see src/index.css @theme)
const FG = [247, 245, 239]; // brand paper #f7f5ef

const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c;
});

const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
        c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
};

// Quarter-note glyph in normalized [0,1] coordinates.
const isNote = (x, y) => {
    // Note head: tilted ellipse centered (0.42, 0.66).
    const tilt = -0.35; // radians
    const dx = x - 0.42;
    const dy = y - 0.66;
    const rx = dx * Math.cos(tilt) - dy * Math.sin(tilt);
    const ry = dx * Math.sin(tilt) + dy * Math.cos(tilt);
    if ((rx / 0.155) ** 2 + (ry / 0.105) ** 2 <= 1) {
        return true;
    }
    // Stem: vertical bar on the right edge of the head, up to y=0.22.
    return x >= 0.545 && x <= 0.585 && y >= 0.22 && y <= 0.66;
};

/**
 * Render the tile. `glyphScale` < 1 shrinks the note toward the center —
 * used for the maskable variant, which needs ~80% safe-zone padding.
 */
const renderPng = (size, glyphScale = 1) => {
    const SS = 4; // supersamples per axis
    const raw = Buffer.alloc(size * (1 + size * 3));
    for (let y = 0; y < size; y++) {
        const rowStart = y * (1 + size * 3);
        raw[rowStart] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            let hits = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const px = (x + (sx + 0.5) / SS) / size;
                    const py = (y + (sy + 0.5) / SS) / size;
                    const gx = 0.5 + (px - 0.5) / glyphScale;
                    const gy = 0.5 + (py - 0.5) / glyphScale;
                    if (isNote(gx, gy)) {
                        hits++;
                    }
                }
            }
            const a = hits / (SS * SS);
            const i = rowStart + 1 + x * 3;
            raw[i] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
            raw[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
            raw[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, glyphScale] of [
    ['icon-192.png', 192, 1],
    ['icon-512.png', 512, 1],
    ['icon-512-maskable.png', 512, 0.62],
    ['apple-touch-icon.png', 180, 1],
]) {
    writeFileSync(join(OUT_DIR, name), renderPng(size, glyphScale));
    console.log(`wrote public/icons/${name} (${size}x${size})`);
}
