import { describe, expect, it } from 'vitest';

import type { EvalRecord } from './report.js';
import {
    assertBaselineWritable,
    assertResultFileName,
    diffBaseline,
    formatDeltas,
    IncomparableBaselineError,
    loadBaseline,
} from './report.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HASH = 'a'.repeat(64);

const record = (
    pitch: number,
    exact: number,
    missing: number,
    composite: number,
    extra: Partial<EvalRecord> = {},
): EvalRecord => ({
    slug: 'toy',
    title: 'Toy',
    movements: [
        {
            name: 'I',
            refBars: 1,
            omrPrintedBars: 1,
            omrPerformedBars: 1,
            refNotes: 10,
            omrNotes: 10,
            pitchMatch: pitch,
            exact,
            missing,
            extra: 0,
            octave: 0,
            semitone: 0,
            handErr: 0,
            barsImperfect: 0,
            refOnly: 0,
            omrOnly: 0,
            merge2: 0,
            barsAtCorrectLength: 1,
            melodySurvival: 100,
            melodyTotal: 0,
            melodyFound: 0,
            barsUnderWrongKey: 0,
            tempoInRange: true,
            tempoBpm: 100,
            performedBarsMatch: true,
            velocityDistinct: 1,
        },
    ],
    overall: {
        refNotes: 10,
        omrNotes: 10,
        pitchMatch: pitch,
        exact,
        missing,
        extra: 0,
        octave: 0,
        semitone: 0,
        velocityDistinct: 1,
    },
    structure: { movementCountOk: true, metersOk: true, warnings: [] },
    composite,
    bars: { I: [] },
    generatedAt: '2026-09-08T00:00:00.000Z',
    engineVersion: 'audiveris-5.11.0+svc-11',
    candidateSource: 'artifacts',
    audiverisCacheHit: null,
    artifactHash: HASH,
    audiverisVersion: 'audiveris-5.11.0+svc-11',
    audiverisOptions: '-option Book.Lyrics=false',
    ...extra,
});

describe('diffBaseline', () => {
    it('flags a pitch regression beyond tolerance', () => {
        const deltas = diffBaseline(record(68.5, 25.7, 282, 70), record(67.0, 25.7, 282, 70), 0.5);
        const pitch = deltas.find((d) => d.path === 'overall.pitchMatch');
        expect(pitch?.regressed).toBe(true);
        expect(formatDeltas(deltas)).toContain('REGRESSED');
    });

    it('accepts a small improvement', () => {
        const deltas = diffBaseline(record(68.5, 25.7, 282, 70), record(69.0, 26.0, 280, 71), 0.5);
        expect(deltas.every((d) => !d.regressed)).toBe(true);
    });

    it('flags movementCountOk and merge2', () => {
        const before = record(90, 80, 1, 80);
        const after = record(90, 80, 1, 80, {
            structure: { movementCountOk: false, metersOk: true, warnings: [] },
            movements: [{ ...before.movements[0]!, merge2: 2, barsAtCorrectLength: 1 }],
        });
        const deltas = diffBaseline(before, after, 0.5);
        expect(deltas.find((d) => d.path === 'structure.movementCountOk')?.regressed).toBe(true);
        expect(deltas.find((d) => d.path === 'movements.0.merge2')?.regressed).toBe(true);
    });

    it('refuses a null artifactHash (exit 2)', () => {
        expect(() =>
            diffBaseline(record(90, 80, 1, 80, { artifactHash: null }), record(90, 80, 1, 80), 0.5),
        ).toThrow(IncomparableBaselineError);
        try {
            diffBaseline(record(90, 80, 1, 80, { artifactHash: null }), record(90, 80, 1, 80), 0.5);
        } catch (err) {
            expect(err).toBeInstanceOf(IncomparableBaselineError);
            expect((err as IncomparableBaselineError).exitCode).toBe(2);
        }
    });

    it('treats hash mismatch as exit 1', () => {
        try {
            diffBaseline(record(90, 80, 1, 80), record(90, 80, 1, 80, { artifactHash: 'b'.repeat(64) }), 0.5);
            throw new Error('expected IncomparableBaselineError');
        } catch (err) {
            expect(err).toBeInstanceOf(IncomparableBaselineError);
            expect((err as IncomparableBaselineError).exitCode).toBe(1);
        }
    });
});

describe('assertResultFileName', () => {
    it('rejects path traversal', () => {
        expect(() => assertResultFileName('../../../package.json')).toThrow(/basename/);
        expect(() => assertResultFileName('foo/bar.json')).toThrow(/basename/);
    });

    it('accepts a basename', () => {
        expect(assertResultFileName('baseline.json')).toBe('baseline.json');
    });
});

describe('assertBaselineWritable', () => {
    it('refuses document mode and null hashes', () => {
        const rec = record(90, 80, 1, 80);
        expect(() => assertBaselineWritable({ ...rec, candidateSource: 'document' }, 'baseline.json')).toThrow(
            /document/,
        );
        expect(() => assertBaselineWritable({ ...rec, candidateSource: 'score' }, 'baseline.json')).toThrow(
            /score/,
        );
        expect(() => assertBaselineWritable({ ...rec, artifactHash: null }, 'baseline-svc-11.json')).toThrow(
            /artifactHash/,
        );
        expect(() => assertBaselineWritable(rec, 'baseline.json')).not.toThrow();
    });
});

describe('loadBaseline', () => {
    it('rejects barsAtCorrectLength greater than printed bars', () => {
        const dir = join(tmpdir(), `omr-eval-baseline-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'bad.json');
        const bad = record(90, 80, 1, 80);
        bad.movements[0] = { ...bad.movements[0]!, omrPrintedBars: 65, barsAtCorrectLength: 106 };
        writeFileSync(path, JSON.stringify(bad));
        expect(() => loadBaseline(path)).toThrow(/barsAtCorrectLength/);
        rmSync(dir, { recursive: true, force: true });
    });
});
