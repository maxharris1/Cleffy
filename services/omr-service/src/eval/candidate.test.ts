import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import { ENGINE_VERSION } from '../job.js';
import {
    artifactCacheKey,
    assertDocumentReady,
    DOCUMENT_ID_RE,
    eraOfCorpusTitle,
    fromArtifacts,
    fromPdf,
    optionsFingerprint,
    setCandidateRuntimeForTests,
} from './candidate.js';
import { loadCorpusEntry } from './manifest.js';
import { artifactsCacheDir, packageRoot } from './paths.js';
import { sha256File } from './hash.js';

const fixtureMxl = join(packageRoot(), 'eval/fixtures/toy/score.mxl');

afterEach(() => {
    setCandidateRuntimeForTests(null);
});

describe('artifactCacheKey', () => {
    const sha = 'ab'.repeat(32);

    it('includes the full PDF digest and ENGINE_VERSION (+svc-N)', () => {
        const key = artifactCacheKey(sha, '-option Book.Lyrics=false');
        expect(key.startsWith(sha)).toBe(true);
        expect(key).toContain(ENGINE_VERSION.match(/svc-\d+$/)?.[0]);
        expect(ENGINE_VERSION).toMatch(/\+svc-\d+$/);
        expect(key).toContain(ENGINE_VERSION.replace(/[^a-zA-Z0-9._+-]+/g, '_'));
        expect(key.length).toBeGreaterThan(sha.length + ENGINE_VERSION.length);
    });

    it('does not collide when options share a 48-char prefix', () => {
        const a = `${'x'.repeat(48)}-one`;
        const b = `${'x'.repeat(48)}-two`;
        expect(artifactCacheKey(sha, a)).not.toBe(artifactCacheKey(sha, b));
    });
});

describe('era', () => {
    it('resolves a corpus title to the era production would give the piece', () => {
        const eraOf = (slug: string) => eraOfCorpusTitle(loadCorpusEntry(slug).title);
        expect(eraOf('bach-invention-01')).toBe('baroque');
        expect(eraOf('anna-magdalena-04')).toBe('baroque'); // "Petzold / Bach — …"
        expect(eraOf('bach-air-anh131')).toBe('baroque'); // "Bach (attrib.) — …"
        expect(eraOf('fur-elise-mutopia')).toBe('classical');
        expect(eraOf('burgmuller-op100-02')).toBe('romantic'); // not "(Arabesque)"
        expect(eraOf('gymnopedie-2')).toBe('modern');
        expect(eraOf('toy')).toBe('classical');
        expect(eraOfCorpusTitle('Invention 1 (Bach, Johann Sebastian)')).toBe('baroque');
    });

    it('builds artifacts in the given era, as job.ts parseRangeArtifacts does', async () => {
        const dir = join(packageRoot(), 'eval/fixtures/toy');
        expect((await fromArtifacts(dir)).score.era).toBe('classical');
        expect((await fromArtifacts(dir, 'artifacts', 'baroque')).score.era).toBe('baroque');
    });
});

describe('fromDocument guards', () => {
    it('accepts UUIDs only', () => {
        expect(DOCUMENT_ID_RE.test('dcca6082-3b58-42a6-a643-de6f196ef9f9')).toBe(true);
        expect(DOCUMENT_ID_RE.test('not-a-uuid')).toBe(false);
    });

    it('requires ready + title + owner', () => {
        expect(() => assertDocumentReady('pending', 'Moonlight', 'owner')).toThrow(/ready/);
        expect(() => assertDocumentReady('ready', '', 'owner')).toThrow(/title/);
        expect(() => assertDocumentReady('ready', 'Moonlight', '')).toThrow(/owner/);
        expect(() => assertDocumentReady('ready', 'Moonlight', 'owner')).not.toThrow();
    });
});

