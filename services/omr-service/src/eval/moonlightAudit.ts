import { compositeScore, type EvalResult, type MovementMetrics } from './compare.js';
import type { EvalRecord } from './report.js';

/**
 * Headline snapshot from the 2026-09-07 Moonlight audit of
 * `dcca6082-3b58-42a6-a643-de6f196ef9f9` (engine `audiveris-5.11.0+svc-11`).
 * Used only when this host has no `score_analyses` row. Re-generate the
 * committed baseline with `--from document … --out baseline-svc-11.json`
 * on a machine that has the analysis.
 */
const movement = (
    name: string,
    counts: {
        refNotes: number;
        matched: number;
        exact: number;
        missing: number;
        extra: number;
        octave: number;
        semitone: number;
        handErr: number;
        refBars: number;
        omrPrintedBars: number;
        omrPerformedBars: number;
        barsImperfect: number;
        barsAtCorrectLength: number;
        barsUnderWrongKey: number;
        tempoBpm: number;
        tempoInRange: boolean;
        performedBarsMatch: boolean;
        velocityDistinct: number;
    },
): MovementMetrics => ({
    name,
    refBars: counts.refBars,
    omrPrintedBars: counts.omrPrintedBars,
    omrPerformedBars: counts.omrPerformedBars,
    refNotes: counts.refNotes,
    omrNotes: counts.matched + counts.extra + counts.octave + counts.semitone,
    pitchMatch: (100 * counts.matched) / counts.refNotes,
    exact: (100 * counts.exact) / counts.refNotes,
    missing: counts.missing,
    extra: counts.extra,
    octave: counts.octave,
    semitone: counts.semitone,
    handErr: counts.handErr,
    barsImperfect: counts.barsImperfect,
    refOnly: 0,
    omrOnly: 0,
    merge2: 5,
    barsAtCorrectLength: counts.barsAtCorrectLength,
    melodySurvival: 100,
    melodyTotal: 0,
    melodyFound: 0,
    barsUnderWrongKey: counts.barsUnderWrongKey,
    tempoInRange: counts.tempoInRange,
    tempoBpm: counts.tempoBpm,
    performedBarsMatch: counts.performedBarsMatch,
    velocityDistinct: counts.velocityDistinct,
});

export const moonlightAuditResult = (): EvalResult => {
    const movements = [
        movement('I. Adagio sostenuto', {
            refNotes: 1142,
            matched: 782,
            exact: 293,
            missing: 282,
            extra: 43,
            octave: 8,
            semitone: 70,
            handErr: 100,
            refBars: 69,
            omrPrintedBars: 66,
            omrPerformedBars: 69,
            barsImperfect: 63,
            barsAtCorrectLength: 4,
            barsUnderWrongKey: 12,
            tempoBpm: 66,
            tempoInRange: true,
            performedBarsMatch: true,
            velocityDistinct: 4,
        }),
        movement('II. Allegretto', {
            refNotes: 373,
            matched: 344,
            exact: 315,
            missing: 23,
            extra: 28,
            octave: 1,
            semitone: 5,
            handErr: 15,
            refBars: 61,
            omrPrintedBars: 65,
            omrPerformedBars: 113,
            barsImperfect: 31,
            barsAtCorrectLength: 106,
            barsUnderWrongKey: 0,
            tempoBpm: 116,
            tempoInRange: true,
            performedBarsMatch: false,
            velocityDistinct: 3,
        }),
        movement('III. Presto agitato', {
            refNotes: 4863,
            matched: 3670,
            exact: 3169,
            missing: 738,
            extra: 219,
            octave: 42,
            semitone: 413,
            handErr: 228,
            refBars: 201,
            omrPrintedBars: 199,
            omrPerformedBars: 262,
            barsImperfect: 150,
            barsAtCorrectLength: 139,
            barsUnderWrongKey: 52,
            tempoBpm: 96,
            tempoInRange: false,
            performedBarsMatch: false,
            velocityDistinct: 5,
        }),
    ];
    const refNotes = movements.reduce((n, m) => n + m.refNotes, 0);
    const omrNotes = movements.reduce((n, m) => n + m.omrNotes, 0);
    const pitchMatched = movements.reduce((n, m) => n + (m.pitchMatch / 100) * m.refNotes, 0);
    const exact = movements.reduce((n, m) => n + (m.exact / 100) * m.refNotes, 0);
    const missing = movements.reduce((n, m) => n + m.missing, 0);
    const extra = movements.reduce((n, m) => n + m.extra, 0);
    const octave = movements.reduce((n, m) => n + m.octave, 0);
    const semitone = movements.reduce((n, m) => n + m.semitone, 0);
    const draft: Omit<EvalResult, 'composite'> = {
        slug: 'moonlight',
        title: 'Beethoven — Piano Sonata No. 14, Op. 27 No. 2',
        movements,
        overall: {
            refNotes,
            omrNotes,
            pitchMatch: (100 * pitchMatched) / refNotes,
            exact: (100 * exact) / refNotes,
            missing,
            extra,
            octave,
            semitone,
            velocityDistinct: 6,
        },
        structure: {
            movementCountOk: true,
            metersOk: true,
            warnings: [
                'meter_suspect',
                'rhythm_repaired',
                'measure_overfull',
                'tempo_inferred',
                'ornaments_realized',
                'measure_underfull',
                'multi_part_collapsed',
                'multiple_movements_concatenated',
                'measure_geometry_mismatch',
                'repeats_unrolled',
                'pedal_inferred',
            ],
        },
        bars: {},
    };
    return { ...draft, composite: compositeScore(draft) };
};

export const moonlightAuditRecord = (): EvalRecord => ({
    ...moonlightAuditResult(),
    generatedAt: '2026-09-07T13:49:33.000Z',
    engineVersion: 'audiveris-5.11.0+svc-11',
    candidateSource: 'document',
    audiverisCacheHit: null,
    artifactHash: null,
    audiverisVersion: 'audiveris-5.11.0+svc-11',
    audiverisOptions: '-option Book.Lyrics=false',
});
