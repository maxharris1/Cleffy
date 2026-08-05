import type { Finger } from '@/features/fingering/model';

/**
 * Finger-pair span table (right-hand geometry, semitones), adapted from
 * Parncutt, Sloboda, Clarke, Raekallio & Desain (1997). A span is the
 * interval from the LOWER finger number's key to the higher's; negative
 * spans mean the fingers are crossed (thumb passes live there).
 *
 * [minPractical, minRelaxed, maxRelaxed, maxPractical]
 */
export interface SpanRange {
    minPrac: number;
    minRel: number;
    maxRel: number;
    maxPrac: number;
}

const SPANS: Record<string, SpanRange> = {
    '1,2': { minPrac: -5, minRel: 1, maxRel: 5, maxPrac: 10 },
    '1,3': { minPrac: -4, minRel: 3, maxRel: 7, maxPrac: 12 },
    '1,4': { minPrac: -3, minRel: 5, maxRel: 9, maxPrac: 14 },
    '1,5': { minPrac: -1, minRel: 7, maxRel: 10, maxPrac: 15 },
    '2,3': { minPrac: 1, minRel: 1, maxRel: 2, maxPrac: 5 },
    '2,4': { minPrac: 1, minRel: 3, maxRel: 4, maxPrac: 7 },
    '2,5': { minPrac: 2, minRel: 5, maxRel: 6, maxPrac: 10 },
    '3,4': { minPrac: 1, minRel: 1, maxRel: 2, maxPrac: 4 },
    '3,5': { minPrac: 1, minRel: 3, maxRel: 4, maxPrac: 7 },
    '4,5': { minPrac: 1, minRel: 1, maxRel: 2, maxPrac: 5 },
};

/** Span range for an unordered finger pair; `span` must be measured low→high finger. */
export const spanRange = (a: Finger, b: Finger): SpanRange => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const range = SPANS[key];
    if (!range) {
        throw new Error(`No span range for finger pair ${key}`);
    }
    return range;
};

/** Semitones outside the relaxed span (0 when comfortable). */
export const relaxedDeficit = (a: Finger, b: Finger, span: number): number => {
    const range = spanRange(a, b);
    if (span < range.minRel) {
        return range.minRel - span;
    }
    if (span > range.maxRel) {
        return span - range.maxRel;
    }
    return 0;
};

/** Is the span physically playable at all? */
export const withinPractical = (a: Finger, b: Finger, span: number): boolean => {
    const range = spanRange(a, b);
    return span >= range.minPrac && span <= range.maxPrac;
};