describe('OMR container provenance', () => {
    it('rejects a mismatched container before Audiveris version probing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'omr-candidate-mismatch-'));
        const pdfPath = join(root, 'input.pdf');
        writeFileSync(pdfPath, 'mismatched container input');
        const calls: string[][] = [];
        setCandidateRuntimeForTests({
            dockerExec: async (_container, args) => {
                calls.push(args);
                let stdout = '';
                // Run the actual version-reading script against fake source. A comment must
                // not mask the older revision exported by the selected container.
                runInNewContext(args[2]!, {
                    require: () => ({
                        readFileSync: () =>
                            `// ENGINE_VERSION = '${ENGINE_VERSION}'\n` +
                            "export const ENGINE_VERSION = 'audiveris-5.11.0+svc-20';\n",
                    }),
                    process: {
                        stdout: {
                            write: (value: string) => {
                                stdout += value;
                            },
                        },
                        exit: (code: number) => {
                            throw new Error(`fake container exit ${code}`);
                        },
                    },
                });
                return { stdout, stderr: '' };
            },
        });

        try {
            await expect(fromPdf(pdfPath)).rejects.toThrow(/expected/);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.slice(0, 2)).toEqual(['node', '-e']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(['empty response', 'missing export', 'unreadable source'])(
        'fails closed for %s before any engine command',
        async (failure) => {
            const root = mkdtempSync(join(tmpdir(), 'omr-candidate-no-version-'));
            const pdfPath = join(root, 'input.pdf');
            writeFileSync(pdfPath, 'container without version export');
            const calls: string[][] = [];
            setCandidateRuntimeForTests({
                dockerExec: async (_container, args) => {
                    calls.push(args);
                    if (failure !== 'empty response') {
                        runInNewContext(args[2]!, {
                            require: () => ({
                                readFileSync: () => {
                                    if (failure === 'unreadable source') {
                                        throw new Error('fake source read failure');
                                    }
                                    return `// export const ENGINE_VERSION = '${ENGINE_VERSION}';`;
                                },
                            }),
                            process: {
                                exit: (code: number) => {
                                    throw new Error(`fake container exit ${code}`);
                                },
                            },
                        });
                    }
                    return { stdout: '', stderr: '' };
                },
            });

            try {
                await expect(fromPdf(pdfPath)).rejects.toThrow(
                    /did not expose ENGINE_VERSION|fake container exit 2|fake source read failure/,
                );
                expect(calls).toHaveLength(1);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('reuses a cache only when PDF, options, and observed engine match', async () => {
        const root = mkdtempSync(join(tmpdir(), 'omr-candidate-cache-'));
        const pdfPath = join(root, 'input.pdf');
        writeFileSync(pdfPath, 'test pdf bytes');
        const pdfSha = sha256File(pdfPath);
        const options = optionsFingerprint();
        const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
        mkdirSync(dest, { recursive: true });
        copyFileSync(fixtureMxl, join(dest, 'score.mxl'));
        writeFileSync(
            join(dest, 'meta.json'),
            JSON.stringify({ pdfSha, options, engineVersion: ENGINE_VERSION, observedEngineVersion: ENGINE_VERSION }),
        );

        const calls: string[][] = [];
        let exported = false;
        setCandidateRuntimeForTests({
            dockerExec: async (_container, args) => {
                calls.push(args);
                return {
                    stdout: args[0] === 'node' ? ENGINE_VERSION : 'Audiveris 5.11.0',
                    stderr: '',
                };
            },
            runAudiveris: async () => {
                exported = true;
            },
        });

        try {
            const candidate = await fromPdf(pdfPath, false, 'romantic');
            expect(candidate.audiverisCacheHit).toBe(true);
            expect(candidate.score.era).toBe('romantic');
            expect(exported).toBe(false);
            expect(calls.map((args) => args[0])).toEqual(['node', '/opt/audiveris-root/opt/audiveris/bin/Audiveris']);
        } finally {
            rmSync(dest, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('regenerates an unverified legacy cache without mixing stale files', async () => {
        const root = mkdtempSync(join(tmpdir(), 'omr-candidate-legacy-'));
        const pdfPath = join(root, 'input.pdf');
        writeFileSync(pdfPath, 'legacy cache input');
        const pdfSha = sha256File(pdfPath);
        const options = optionsFingerprint();
        const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
        mkdirSync(dest, { recursive: true });
        copyFileSync(fixtureMxl, join(dest, 'stale.mxl'));
        writeFileSync(join(dest, 'stale.omr'), 'stale artifact');
        writeFileSync(join(dest, 'meta.json'), JSON.stringify({ pdfSha, options, engineVersion: ENGINE_VERSION }));

        let sawStale = true;
        setCandidateRuntimeForTests({
            dockerExec: async (_container, args) => ({
                stdout: args[0] === 'node' ? ENGINE_VERSION : 'Audiveris 5.11.0',
                stderr: '',
            }),
            runAudiveris: async (_pdf, outputDir) => {
                sawStale = existsSync(join(outputDir, 'stale.omr')) || existsSync(join(outputDir, 'stale.mxl'));
                copyFileSync(fixtureMxl, join(outputDir, 'fresh.mxl'));
            },
        });

        try {
            const candidate = await fromPdf(pdfPath);
            expect(candidate.audiverisCacheHit).toBe(false);
            expect(sawStale).toBe(false);
            const meta = JSON.parse(readFileSync(join(dest, 'meta.json'), 'utf8')) as Record<string, unknown>;
            expect(meta).toMatchObject({
                pdfSha,
                options,
                engineVersion: ENGINE_VERSION,
                observedEngineVersion: ENGINE_VERSION,
            });
        } finally {
            rmSync(dest, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.each(['pdfSha', 'options', 'engineVersion', 'observedEngineVersion'])(
        'regenerates a cache when %s differs',
        async (field) => {
            const root = mkdtempSync(join(tmpdir(), 'omr-candidate-tampered-'));
            const pdfPath = join(root, 'input.pdf');
            writeFileSync(pdfPath, 'tampered cache input');
            const pdfSha = sha256File(pdfPath);
            const options = optionsFingerprint();
            const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
            mkdirSync(dest, { recursive: true });
            copyFileSync(fixtureMxl, join(dest, 'stale.mxl'));
            writeFileSync(
                join(dest, 'meta.json'),
                JSON.stringify({
                    pdfSha,
                    options,
                    engineVersion: ENGINE_VERSION,
                    observedEngineVersion: ENGINE_VERSION,
                    [field]: 'wrong-value',
                }),
            );

            let exported = false;
            setCandidateRuntimeForTests({
                dockerExec: async (_container, args) => ({
                    stdout: args[0] === 'node' ? ENGINE_VERSION : 'Audiveris 5.11.0',
                    stderr: '',
                }),
                runAudiveris: async (_pdf, outputDir) => {
                    exported = true;
                    copyFileSync(fixtureMxl, join(outputDir, 'fresh.mxl'));
                },
            });

            try {
                const candidate = await fromPdf(pdfPath);
                expect(candidate.audiverisCacheHit).toBe(false);
                expect(exported).toBe(true);
            } finally {
                rmSync(dest, { recursive: true, force: true });
                rmSync(root, { recursive: true, force: true });
            }
        },
    );

    it('does not write verification metadata when export fails', async () => {
        const root = mkdtempSync(join(tmpdir(), 'omr-candidate-export-failure-'));
        const pdfPath = join(root, 'input.pdf');
        writeFileSync(pdfPath, 'failed export input');
        const pdfSha = sha256File(pdfPath);
        const options = optionsFingerprint();
        const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
        mkdirSync(dest, { recursive: true });
        copyFileSync(fixtureMxl, join(dest, 'legacy.mxl'));

        setCandidateRuntimeForTests({
            dockerExec: async (_container, args) => ({
                stdout: args[0] === 'node' ? ENGINE_VERSION : 'Audiveris 5.11.0',
                stderr: '',
            }),
            runAudiveris: async () => {
                throw new Error('fake export failed');
            },
        });

        try {
            await expect(fromPdf(pdfPath)).rejects.toThrow('fake export failed');
            expect(existsSync(join(dest, 'meta.json'))).toBe(false);
            expect(existsSync(join(dest, 'legacy.mxl'))).toBe(false);
        } finally {
            rmSync(dest, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('gives concurrent exports their own in-container paths and removes them', async () => {
        const root = mkdtempSync(join(tmpdir(), 'omr-candidate-concurrent-'));
        // A stand-in `docker` for the `cp` and Audiveris `exec` the exporter spawns
        // directly: log each call, and copy the fixture back for any cp out.
        const bin = join(root, 'bin');
        const log = join(root, 'docker.log');
        mkdirSync(bin);
        writeFileSync(
            join(bin, 'docker'),
            `#!/bin/sh\necho "$*" >> '${log}'\n` +
                `if [ "$1" = cp ] && [ "\${2#*:}" != "$2" ]; then cp '${fixtureMxl}' "$3"; fi\n`,
            { mode: 0o755 },
        );
        const pdfs = ['a', 'b'].map((name) => {
            const pdfPath = join(root, `${name}.pdf`);
            writeFileSync(pdfPath, `concurrent input ${name}`);
            return pdfPath;
        });
        const dests = pdfs.map((pdf) => join(artifactsCacheDir(), artifactCacheKey(sha256File(pdf))));
        const execs: string[][] = [];
        setCandidateRuntimeForTests({
            dockerExec: async (_container, args) => {
                execs.push(args);
                if (args[0] === 'node') {
                    return { stdout: ENGINE_VERSION, stderr: '' };
                }
                if (args[0] === 'find') {
                    return { stdout: `${args[1]}/omr-eval-input.mxl\n`, stderr: '' };
                }
                return { stdout: 'Audiveris 5.11.0', stderr: '' };
            },
        });
        const path = process.env.PATH;
        process.env.PATH = `${bin}:${path ?? ''}`;

        try {
            await Promise.all(pdfs.map((pdf) => fromPdf(pdf, true)));
            const workDirs = execs.filter((args) => args[0] === 'mkdir').map((args) => args[2] ?? '');
            expect(workDirs).toHaveLength(2);
            const [dirA, dirB] = workDirs.map((dir) => dir.replace(/\/out$/, ''));
            expect(dirA).not.toBe(dirB);
            const removed = execs.filter((args) => args[0] === 'rm').map((args) => args[2]);
            expect(removed.sort()).toEqual([dirA, dirB].sort());
            const copiedIn = readFileSync(log, 'utf8')
                .split('\n')
                .filter((line) => line.startsWith('cp ') && !line.split(' ')[1]?.includes(':'))
                .map((line) => line.split(' ')[2]?.split(':')[1]);
            expect(copiedIn.sort()).toEqual([`${dirA}/omr-eval-input.pdf`, `${dirB}/omr-eval-input.pdf`].sort());
        } finally {
            process.env.PATH = path;
            for (const dest of dests) {
                rmSync(dest, { recursive: true, force: true });
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});
