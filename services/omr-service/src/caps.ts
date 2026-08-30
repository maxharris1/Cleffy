import type { ScoreHold, ScorePedal, ScoreTempo } from './scoreData.js';

/**
 * Ceilings the ScoreData schema enforces on the expressive event arrays. A
 * single engraved page never approaches them; unrolled repeats (which clone
 * every event they sweep) and shard concatenation both can, and a score that
 * breaches one fails its own self-check and is thrown away entirely. Thinning
 * costs a little nuance, so it is always the better trade.
 */
export const MAX_TEMPO_EVENTS = 512;
export const MAX_HOLDS = 128;
export const MAX_PEDAL_EDGES = 256;

/**
 * Bring a tempo map under the schema ceiling, spending the cheapest events first.
 *
 * `src: 'ramp'` points are a per-beat discretization of a rit./accel. (or the
 * return an "a tempo" makes), not tempos anyone wrote down: halving their
 * density leaves the curve landing within one beat of where it did, which is
 * inaudible. Printed marks — 'sound', 'metronome', 'word' — are irreplaceable
 * and only ever dropped by the truncation of last resort, which needs more than
 * `max` printed tempos in one score to trigger at all.
 */
export const capTempoEvents = (
    tempos: readonly ScoreTempo[],
    max = MAX_TEMPO_EVENTS,
): ScoreTempo[] => {
    let kept: ScoreTempo[] = [...tempos];
    while (kept.length > max) {
        let seen = 0;
        const thinned = kept.filter((tempo) => {
            if (tempo.src !== 'ramp') {
                return true;
            }
            return seen++ % 2 === 0;
        });
        // A single surviving ramp point (or none) cannot be halved again;
        // without this the loop would spin on an array it can no longer shrink.
        if (thinned.length === kept.length) {
            break;
        }
        kept = thinned;
    }
    return kept.length > max ? kept.slice(0, max) : kept;
};

/**
 * Bring fermatas under the schema ceiling by keeping the earliest.
 *
 * There is no musically cheaper hold to drop — every one of them is a printed
 * pause — so the rule is chosen for being deterministic and for keeping the
 * opening pages, which a practising reader plays far more often than the tail,
 * exactly as engraved.
 */
export const capHolds = (holds: readonly ScoreHold[], max = MAX_HOLDS): ScoreHold[] => {
    if (holds.length <= max) {
        return [...holds];
    }
    return [...holds].sort((a, b) => a.tick - b.tick).slice(0, max);
};

/**
 * Bring pedal edges under the ceiling, keeping the earliest for the same reason
 * fermatas do — plus one thing they do not need. A cut that lands on a `down`
 * leaves the pedal depressed for every bar after it, washing the tail of the
 * score into one chord, so an orphaned last depression goes with the cut.
 */
export const capPedals = (pedals: readonly ScorePedal[], max = MAX_PEDAL_EDGES): ScorePedal[] => {
    if (pedals.length <= max) {
        return [...pedals];
    }
    const kept = pedals.slice(0, max);
    if (kept[kept.length - 1]?.k === 'down') {
        kept.pop();
    }
    return kept;
};
