import type { StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';

/** What a group of handwriting was read as. */
export type RecognitionKind = 'digit' | 'symbol' | 'text';

export interface Recognition {
    /** The print text to create (ASCII token for symbols, e.g. `mf`). */
    text: string;
    kind: RecognitionKind;
}

/**
 * Closed-set reader over a flushed stroke group. Null = abstain, the ink
 * stays. Implementations must be conservative: a wrong `3` on a student's
 * page mid-lesson is worse than ugly ink.
 */
export type Recognizer = (group: StrokeGroup) => Promise<Recognition | null> | Recognition | null;
