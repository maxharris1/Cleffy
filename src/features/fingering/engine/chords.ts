import { withinPractical, type HandSpan } from '@/features/fingering/engine/span';
import type { Finger, Hand } from '@/features/fingering/model';

/**
 * Candidate finger assignments for one event (right-hand geometry): strictly
 * increasing finger combinations over ascending pitches — within one chord
 * fingers never cross — pruned to physically playable spans. At most
 * C(5,k) = 10 states per event, which keeps the DP tiny.
 */

const ALL_FINGERS: Finger[] = [1, 2, 3, 4, 5];

const combinations = (k: number): Finger[][] => {
    const result: Finger[][] = [];
    const walk = (start: number, acc: Finger[]) => {
        if (acc.length === k) {
            result.push([...acc]);
            return;
        }
        for (let i = start; i < ALL_FINGERS.length; i++) {
            acc.push(ALL_FINGERS[i] as Finger);
            walk(i + 1, acc);
            acc.pop();
        }
    };
    walk(0, []);
    return result;
};

/**
 * States for a chord of ascending `midis` (1..5 notes). Adjacent chord
 * members and the outer pair must sit within practical spans. An empty
 * result means the chord is unplayable as one hand-shape (or has >5 notes) —
 * the caller leaves it unfingered.
 */
export const enumerateStates = (midis: readonly number[], hand: HandSpan = 'standard'): Finger[][] => {
    const k = midis.length;
    if (k === 0 || k > 5) {
        return [];
    }
    return combinations(k).filter((fingers) => {
        for (let i = 0; i + 1 < k; i++) {
            const span = (midis[i + 1] as number) - (midis[i] as number);
            if (!withinPractical(fingers[i] as Finger, fingers[i + 1] as Finger, span, hand)) {
                return false;
            }
        }
        if (k > 2) {
            const outerSpan = (midis[k - 1] as number) - (midis[0] as number);
            if (!withinPractical(fingers[0] as Finger, fingers[k - 1] as Finger, outerSpan, hand)) {
                return false;
            }
        }
        return true;
    });
};

/** True when `midis` form a physically playable one-hand shape (or empty). */
export const isFingerableChord = (
    midis: readonly number[],
    hand: Hand,
    handSpan: HandSpan = 'standard',
): boolean => {
    if (midis.length === 0) {
        return true;
    }
    if (midis.length > 5) {
        return false;
    }
    const sorted = [...midis].sort((a, b) => a - b);
    // LH uses mirrored geometry (same as suggestFingerings).
    const geometry = hand === 'L' ? sorted.map((m) => -m).sort((a, b) => a - b) : sorted;
    return enumerateStates(geometry, handSpan).length > 0;
};
