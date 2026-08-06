import type { ScoreData, ScoreMeasure, ScoreNote, ScoreTimeSig } from '@/types/scoreData';
import { TICKS_PER_QUARTER } from '@/types/scoreData';

/**
 * Pure tick/measure/beat math shared by the playback engine, the playhead,
 * and the transport. Everything here is side-effect free and unit tested —
 * keep it that way (geometry.ts discipline).
 */

/** Seconds per tick at a given quarter-note BPM. */
export const secondsPerTick = (bpm: number): number => 60 / (bpm * TICKS_PER_QUARTER);

/** Ticks per beat for a time-signature denominator (den 4 → 480, den 8 → 240). */
export const ticksPerBeat = (den: number): number => (TICKS_PER_QUARTER * 4) / den;

const DEFAULT_TIME_SIG: ScoreTimeSig = { tick: 0, num: 4, den: 4 };

/** The time signature in effect at a tick (last change at or before it). */
export const timeSigAt = (timeSignatures: readonly ScoreTimeSig[], tick: number): ScoreTimeSig => {
    let active = timeSignatures[0] ?? DEFAULT_TIME_SIG;
    for (const sig of timeSignatures) {
        if (sig.tick > tick) {
            break;
        }
        active = sig;
    }
    return active;
};

/**
 * Index of the measure containing `tick` (greatest start ≤ tick), clamped to
 * the first/last measure for out-of-range ticks. Returns -1 only for an
 * empty measure list.
 */
export const measureIndexAtTick = (measures: readonly ScoreMeasure[], tick: number): number => {
    if (measures.length === 0) {
        return -1;
    }
    let lo = 0;
    let hi = measures.length - 1;
    if (tick <= (measures[0]?.tick ?? 0)) {
        return 0;
    }
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if ((measures[mid]?.tick ?? 0) <= tick) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
};

/** Fraction (0–1) of the way through a measure at `tick`. */
export const fractionWithinMeasure = (measure: ScoreMeasure, tick: number): number => {
    if (measure.dTicks <= 0) {
        return 0;
    }
    return Math.min(1, Math.max(0, (tick - measure.tick) / measure.dTicks));
};

/**
 * Horizontal playhead position within a measure, riding the engraved chord
 * columns when the analysis provides them (measure.sl): the line sits exactly
 * on each chord as it sounds and moves proportionally between columns — slow
 * through long values, quick through runs — instead of pretending time is
 * spaced evenly across the bar. Falls back to linear interpolation.
 */
export const xAtTickInMeasure = (measure: ScoreMeasure, tick: number): number => {
    const slots = measure.sl;
    if (!slots || slots.length === 0) {
        return measure.x0 + fractionWithinMeasure(measure, tick) * (measure.x1 - measure.x0);
    }
    const rel = Math.min(measure.dTicks, Math.max(0, tick - measure.tick));
    const first = slots[0];
    if (!first || rel <= first.t) {
        // The pre-slot zone is the measure header (clef/key/time) — no music
        // time lives there, so the line waits on the first chord column.
        return first ? first.x : measure.x0;
    }
    for (let i = 0; i + 1 < slots.length; i++) {
        const a = slots[i];
        const b = slots[i + 1];
        if (a && b && rel < b.t) {
            return a.x + ((rel - a.t) / (b.t - a.t)) * (b.x - a.x);
        }
    }
    const last = slots[slots.length - 1];
    if (!last) {
        return measure.x0;
    }
    const span = measure.dTicks - last.t;
    if (span <= 0) {
        return last.x;
    }
    return last.x + Math.min(1, (rel - last.t) / span) * (measure.x1 - last.x);
};

/**
 * Inverse of {@link xAtTickInMeasure}: tick within a measure at a normalized
 * page x. Used by the fingering OMR populator to turn a marquee into a tick
 * range. Clamps x to the measure span; pre-slot (header) x maps to the first
 * chord column's tick.
 */
export const tickAtXInMeasure = (measure: ScoreMeasure, nx: number): number => {
    const x = Math.min(measure.x1, Math.max(measure.x0, nx));
    const slots = measure.sl;
    if (!slots || slots.length === 0) {
        const width = measure.x1 - measure.x0;
        const frac = width <= 0 ? 0 : (x - measure.x0) / width;
        return measure.tick + Math.round(frac * measure.dTicks);
    }
    const first = slots[0];
    if (!first) {
        return measure.tick;
    }
    if (x <= first.x) {
        return measure.tick + first.t;
    }
    for (let i = 0; i + 1 < slots.length; i++) {
        const a = slots[i];
        const b = slots[i + 1];
        if (a && b && x < b.x) {
            const span = b.x - a.x;
            const frac = span <= 0 ? 0 : (x - a.x) / span;
            return measure.tick + Math.round(a.t + frac * (b.t - a.t));
        }
    }
    const last = slots[slots.length - 1];
    if (!last) {
        return measure.tick;
    }
    const tail = measure.x1 - last.x;
    if (tail <= 0) {
        return measure.tick + last.t;
    }
    const frac = Math.min(1, (x - last.x) / tail);
    return measure.tick + Math.round(last.t + frac * (measure.dTicks - last.t));
};

