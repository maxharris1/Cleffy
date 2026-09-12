import { mkdir, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

import AdmZip from 'adm-zip';

import { sha256File } from './hash.js';
import type { CorpusEntry } from './manifest.js';
import { downloadsDir, fixturesDir } from './paths.js';

export interface FetchedCorpus {
    pdfPath: string | null;
    midiDir: string;
}

export interface FetchOptions {
    /** Network GET is only for the `fetch` command. `run` never downloads. */
    allowNetwork?: boolean;
    /** `midi` skips the PDF entirely (artifacts / document). */
    mode?: 'midi' | 'all';
}

const EVAL_UA = 'cleffy-omr-eval/0.1 (https://github.com/maxharris1/Cleffy)';

const isImslp = (url: string): boolean => {
    try {
        return /(?:^|\.)imslp\.org$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
};

const download = async (url: string, dest: string): Promise<void> => {
    if (isImslp(url)) {
        throw new Error(
            `Refusing to fetch ${url} (IMSLP). Place the file at ${dest} after accepting their terms in a browser, and pin pdf.sha256.`,
        );
    }
    const res = await fetch(url, {
        headers: { 'User-Agent': EVAL_UA },
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

export const assertSha = (path: string, expected: string, label: string): void => {
    const got = sha256File(path);
    if (got !== expected) {
        throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${got} (${path})`);
    }
};

const insideDir = (dir: string, candidate: string): boolean => {
    const root = resolve(dir) + sep;
    const full = resolve(candidate);
    return full.startsWith(root) || full === resolve(dir);
};

/** Flatten zip entries to `destDir/<basename>` and refuse `..` / absolute paths. */
export const extractZipSafely = (zipPath: string, destDir: string): void => {
    mkdirSync(destDir, { recursive: true });
    const zip = new AdmZip(zipPath);
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }
        const raw = entry.entryName.replace(/\\/g, '/');
        if (raw.startsWith('/') || raw.split('/').includes('..')) {
            throw new Error(`refusing zip entry '${entry.entryName}' (path traversal)`);
        }
        const name = basename(raw);
        if (name === '' || name === '.' || name === '..') {
            throw new Error(`refusing zip entry '${entry.entryName}'`);
        }
        const dest = join(destDir, name);
        if (!insideDir(destDir, dest)) {
            throw new Error(`refusing zip entry '${entry.entryName}' (escapes ${destDir})`);
        }
        writeFileSync(dest, entry.getData());
    }
};

/**
 * True when the reference URL is a single Standard MIDI File rather than a
 * `-mids.zip` archive. Mutopia publishes one `.mid` per single-movement piece
 * and a zip only for multi-movement works, and `reference.sha256` pins whatever
 * the URL actually serves — so a bare `.mid` must not be handed to AdmZip.
 */
const isBareMidiRef = (url: string): boolean => {
    try {
        return /\.midi?$/i.test(new URL(url).pathname);
    } catch {
        return false;
    }
};

const resolveMutopiaMidi = async (entry: CorpusEntry, allowNetwork: boolean): Promise<string> => {
    if (entry.reference.source !== 'mutopia') {
        throw new Error(`resolveMutopiaMidi called for ${entry.reference.source}`);
    }
    const root = downloadsDir();
    await mkdir(root, { recursive: true });
    const bare = isBareMidiRef(entry.reference.url);
    const midiDir = join(root, `${entry.slug}-midi`);
    const refPath = join(root, bare ? `${entry.slug}.mid` : `${entry.slug}-mids.zip`);
    if (!existsSync(refPath)) {
        if (!allowNetwork) {
            throw new Error(
                `reference ${bare ? 'MIDI' : 'zip'} missing at ${refPath}. Run \`npm run eval -- fetch --piece ${entry.slug}\` first.`,
            );
        }
        await download(entry.reference.url, refPath);
    }
    assertSha(refPath, entry.reference.sha256, bare ? 'reference midi' : 'reference zip');
    if (!bare) {
        extractZipSafely(refPath, midiDir);
        return midiDir;
    }
    const only = entry.movements[0];
    if (entry.movements.length !== 1 || only === undefined) {
        throw new Error(
            `${entry.slug}: a bare .mid reference carries one movement; ${entry.movements.length} are declared. Pin a -mids.zip instead.`,
        );
    }
    mkdirSync(midiDir, { recursive: true });
    copyFileSync(refPath, join(midiDir, basename(only.midi)));
    return midiDir;
};

const resolveFixtureMidi = (entry: CorpusEntry): string => {
    const midiDir = join(fixturesDir(), entry.slug);
    if (!existsSync(midiDir)) {
        throw new Error(`fixture MIDI dir missing: ${midiDir}`);
    }
    return midiDir;
};

const resolvePdf = async (entry: CorpusEntry, allowNetwork: boolean): Promise<string | null> => {
    const pdfPath = join(downloadsDir(), `${entry.slug}.pdf`);
    const pin = entry.pdf.sha256;
    if (!pin) {
        if (existsSync(pdfPath)) {
            process.stderr.write(
                `PDF at ${pdfPath} is unpinned (no pdf.sha256). --from pdf will refuse it.\n`,
            );
        }
        return null;
    }
    if (existsSync(pdfPath)) {
        assertSha(pdfPath, pin, 'pdf');
        return pdfPath;
    }
    if (!allowNetwork) {
        return null;
    }
    try {
        await download(entry.pdf.url, pdfPath);
        assertSha(pdfPath, pin, 'pdf');
        return pdfPath;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(`PDF fetch skipped (${reason}). --from pdf needs ${pdfPath}.\n`);
        return null;
    }
};

export const fetchCorpus = async (entry: CorpusEntry, options: FetchOptions = {}): Promise<FetchedCorpus> => {
    const allowNetwork = options.allowNetwork === true;
    const mode = options.mode ?? 'all';
    const midiDir =
        entry.reference.source === 'fixture'
            ? resolveFixtureMidi(entry)
            : await resolveMutopiaMidi(entry, allowNetwork);

    if (mode === 'midi') {
        return { pdfPath: null, midiDir };
    }

    const pdf = await resolvePdf(entry, allowNetwork);
    return { pdfPath: pdf, midiDir };
};

const findNamed = (dir: string, filename: string, depth = 0): string | null => {
    if (!existsSync(dir) || depth > 4) {
        return null;
    }
    const direct = join(dir, filename);
    if (existsSync(direct) && insideDir(dir, direct)) {
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
    const name = basename(filename);
    if (name !== filename || filename.includes('..')) {
        throw new Error(`MIDI filename must be a basename (got ${filename})`);
    }
    const found = findNamed(fetched.midiDir, name);
    if (!found) {
        throw new Error(`MIDI ${name} not in ${fetched.midiDir}`);
    }
    return found;
};
