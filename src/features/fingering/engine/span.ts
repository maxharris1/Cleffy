import type { Finger } from '@/features/fingering/model';

/**
 * Finger-pair span table (right-hand geometry, semitones), from Parncutt,
 * Sloboda, Clarke, Raekallio & Desain (1997). A span is the interval from the
 * LOWER finger number's key to the higher's; negative spans mean the fingers
 * are crossed (thumb passes live there).
 *
 * Two nested ranges matter: RELAXED is the ideal hand shape (used for chords,
 * which are HELD), COMFORT is what passing motion tolerates without strain
 * (used for melodic transitions). PRACTICAL is the physical limit.
 */
export interface SpanRange {
    minPrac: number;
    minComf: number;
    minRel: number;
    maxRel: number;
    maxComf: number;
    maxPrac: number;
}

/** Hand-size setting: children/small hands get tighter reach limits. */
export type HandSpan = 'small' | 'standard' | 'large';

const UPPER_SCALE: Record<HandSpan, number> = { small: 0.8, standard: 1, large: 1.12 };

const SPANS: Record<string, SpanRange> = {
    '1,2': { minPrac: -5, minComf: -3, minRel: 1, maxRel: 5, maxComf: 8, maxPrac: 10 },
    '1,3': { minPrac: -4, minComf: -2, minRel: 3, maxRel: 7, maxComf: 10, maxPrac: 12 },
    '1,4': { minPrac: -3, minComf: -1, minRel: 5, maxRel: 9, maxComf: 12, maxPrac: 14 },
    '1,5': { minPrac: -1, minComf: 1, minRel: 7, maxRel: 10, maxComf: 13, maxPrac: 15 },
    '2,3': { minPrac: 1, minComf: 1, minRel: 1, maxRel: 2, maxComf: 3, maxPrac: 5 },
    '2,4': { minPrac: 1, minComf: 1, minRel: 3, maxRel: 4, maxComf: 5, maxPrac: 7 },
    '2,5': { minPrac: 2, minComf: 2, minRel: 5, maxRel: 6, maxComf: 8, maxPrac: 10 },
    '3,4': { minPrac: 1, minComf: 1, minRel: 1, maxRel: 2, maxComf: 2, maxPrac: 4 },
    '3,5': { minPrac: 1, minComf: 1, minRel: 3, maxRel: 4, maxComf: 5, maxPrac: 7 },
    '4,5': { minPrac: 1, minComf: 1, minRel: 1, maxRel: 2, maxComf: 3, maxPrac: 5 },
};

const scaleUpper = (value: number, factor: number, floor: number): number =>
    Math.max(floor, Math.round(value * factor));

/** Span range for an unordered finger pair; `span` is measured low→high finger. */
export const spanRange = (a: Finger, b: Finger, hand: HandSpan = 'standard'): SpanRange => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const range = SPANS[key];
    if (!range) {
        throw new Error(`No span range for finger pair ${key}`);
    }
    if (hand === 'standard') {
        return range;
    }
    const factor = UPPER_SCALE[hand];
    // Only the upper (stretch) bounds scale with hand size; the crowded lower
    // bounds are about finger thickness, which doesn't shrink.
    const maxRel = scaleUpper(range.maxRel, factor, range.minRel);
    const maxComf = scaleUpper(range.maxComf, factor, maxRel);
    const maxPrac = scaleUpper(range.maxPrac, factor, maxComf);
    return { ...range, maxRel, maxComf, maxPrac };
};

/**
 * The pair's span in a resting five-finger hand position. This sits near the
 * BOTTOM of the relaxed range, not its midpoint — 1-5 across a fifth (span 7,
 * the C-position) is the most natural shape in piano playing, and the relaxed
 * range extends upward from it.
 */
export const naturalSpan = (a: Finger, b: Finger): number => {
    const range = spanRange(a, b);
    return range.minRel + 0.25 * (range.maxRel - range.minRel);
};

/** Semitones outside the RELAXED span (holding shapes — chords). */
export const relaxedDeficit = (a: Finger, b: Finger, span: number, hand: HandSpan = 'standard'): number => {
    const range = spanRange(a, b, hand);
    if (span < range.minRel) {
        return range.minRel - span;
    }
    if (span > range.maxRel) {
        return span - range.maxRel;
    }
    return 0;
};

/** Semitones outside the COMFORT span (passing motion — transitions). */
export const comfortDeficit = (a: Finger, b: Finger, span: number, hand: HandSpan = 'standard'): number => {
    const range = spanRange(a, b, hand);
    if (span < range.minComf) {
        return range.minComf - span;
    }
    if (span > range.maxComf) {
        return span - range.maxComf;
    }
    return 0;
};

/** Is the span physically playable at all? */
export const withinPractical = (a: Finger, b: Finger, span: number, hand: HandSpan = 'standard'): boolean => {
    const range = spanRange(a, b, hand);
    return span >= range.minPrac && span <= range.maxPrac;
};