/**
 * Prev/next-measure stepping, with the standard transport nuance: stepping
 * back from >20% into a measure returns to that measure's own start first.
 * Returns the target start tick.
 */
export const stepMeasure = (measures: readonly ScoreMeasure[], tick: number, delta: -1 | 1): number => {
    const index = measureIndexAtTick(measures, tick);
    if (index < 0) {
        return 0;
    }
    const current = measures[index];
    if (!current) {
        return 0;
    }
    if (delta === 1) {
        const next = measures[index + 1];
        return next ? next.tick : current.tick;
    }
    if (tick - current.tick > current.dTicks * 0.2) {
        return current.tick;
    }
    const prev = measures[index - 1];
    return prev ? prev.tick : current.tick;
};

/** Lower bound: index of the first note starting at or after `tick`. */
export const firstNoteIndexAtOrAfter = (notes: readonly ScoreNote[], tick: number): number => {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((notes[mid]?.t ?? 0) < tick) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
};

/** Safety cap: no sane measure has more beats than this (guards corrupt data). */
const MAX_BEATS_PER_MEASURE = 64;

/**
 * The FELT pulse of a signature: compound meters (6/8, 9/8, 12/8) click in
 * dotted-quarter beats, not a hail of eighths.
 */
export const clickBeatTicks = (sig: ScoreTimeSig): number => {
    const base = ticksPerBeat(sig.den);
    return sig.den >= 8 && sig.num >= 6 && sig.num % 3 === 0 ? base * 3 : base;
};

/** Full notated bar length of a signature, in ticks. */
export const barTicks = (sig: ScoreTimeSig): number => sig.num * ticksPerBeat(sig.den);

export interface BeatTick {
    tick: number;
    /** True on real downbeats — never on pickups or truncated bars. */
    accent: boolean;
}

/**
 * Metronome beats within a measure, anchored to its barline. Pickups and
 * short/irregular bars get beats but no downbeat accent (a pickup is not
 * beat one).
 */
export const beatsForMeasure = (measure: ScoreMeasure, timeSignatures: readonly ScoreTimeSig[]): BeatTick[] => {
    const sig = timeSigAt(timeSignatures, measure.tick);
    const beat = clickBeatTicks(sig);
    const isFullBar = measure.dTicks >= barTicks(sig);
    const beats: BeatTick[] = [];
    for (let k = 0; k < MAX_BEATS_PER_MEASURE; k++) {
        const tick = measure.tick + k * beat;
        if (tick >= measure.tick + measure.dTicks) {
            break;
        }
        beats.push({ tick, accent: k === 0 && isFullBar });
    }
    return beats;
};

export interface CountInClick {
    /** Ticks BEFORE the start position (clicks are scheduled at start − offset). */
    offsetTicks: number;
    accent: boolean;
}

/**
 * Count-in clicks for entering at `startTick`: one full bar, plus the beats
 * of the entry bar that precede the entry point. Starting on a downbeat
 * gives the classic single bar; starting on a pickup (which occupies the END
 * of its notated bar) counts "ONE two three four, ONE two three…" so the
 * player comes in on the right beat.
 */
export const countInClicks = (score: ScoreData, startTick: number): CountInClick[] => {
    const sig = timeSigAt(score.timeSignatures, startTick);
    const beat = clickBeatTicks(sig);
    const fullBar = barTicks(sig);

    let posInBar = 0;
    const measure = score.measures[measureIndexAtTick(score.measures, startTick)];
    if (measure) {
        const shortfall = Math.max(0, fullBar - measure.dTicks);
        posInBar = Math.max(0, Math.min(fullBar - 1, shortfall + (startTick - measure.tick)));
    }
    // Snap odd entry points down onto the beat grid.
    posInBar = Math.floor(posInBar / beat) * beat;

    const entryBarStart = posInBar;
    const preBarStart = posInBar + fullBar;
    const clicks: CountInClick[] = [];
    for (let offset = preBarStart; offset > 0; offset -= beat) {
        clicks.push({ offsetTicks: offset, accent: offset === preBarStart || offset === entryBarStart });
    }
    return clicks;
};

/** Start tick of a measure by index, clamped to the score. */
export const measureStartTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const clamped = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return clamped ? clamped.tick : 0;
};

/** End tick (exclusive) of a measure by index. */
export const measureEndTick = (measures: readonly ScoreMeasure[], index: number): number => {
    const measure = measures[Math.min(measures.length - 1, Math.max(0, index))];
    return measure ? measure.tick + measure.dTicks : 0;
};

/**
 * Measure under a normalized point on a page (tap-to-seek). Matches the
 * system whose y-band contains the point, then the measure whose x-range
 * contains it. Returns the measure index, or -1.
 */
export const measureIndexAtPagePoint = (score: ScoreData, pageIndex: number, nx: number, ny: number): number => {
    for (let sysIndex = 0; sysIndex < score.systems.length; sysIndex++) {
        const system = score.systems[sysIndex];
        if (!system || system.page !== pageIndex || ny < system.y0 || ny > system.y1) {
            continue;
        }
        for (let i = 0; i < score.measures.length; i++) {
            const measure = score.measures[i];
            if (measure && measure.sys === sysIndex && nx >= measure.x0 && nx <= measure.x1) {
                return i;
            }
        }
    }
    return -1;
};
