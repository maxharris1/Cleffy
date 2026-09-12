import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TICKS_PER_QUARTER, type ScoreData } from '../scoreData.js';
import { fromArtifacts, fromScoreFile } from './candidate.js';
import { loadCorpusEntry } from './manifest.js';
import { packageRoot } from './paths.js';
import {
    assertHostedEvalUrl,
    compareShootout,
    formatShootout,
    HOSTED_PROJECT_REF,
    overfullTicks,
    parseEnvFile,
    pdfShaMatch,
    type ShootoutReport,
} from './shootout.js';

const measure = (n: number, tick: number, dTicks: number) => ({
    n,
    tick,
    dTicks,
    page: 0,
    sys: 0,
    x0: 0,
    x1: 1,
});

const scoreOf = (measures: ScoreData['measures']): ScoreData => ({
    version: 3,
    ticksPerQuarter: TICKS_PER_QUARTER,
    defaultBpm: 72,
    timeSignatures: [{ tick: 0, num: 3, den: 8 }],
    totalTicks: measures.reduce((sum, m) => sum + m.dTicks, 0) || 720,
    notes: [{ t: 0, d: 120, p: 76, h: 0 }],
    measures: measures.length > 0 ? measures : [measure(1, 0, 720)],
    systems: [{ page: 0, y0: 0.1, y1: 0.4 }],
    warnings: [],
});

describe('assertHostedEvalUrl', () => {
    it('accepts the production project URL', () => {
        expect(assertHostedEvalUrl(`https://${HOSTED_PROJECT_REF}.supabase.co`)).toBe(
            `https://${HOSTED_PROJECT_REF}.supabase.co`,
        );
    });

    it('refuses local and other projects', () => {
        expect(() => assertHostedEvalUrl('http://127.0.0.1:54421')).toThrow(/hosted-only/);
        expect(() => assertHostedEvalUrl('https://qdbnlrgylelelvwbkvnm.supabase.co')).toThrow(/hosted-only/);
    });
});

describe('parseEnvFile', () => {
    it('skips comments and strips quotes', () => {
        const parsed = parseEnvFile('# x\nVITE_SUPABASE_URL="https://example.supabase.co"\nEMPTY=\n');
        expect(parsed.VITE_SUPABASE_URL).toBe('https://example.supabase.co');
        expect(parsed.EMPTY).toBe('');
    });
});

describe('overfullTicks', () => {
    it('counts extra ticks past the meter (pickup underfull is ignored)', () => {
        // 3/8 => 720 ticks. Pickup 240 is short; 1200 is 480 over.
        const score = scoreOf([measure(0, 0, 240), measure(1, 240, 720), measure(2, 960, 1200)]);
        expect(overfullTicks(score)).toEqual({ bars: 1, extraTicks: 480 });
    });
});

describe('pdfShaMatch', () => {
    const sha = 'ab'.repeat(32);
    it('is true only when both shas are present and equal', () => {
        expect(pdfShaMatch(sha, sha)).toBe(true);
        expect(pdfShaMatch(sha, 'cd'.repeat(32))).toBe(false);
        expect(pdfShaMatch(sha, null)).toBe(null);
        expect(pdfShaMatch(null, null)).toBe(null);
    });
});

describe('formatShootout', () => {
    const report = (identical: boolean | null): ShootoutReport => ({
        slug: 'fur-elise',
        title: 'Für Elise',
        pdfIdentical: identical,
        prod: {
            engineVersion: 'audiveris-5.6.1+svc-4',
            composite: 61.4,
            pitchMatch: 71.3,
            exact: 30.7,
            missing: 198,
            extra: 194,
            overfullBars: 2,
            overfullTicks: 480,
            pdfSha256: 'aa'.repeat(32),
        },
        local: {
            engineVersion: 'audiveris-5.11.0+svc-16',
            composite: 60.3,
            pitchMatch: 69.4,
            exact: 29.4,
            missing: 203,
            extra: 229,
            overfullBars: 3,
            overfullTicks: 840,
            pdfSha256: identical === true ? 'aa'.repeat(32) : identical === false ? 'bb'.repeat(32) : null,
        },
    });

    it('states whether PDF bytes were identical', () => {
        expect(formatShootout(report(true))).toContain('inputs were identical');
        expect(formatShootout(report(false))).toContain('not an apples-to-apples');
        expect(formatShootout(report(null))).toContain('unknown');
    });
});

describe('fromScoreFile', () => {
    it('loads ScoreData and engine from sibling meta.json', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'omr-eval-score-'));
        mkdirSync(dir, { recursive: true });
        const scorePath = join(dir, 'score.json');
        writeFileSync(scorePath, JSON.stringify(scoreOf([measure(1, 0, 720)])));
        writeFileSync(
            join(dir, 'meta.json'),
            JSON.stringify({ side: 'prod', engineVersion: 'audiveris-5.6.1+svc-4', pdfSha256: 'ab'.repeat(32) }),
        );
        const candidate = await fromScoreFile(scorePath);
        expect(candidate.source).toBe('score');
        expect(candidate.engineVersion).toBe('audiveris-5.6.1+svc-4');
        expect(candidate.score.notes).toHaveLength(1);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('compareShootout', () => {
    it('scores two ScoreData dumps against the same toy MIDI and reports sha identity', async () => {
        const sha = 'ab'.repeat(32);
        const candidate = await fromArtifacts(join(packageRoot(), 'eval/fixtures/toy'));
        const root = mkdtempSync(join(tmpdir(), 'omr-eval-shootout-'));
        const prodDir = join(root, 'prod');
        const localDir = join(root, 'local');
        mkdirSync(prodDir);
        mkdirSync(localDir);
        writeFileSync(join(prodDir, 'score.json'), JSON.stringify(candidate.score));
        writeFileSync(join(localDir, 'score.json'), JSON.stringify(candidate.score));
        writeFileSync(
            join(prodDir, 'meta.json'),
            JSON.stringify({ side: 'prod', engineVersion: 'prod-engine', pdfSha256: sha }),
        );
        writeFileSync(
            join(localDir, 'meta.json'),
            JSON.stringify({ side: 'local', engineVersion: 'local-engine', pdfSha256: sha }),
        );
        const { report, outDir } = await compareShootout(
            loadCorpusEntry('toy'),
            join(prodDir, 'score.json'),
            join(localDir, 'score.json'),
        );
        expect(report.pdfIdentical).toBe(true);
        expect(report.prod.composite).toBe(report.local.composite);
        expect(report.prod.engineVersion).toBe('prod-engine');
        expect(report.local.engineVersion).toBe('local-engine');
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });
});
