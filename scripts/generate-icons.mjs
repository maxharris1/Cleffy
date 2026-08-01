// Generates the PWA icon set as PNGs with zero image dependencies:
// an indigo tile with a white quarter note, encoded by a minimal PNG writer.
// Run: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [79, 70, 229]; // indigo-600 #4f46e5
const FG = [255, 255, 255];

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
    // Note head: ellipse centered (0.42, 0.66), slightly tilted look via radii.
    const hx = (x - 0.42) / 0.16;
    const hy = (y - 0.66) / 0.12;
    if (hx * hx + hy * hy <= 1) {
        return true;
    }
    // Stem: vertical bar on the right edge of the head, up to y=0.22.
    return x >= 0.54 && x <= 0.585 && y >= 0.22 && y <= 0.66;
};

const renderPng = (size) => {
    const raw = Buffer.alloc(size * (1 + size * 3));
    for (let y = 0; y < size; y++) {
        const rowStart = y * (1 + size * 3);
        raw[rowStart] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const [r, g, b] = isNote(x / size, y / size) ? FG : BG;
            const i = rowStart + 1 + x * 3;
            raw[i] = r;
            raw[i + 1] = g;
            raw[i + 2] = b;
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
for (const [name, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['apple-touch-icon.png', 180],
]) {
    writeFileSync(join(OUT_DIR, name), renderPng(size));
    console.log(`wrote public/icons/${name} (${size}x${size})`);
}
