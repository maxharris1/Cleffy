import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fromArtifacts } from './candidate.js';
import { compareScore } from './compare.js';
import { loadCorpusEntry } from './manifest.js';
import { notesFromMidi } from './midiRef.js';
import { fetchCorpus, midiPath } from './fetch.js';
import { packageRoot } from './paths.js';
import { attachRecord, loadBaseline } from './report.js';
import { segmentMovements } from './segment.js';

const root = (): string => packageRoot();

const cliPath = (): string => join(root(), 'dist/eval/cli.js');

const ensureBuilt = (): void => {
    if (existsSync(cliPath())) {
        return;
    }
    execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root(), stdio: 'pipe' });
};

describe('eval CLI', () => {
    it('prints usage on --help and exits 0', () => {
        ensureBuilt();
        const out = execFileSync('node', [cliPath(), '--help'], { encoding: 'utf8' });
        expect(out).toContain('Usage:');
        expect(out).toContain('not an accuracy');
        expect(out).toContain('shootout');
    });

    it('scores the committed toy artifacts without network', async () => {
        ensureBuilt();
        const artifacts = join(root(), 'eval/fixtures/toy');
        const outName = `_ci-${process.pid}.json`;
        const outPath = join(root(), 'eval/results/toy', outName);
        const stdout = execFileSync(
            'node',
            [
                cliPath(),
                'run',
                '--piece',
                'toy',
                '--from',
                'artifacts',
                artifacts,
                '--json',
                '--out',
                outName,
                '--baseline',
                'eval/results/toy/baseline.json',
            ],
            { cwd: root(), encoding: 'utf8', env: { ...process.env } },
        );
        const record = JSON.parse(stdout.slice(0, stdout.indexOf('\nBaseline deltas:'))) as {
            artifactHash: string | null;
            movements: Array<{ barsAtCorrectLength: number; omrPrintedBars: number; pitchMatch: number }>;
            candidateSource: string;
        };
        expect(record.candidateSource).toBe('artifacts');
        expect(record.artifactHash).toMatch(/^[0-9a-f]{64}$/);
        for (const mov of record.movements) {
            expect(mov.barsAtCorrectLength).toBeLessThanOrEqual(mov.omrPrintedBars);
        }
        expect(record.movements[0]?.pitchMatch).toBeGreaterThan(0);
        rmSync(outPath, { force: true });
    });
});

describe('committed baselines', () => {
    it('are outputs this scorer can emit', async () => {
        const results = join(root(), 'eval/results');
        if (!existsSync(results)) {
            return;
        }
        const files: string[] = [];
        for (const slug of readdirSync(results)) {
            const dir = join(results, slug);
            for (const name of readdirSync(dir)) {
                if (name.startsWith('baseline') && name.endsWith('.json')) {
                    files.push(join(dir, name));
                }
            }
        }
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            const rec = loadBaseline(file);
            expect(rec.artifactHash, file).toMatch(/^[0-9a-f]{64}$/);
            for (const mov of rec.movements) {
                expect(mov.barsAtCorrectLength, `${file} ${mov.name}`).toBeLessThanOrEqual(mov.omrPrintedBars);
            }
        }
    });

    it('toy artifacts reproduce the committed baseline headlines', async () => {
        const entry = loadCorpusEntry('toy');
        const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'midi' });
        const candidate = await fromArtifacts(join(root(), 'eval/fixtures/toy'));
        const refs = [];
        for (const movement of entry.movements) {
            const buf = readFileSync(midiPath(fetched, movement.midi));
            refs.push(notesFromMidi(buf, movement));
        }
        const result = compareScore(candidate.score, entry, refs, segmentMovements(candidate.score, entry));
        const live = attachRecord(result, candidate);
        const baseline = loadBaseline(join(root(), 'eval/results/toy/baseline.json'));
        expect(live.artifactHash).toBe(baseline.artifactHash);
        expect(live.overall.pitchMatch).toBeCloseTo(baseline.overall.pitchMatch, 5);
        expect(live.movements[0]?.omrPrintedBars).toBe(baseline.movements[0]?.omrPrintedBars);
    });
});
