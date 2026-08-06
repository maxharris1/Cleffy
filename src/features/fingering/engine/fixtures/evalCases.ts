/**
 * Small committed fingering eval cases (CI). Optional full PIG inventory via
 * scripts/eval-fingering-pig.mjs when PIG_DIR is set (parse counts only).
 */

export interface EvalFixtureNote {
    id: string;
    midi: number;
    staff: 'upper' | 'lower';
    eventIndex: number;
    /** Optional ground-truth finger for match-rate checks. */
    truthFinger?: 1 | 2 | 3 | 4 | 5;
}

export interface EvalFixture {
    id: string;
    description: string;
    /** Expect IFR === 0 after suggestForRegion. */
    expectPlayable: boolean;
    notes: EvalFixtureNote[];
}

export const EVAL_FIXTURES: EvalFixture[] = [
    {
        id: 'c-major-triad',
        description: 'RH C-E-G should finger 1-3-5 with IFR 0',
        expectPlayable: true,
        notes: [
            { id: 'c', midi: 60, staff: 'upper', eventIndex: 0, truthFinger: 1 },
            { id: 'e', midi: 64, staff: 'upper', eventIndex: 0, truthFinger: 3 },
            { id: 'g', midi: 67, staff: 'upper', eventIndex: 0, truthFinger: 5 },
        ],
    },
    {
        id: 'gymnopedie-pack',
        description: 'B3–D4–F#4–F#5 all RH — redistribute then IFR 0',
        expectPlayable: true,
        notes: [
            { id: 'b3', midi: 59, staff: 'upper', eventIndex: 0 },
            { id: 'd4', midi: 62, staff: 'upper', eventIndex: 0 },
            { id: 'fs4', midi: 66, staff: 'upper', eventIndex: 0 },
            { id: 'fs5', midi: 78, staff: 'upper', eventIndex: 0 },
        ],
    },
    {
        id: 'impossible-octaves',
        description: 'Six notes an octave apart — no playable split, IFR > 0',
        expectPlayable: false,
        notes: [36, 48, 60, 72, 84, 96].map((midi, i) => ({
            id: `n${i}`,
            midi,
            staff: 'upper' as const,
            eventIndex: 0,
        })),
    },
];
