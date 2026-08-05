import {
    comfortDeficit,
    naturalSpan,
    relaxedDeficit,
    type HandSpan,
} from '@/features/fingering/engine/span';
import type { Finger } from '@/features/fingering/model';

/**
 * Parncutt-subset cost rules (with Jacobs-style refinements). All costs are
 * pure functions of finger/pitch geometry in right-hand orientation; the left
 * hand is solved mirrored. Weights live in one place so golden tests pin
 * behavior and tuning is one diff.
 *
 * Context matters and the rules encode it deliberately:
 * - CHORDS are held shapes → relaxed-span stretch applies, but black-key
 *   finger choice is free (thumb on a black key in a B♭ chord is normal).
 * - MELODIC lines are passing motion → comfort-span stretch applies, and
 *   thumb-on-black / pinky-on-black are penalized (the classic scale rules).
 */
export const WEIGHTS = {
    /** Within-chord stretch beyond the relaxed span (per semitone²). */
    stretch: 1.0,
    /** Cross-event stretch beyond the COMFORT span (per semitone²). */
    stretchTrans: 0.35,
    /** Deviation from the pair's natural (resting) span, per semitone. */
    naturalDev: 0.1,
    /** Transitions: over-extension hurts more than curling fingers together. */
    naturalDevTransStretch: 0.08,
    naturalDevTransCompress: 0.05,
    /** Weak-finger nudges (Jacobs: 4 is the weak one; 5 anchors fine). */
    weak4: 0.15,
    weak5: 0.1,
    /** Melodic-only: thumb / pinky landing on a black key mid-line. */
    thumbBlack: 2.5,
    fiveBlack: 0.4,
    /** Thumb passes: base cost by the finger crossed. Crossing around the
     * pinky is essentially never taught — priced accordingly. */
    passUnder2: 1.5,
    passUnder3: 1.7,
    passUnder4: 2.2,
    passUnder5: 6.0,
    /** Thumb LANDING on a black key during a pass is awkward… */
    passOntoBlack: 1.0,
    /** …while pivoting over a LONG finger on a black key is the classic easy
     * pass (chromatic 1-3, D♭ major). Short finger 2 earns almost nothing. */
    passFromBlackLong: -0.6,
    passFromBlackShort: -0.1,
    /** Non-thumb finger crossings are almost never idiomatic. */
    awkwardCross: 8.0,
    /** Same finger on a new pitch breaks legato. */
    sameFinger: 10.0,
    /** Finger substitution on a repeated pitch (mild). */
    substitution: 0.2,
    /** Hand relocation: free window, then per-semitone + fixed. */
    shiftFree: 3,
    shiftPerSemitone: 0.15,
    shiftFixed: 0.4,
} as const;

/** Typical offset of each finger from the thumb in a relaxed hand position. */
const HAND_OFFSET: Record<Finger, number> = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7 };

export interface EventGeometry {
    /** Ascending pitches (right-hand geometry; mirrored for LH). */
    midis: readonly number[];
    /** Black-key flags for the ORIGINAL keys (survive LH mirroring). */
    blacks: readonly boolean[];
}

/** Estimated hand anchor (thumb position) implied by an assignment. */
export const handPosition = (midis: readonly number[], fingers: readonly Finger[]): number => {
    let sum = 0;
    for (let i = 0; i < midis.length; i++) {
        sum += (midis[i] as number) - HAND_OFFSET[fingers[i] as Finger];
    }
    return sum / Math.max(1, midis.length);
};

/** Cost of holding one event with one assignment. */
export const unaryCost = (event: EventGeometry, fingers: readonly Finger[], hand: HandSpan = 'standard'): number => {
    const isChord = fingers.length > 1;
    let cost = 0;
    for (let i = 0; i < fingers.length; i++) {
        const finger = fingers[i] as Finger;
        if (finger === 4) {
            cost += WEIGHTS.weak4;
        } else if (finger === 5) {
            cost += WEIGHTS.weak5;
        }
        // Black-key comfort rules are about PASSING motion — a held chord may
        // put any finger on any key (B♭ major chord is 1-3-5, thumb on B♭).
        if (!isChord && event.blacks[i]) {
            if (finger === 1) {
                cost += WEIGHTS.thumbBlack;
            } else if (finger === 5) {
                cost += WEIGHTS.fiveBlack;
            }
        }
        if (i + 1 < fingers.length) {
            const span = (event.midis[i + 1] as number) - (event.midis[i] as number);
            const next = fingers[i + 1] as Finger;
            const deficit = relaxedDeficit(finger, next, span, hand);
            cost += WEIGHTS.stretch * deficit * deficit;
            cost += WEIGHTS.naturalDev * Math.abs(span - naturalSpan(finger, next));
        }
    }
    return cost;
};

