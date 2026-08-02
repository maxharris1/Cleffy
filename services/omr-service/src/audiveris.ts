import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ERROR_CODES, JobError } from './errors.js';

export interface AudiverisResult {
    mxlPaths: string[];
    omrPath: string | null;
}

export interface AudiverisOptions {
    timeoutMs: number;
    /** Called with the highest sheet number seen in the log so far. */
    onSheetProgress?: (sheet: number) => void;
}

const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';

/**
 * Run Audiveris headless on a PDF: transcribe + export MusicXML (-export)
 * and save the .omr project (-save) into outDir. Verified against 5.6.1:
 * outputs land as <base>.mxl (or <base>.mvtN.mxl per movement) and
 * <base>.omr directly in the output folder.
 */
export const runAudiveris = async (
    pdfPath: string,
    outDir: string,
    options: AudiverisOptions,
): Promise<AudiverisResult> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(AUDIVERIS_BIN, ['-batch', '-export', '-save', '-output', outDir, '--', pdfPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true, // own process group, so the timeout can kill the whole JVM tree
        });

        let done = false;
        const finish = (err: Error | null) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        const timer = setTimeout(() => {
            try {
                if (child.pid) {
                    process.kill(-child.pid, 'SIGKILL');
                }
            } catch {
                child.kill('SIGKILL');
            }
            finish(new JobError(ERROR_CODES.omrTimeout, `Audiveris exceeded ${options.timeoutMs} ms`));
        }, options.timeoutMs);

        let maxSheet = 0;
        const scan = (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            for (const match of text.matchAll(/sheet#(\d+)/gi)) {
                const sheet = Number.parseInt(match[1] ?? '0', 10);
                if (sheet > maxSheet) {
                    maxSheet = sheet;
                    options.onSheetProgress?.(sheet);
                }
            }
        };
        child.stdout.on('data', scan);
        child.stderr.on('data', scan);

        child.on('error', (err) =>
            finish(new JobError(ERROR_CODES.omrCrash, `Could not start Audiveris: ${err.message}`)),
        );
        child.on('exit', (code, signal) => {
            if (code === 0) {
                finish(null);
            } else if (!done) {
                finish(new JobError(ERROR_CODES.omrCrash, `Audiveris exited with ${code ?? signal}`));
            }
        });
    });

    return discoverOutputs(outDir);
};

/** Find produced artifacts wherever Audiveris put them (layout differs across versions). */
export const discoverOutputs = async (outDir: string): Promise<AudiverisResult> => {
    const mxlPaths: string[] = [];
    let omrPath: string | null = null;

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 3) {
            return;
        }
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
            } else if (entry.name.toLowerCase().endsWith('.mxl')) {
                mxlPaths.push(full);
            } else if (entry.name.toLowerCase().endsWith('.omr')) {
                omrPath = omrPath ?? full;
            }
        }
    };
    await walk(outDir, 0);
    // Movement files sort correctly by name (base.mvt1.mxl, base.mvt2.mxl, …).
    mxlPaths.sort();
    return { mxlPaths, omrPath };
};

/** Generous wall-clock budget: dense scans run ~30-60 s/page on small instances. */
export const timeoutForPages = (pageCount: number | null): number => {
    const pages = pageCount && pageCount > 0 ? pageCount : 20;
    return Math.min(30 * 60_000, 120_000 + pages * 60_000);
};
