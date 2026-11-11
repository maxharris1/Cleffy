import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The OMR image runs a downloaded Audiveris build and Tesseract data on every
 * uploaded score. Each download must be checked against a pinned SHA-256
 * before it is used, so a swapped release asset fails the build instead of
 * shipping.
 */
const dockerfile = readFileSync(resolve(__dirname, '../../services/omr-service/Dockerfile'), 'utf8');

/** The Dockerfile with line continuations joined, one instruction per line. */
const instructions = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));

const args = new Map(
    instructions
        .map((line) => line.match(/^ARG (\w+)=(\S+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1] as string, m[2] as string]),
);

describe('OMR Dockerfile download pins', () => {
    it('pins Audiveris and the tessdata to 64-hex SHA-256 values', () => {
        expect(args.get('AUDIVERIS_DEB_SHA256')).toMatch(/^[0-9a-f]{64}$/);
        expect(args.get('TESSDATA_ENG_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('checks every downloaded file with sha256sum -c before it is used', () => {
        const runs = instructions.filter((line) => line.startsWith('RUN') && /\bcurl -/.test(line));
        expect(runs.length).toBeGreaterThan(0);
        for (const run of runs) {
            const downloads = [...run.matchAll(/curl [^&]*-o (\S+)/g)].map((m) => m[1] as string);
            expect(downloads.length).toBeGreaterThan(0);
            for (const file of downloads) {
                const fetched = run.indexOf(`-o ${file}`);
                const checked = run.indexOf(`  ${file}" | sha256sum -c -`);
                expect(checked, `${file} is never checked`).toBeGreaterThan(fetched);
                // Nothing reads the file between the download and the check.
                const used = run.indexOf(file, fetched + file.length + 3);
                expect(used, `${file} is used before its check`).toBe(checked + 2);
            }
        }
    });

    it('pins every base image by digest', () => {
        const froms = instructions.filter((line) => /^FROM\s/.test(line));
        expect(froms.length).toBeGreaterThan(0);
        for (const from of froms) {
            const image = from.split(/\s+/)[1] as string;
            expect(image, `${from} is not pinned by digest`).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
        }
    });
});