const PASS_COST: Record<number, number> = {
    2: WEIGHTS.passUnder2,
    3: WEIGHTS.passUnder3,
    4: WEIGHTS.passUnder4,
    5: WEIGHTS.passUnder5,
};

/** Cost of one melodic connection (prev note → next note). */
const pairTransitionCost = (
    fPrev: Finger,
    pPrev: number,
    prevBlack: boolean,
    fCur: Finger,
    pCur: number,
    curBlack: boolean,
    hand: HandSpan,
): number => {
    const d = pCur - pPrev;
    if (fPrev === fCur) {
        return d === 0 ? 0 : WEIGHTS.sameFinger;
    }
    if (d === 0) {
        return WEIGHTS.substitution;
    }
    const thumbPassUp = fCur === 1 && fPrev > 1 && d > 0;
    const thumbPassDown = fPrev === 1 && fCur > 1 && d < 0;
    if (thumbPassUp || thumbPassDown) {
        const crossed = thumbPassUp ? fPrev : fCur;
        const thumbLandsBlack = thumbPassUp ? curBlack : prevBlack;
        const pivotOnBlack = thumbPassUp ? prevBlack : curBlack;
        let cost = PASS_COST[crossed] ?? WEIGHTS.passUnder4;
        if (thumbLandsBlack) {
            cost += WEIGHTS.passOntoBlack;
        }
        if (pivotOnBlack) {
            cost += crossed >= 3 ? WEIGHTS.passFromBlackLong : WEIGHTS.passFromBlackShort;
        }
        return cost;
    }
    // Fingers ordered against pitch direction without the thumb: a real cross.
    const ordered = d > 0 ? fCur > fPrev : fCur < fPrev;
    if (!ordered) {
        return WEIGHTS.awkwardCross;
    }
    // Consistent direction: comfort-range stretch (never more than simply
    // relocating the hand — a big leap is a shift, not a stretch) plus a mild
    // preference for the pair whose natural span matches the interval.
    const low = Math.min(fPrev, fCur) as Finger;
    const high = Math.max(fPrev, fCur) as Finger;
    const span = fPrev < fCur ? d : -d;
    const deficit = comfortDeficit(low, high, span, hand);
    const stretch = WEIGHTS.stretchTrans * deficit * deficit;
    const relocate = WEIGHTS.shiftFixed + WEIGHTS.shiftPerSemitone * Math.abs(d);
    const dev = span - naturalSpan(low, high);
    const devCost = dev > 0 ? WEIGHTS.naturalDevTransStretch * dev : WEIGHTS.naturalDevTransCompress * -dev;
    return Math.min(stretch, relocate) + devCost;
};

/** Cost of moving from one event's assignment to the next's. */
export const transitionCost = (
    prev: EventGeometry,
    prevFingers: readonly Finger[],
    cur: EventGeometry,
    curFingers: readonly Finger[],
    hand: HandSpan = 'standard',
): number => {
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < prevFingers.length; i++) {
        for (let j = 0; j < curFingers.length; j++) {
            pairSum += pairTransitionCost(
                prevFingers[i] as Finger,
                prev.midis[i] as number,
                prev.blacks[i] === true,
                curFingers[j] as Finger,
                cur.midis[j] as number,
                cur.blacks[j] === true,
                hand,
            );
            pairCount++;
        }
    }
    // Average across pairs so chords aren't punished for having more notes.
    const pairCost = pairCount > 0 ? pairSum / pairCount : 0;

    const shift = Math.abs(handPosition(cur.midis, curFingers) - handPosition(prev.midis, prevFingers));
    const excess = Math.max(0, shift - WEIGHTS.shiftFree);
    const shiftCost = excess > 0 ? WEIGHTS.shiftFixed + WEIGHTS.shiftPerSemitone * excess : 0;

    return pairCost + shiftCost;
};
