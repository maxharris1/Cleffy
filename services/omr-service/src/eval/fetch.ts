import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import AdmZip from 'adm-zip';

import { sha256File } from './hash.js';
import type { CorpusEntry } from './manifest.js';
import { downloadsDir } from './paths.js';

export interface FetchedCorpus {
    pdfPath: string | null;
    midiDir: string;
}

const download = async (url: string, dest: string): Promise<void> => {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'cleffy-omr-eval/0.1 (https://github.com/maxharris1/sheet_music_scribbler)',
            Cookie: 'imslpdisclaimeraccepted=yes',
        },
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) {
        throw new Error(`GET ${url} returned ${buf.length} bytes — not a real file`);
    }
    const head = buf.subarray(0, 5).toString('latin1');
    if (head.startsWith('%PDF') || head.startsWith('PK') || head.startsWith('MThd')) {
        await writeFile(dest, buf);
        return;
    }
    throw new Error(
        `GET ${url} did not look like PDF/ZIP/MIDI (starts ${JSON.stringify(head)}). ` +
            `Place the file at ${dest} by hand and re-run fetch.`,
    );
};

const assertSha = (path: string, expected: string | undefined, label: string): void => {
    if (!expected) {
        return;
    }
    const got = sha256File(path);
    if (got !== expected) {
        throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${got} (${path})`);
    }
};

export const fetchCorpus = async (entry: CorpusEntry): Promise<FetchedCorpus> => {
    const root = downloadsDir();
    await mkdir(root, { recursive: true });
    const pdfPath = join(root, `${entry.slug}.pdf`);
    const zipPath = join(root, `${entry.slug}-mids.zip`);
    const midiDir = join(root, `${entry.slug}-midi`);

    if (!existsSync(zipPath)) {
        await download(entry.reference.url, zipPath);
    }
    assertSha(zipPath, entry.reference.sha256, 'reference zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(midiDir, true);

    let pdf: string | null = null;
    if (existsSync(pdfPath)) {
        assertSha(pdfPath, entry.pdf.sha256, 'pdf');
        pdf = pdfPath;
    } else {
        try {
            await download(entry.pdf.url, pdfPath);
            assertSha(pdfPath, entry.pdf.sha256, 'pdf');
            pdf = pdfPath;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            process.stderr.write(
                `PDF fetch skipped (${reason}). --from pdf needs ${pdfPath}. --from document does not.\n`,
            );
        }
    }

    return { pdfPath: pdf, midiDir };
};

const findNamed = (dir: string, filename: string, depth = 0): string | null => {
    if (!existsSync(dir) || depth > 4) {
        return null;
    }
    const direct = join(dir, filename);
    if (existsSync(direct)) {
        return direct;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const found = findNamed(join(dir, entry.name), filename, depth + 1);
        if (found) {
            return found;
        }
    }
    return null;
};

export const midiPath = (fetched: FetchedCorpus, filename: string): string => {
    const found = findNamed(fetched.midiDir, filename);
    if (!found) {
        throw new Error(`MIDI ${filename} not in ${fetched.midiDir}`);
    }
    return found;
};
