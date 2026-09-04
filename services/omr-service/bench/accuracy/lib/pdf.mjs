/** poppler / MuseScore shell helpers shared by fetch and the engines. */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const pdfPageCount = async (pdfPath) => {
    const { stdout } = await run('pdfinfo', [pdfPath]);
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : 0;
};

/** Page size in points (width, height) of the first page. */
export const pdfPageSizePt = async (pdfPath) => {
    const { stdout } = await run('pdfinfo', [pdfPath]);
    const m = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(stdout);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

/** Extract 1-based inclusive page range into a new PDF. */
export const pdfExtractPages = async (srcPath, from, to, outPath) => {
    const work = await mkdtemp(join(tmpdir(), 'pdfx-'));
    try {
        await run('pdfseparate', ['-f', String(from), '-l', String(to), srcPath, join(work, 'p-%d.pdf')]);
        const parts = (await readdir(work))
            .filter((f) => f.endsWith('.pdf'))
            .sort((a, b) => Number(/p-(\d+)/.exec(a)[1]) - Number(/p-(\d+)/.exec(b)[1]))
            .map((f) => join(work, f));
        await run('pdfunite', [...parts, outPath]);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
};

export const pdfConcat = async (inputs, outPath) => {
    await run('pdfunite', [...inputs, outPath]);
};

/**
 * MuseScore 3 headless render. `-o x.pdf` engraves; `-o x.mpos` writes measure
 * boxes (x, y, sx, sy, page) in 1/3600 in — the typeset set's geometry truth.
 */
export const musescoreExport = async (musicXmlPath, outPath) => {
    await run('mscore3', ['-o', outPath, musicXmlPath], {
        env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
    });
};

/** Rasterize pages to PNG; returns paths in page order. */
export const pdfToPng = async (pdfPath, outDir, dpi, options = {}) => {
    const args = ['-r', String(dpi), '-png'];
    if (options.gray) {
        args.push('-gray');
    }
    if (options.first) {
        args.push('-f', String(options.first));
    }
    if (options.last) {
        args.push('-l', String(options.last));
    }
    await run('pdftoppm', [...args, pdfPath, join(outDir, 'page')], { timeout: 600_000 });
    return (await readdir(outDir))
        .filter((f) => /^page-\d+\.png$/.test(f))
        .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
        .map((f) => join(outDir, f));
};
