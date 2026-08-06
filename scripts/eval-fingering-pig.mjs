#!/usr/bin/env node
/**
 * Optional PIG dataset inventory — not an engine eval, not run in CI.
 *
 * 1. Register and download PIG from
 *    https://beam.kisarazu.ac.jp/research/PianoFingeringDataset/
 *    (research / non-profit terms — cite Nakamura, Saito & Yoshii 2020).
 * 2. Unpack so fingering `.txt` files are under $PIG_DIR.
 * 3. Run: PIG_DIR=/path/to/PIG node scripts/eval-fingering-pig.mjs
 *
 * Prints file/note parse counts only. For match-rate and IFR against the app
 * engine, use Vitest fixtures + `evalMetrics` / `suggestForRegion`.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const PIG_DIR = process.env.PIG_DIR;

if (!PIG_DIR) {
    console.error('Set PIG_DIR to the unpacked PIG dataset root and re-run.');
    console.error('See IMPLEMENTATION_NOTES.md (Fingering eval).');
    process.exit(1);
}

/** Minimal PIG line: onset offset pitch … finger (last field often finger). */
const parseFingeringFile = (text) => {
    const notes = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
            continue;
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length < 4) {
            continue;
        }
        const onset = Number(parts[0]);
        const pitch = Number(parts[2]);
        const fingerRaw = parts[parts.length - 1];
        const finger = Math.abs(Number.parseInt(fingerRaw, 10));
        if (!Number.isFinite(onset) || !Number.isFinite(pitch) || !(finger >= 1 && finger <= 5)) {
            continue;
        }
        notes.push({ onset, pitch, finger });
    }
    return notes;
};

const walkTxt = async (dir, out = []) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            await walkTxt(full, out);
        } else if (e.name.endsWith('.txt')) {
            out.push(full);
        }
    }
    return out;
};

const files = await walkTxt(PIG_DIR);
let fileCount = 0;
let noteCount = 0;
let nullish = 0;

for (const file of files) {
    const text = await readFile(file, 'utf8');
    const notes = parseFingeringFile(text);
    if (notes.length === 0) {
        continue;
    }
    fileCount += 1;
    noteCount += notes.length;
    // PIG annotations are human; count only parse failures above. Placeholder
    // for future: group by onset and flag spans > 15 semitones for 1–5.
    for (const n of notes) {
        if (!(n.finger >= 1 && n.finger <= 5)) {
            nullish += 1;
        }
    }
}

console.log(
    JSON.stringify(
        {
            pigDir: PIG_DIR,
            fingeringFiles: fileCount,
            notesParsed: noteCount,
            invalidFingers: nullish,
            hint: 'CI eval uses src/features/fingering/engine/fixtures + evalMetrics.test.ts',
        },
        null,
        2,
    ),
);
