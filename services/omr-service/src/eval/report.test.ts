import { describe, expect, it } from 'vitest';

import type { EvalRecord } from './report.js';
import { diffBaseline, formatDeltas } from './report.js';

const record = (pitch: number, exact: number, missing: number, composite: number): EvalRecord => ({
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
    bars: {},
    generatedAt: '2026-09-08T00:00:00.000Z',
    engineVersion: 'audiveris-5.11.0+svc-11',
    candidateSource: 'document',
    audiverisCacheHit: null,
    artifactHash: null,
    audiverisVersion: 'audiveris-5.11.0+svc-11',
    audiverisOptions: '-option Book.Lyrics=false',
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
});
