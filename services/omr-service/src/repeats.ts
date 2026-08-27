import type { MeasureRepeatMarks } from './musicxml.js';

/**
 * Turn engraved repeat structure into the order the measures are actually
 * performed in.
 *
 * The output is an index list, so a bar played twice simply appears twice. That
 * is what lets unrolling be a structural clone downstream: measure geometry is
 * per-measure, so a duplicate with the same page/system/x-span sweeps the same
 * printed bar again for free.
 *
 * Scope is repeats and voltas only. D.C./D.S./Coda/Fine are text plus <sound>
 * attributes that Audiveris emits inconsistently or not at all — it produced
 * zero <grace> elements across an entire real score — and the failure costs are
 * asymmetric: a wrong repeat misplaces eight bars, a wrong D.S. reorders pages.
 */

export interface RepeatPlan {
    /** Measure indices in performance order. */
    order: number[];
    /** True when the structure could not be resolved and this is just linear. */
    degraded: boolean;
}

export interface RepeatLimits {
    /** Hard ceiling from the ScoreData schema; never ship a half-unrolled score. */
    maxMeasures: number;
}

const linear = (count: number, degraded: boolean): RepeatPlan => ({
    order: Array.from({ length: count }, (_, i) => i),
    degraded,
});

/**
 * One past the end of the volta bracket beginning at `from`.
 *
 * Only ONE bracket, deliberately: the pass that does not belong to a first
 * ending usually belongs to the second, so the caller must get the chance to
 * test the next bracket rather than being carried past every one of them.
 */
const pastEndingBlock = (marks: readonly MeasureRepeatMarks[], from: number): number => {
    let i = from;
    while (i < marks.length && !marks[i]?.endingStop) {
        i += 1;
    }
    return i + 1;
};

export const planRepeats = (
    marks: readonly MeasureRepeatMarks[],
    limits: RepeatLimits,
    isPickup: (index: number) => boolean = () => false,
): RepeatPlan => {
    const n = marks.length;
    if (n === 0) {
        return { order: [], degraded: false };
    }
    if (!marks.some((m) => m.repeatForward || m.repeatBackward)) {
        return linear(n, false);
    }

    // A backward repeat with no forward one returns to the top — but not into a
    // pickup, which is played once on the way in and never again.
    let firstReal = 0;
    while (firstReal < n && isPickup(firstReal)) {
        firstReal += 1;
    }

    let lastForward = Math.min(firstReal, n - 1);
    const passOf = new Map<number, number>();
    const order: number[] = [];
    let i = 0;
    const guard = 4 * n + 64;

    for (let steps = 0; ; steps++) {
        if (i >= n) {
            break;
        }
        if (steps > guard || order.length > limits.maxMeasures) {
            // Pathological structure, or a score whose unrolled length would
            // breach the schema cap. Degrade wholesale rather than truncate.
            return linear(n, true);
        }
        const mark = marks[i];
        if (!mark) {
            break;
        }

        if (mark.repeatForward) {
            lastForward = i;
            if (!passOf.has(i)) {
                passOf.set(i, 1);
            }
        }

        const pass = passOf.get(lastForward) ?? 1;
        if (mark.endingStart && !mark.endingStart.includes(pass)) {
            const skipTo = pastEndingBlock(marks, i);
            if (skipTo <= i) {
                return linear(n, true);
            }
            i = skipTo;
            continue;
        }

        order.push(i);

        if (mark.repeatBackward && pass < mark.repeatTimes) {
            passOf.set(lastForward, pass + 1);
            i = lastForward;
            continue;
        }
        i += 1;
    }

    if (order.length === 0 || order.length > limits.maxMeasures) {
        return linear(n, true);
    }
    // A volta whose pass never matched can leave bars unplayed; that is a
    // structure we did not understand, not a performance decision.
    const played = new Set(order);
    const unplayed = marks.some((_, index) => !played.has(index));
    return { order, degraded: unplayed };
};

/** The tick-keyed content unrolling has to remap, alongside measures. */
export interface UnrollableScore {
    measures: Array<{ tick: number; dTicks: number; srcIndex?: number }>;
    notes: Array<{ t: number; d: number }>;
    timeSignatures: Array<{ tick: number }>;
    keySignatures?: Array<{ tick: number }>;
    clefs?: Array<{ tick: number }>;
    tempos?: Array<{ tick: number }>;
    holds?: Array<{ tick: number }>;
    totalTicks: number;
}

interface Segment {
    /** Index of the printed measure this segment performs. */
    src: number;
    /** Where the printed bar sits in the original timeline. */
    srcTick: number;
    dTicks: number;
    /** Where it sits in the performed timeline. */
    destTick: number;
    /** True when the PREVIOUS segment is not this one's printed predecessor. */
    seamBefore: boolean;
}

/**
 * State events (time/key/clef/tempo) describe what is in force from a tick
 * onward, so they cannot simply be copied: a jump can land in the middle of a
 * span. Walk the performance and re-emit whenever the value in force at a
 * segment's start differs from what the performed timeline last said.
 */
const remapStateEvents = <T extends { tick: number }>(events: readonly T[], segments: readonly Segment[]): T[] => {
    if (events.length === 0) {
        return [];
    }
    const sorted = [...events].sort((a, b) => a.tick - b.tick);
    const inForceAt = (tick: number): T | undefined => {
        let found: T | undefined;
        for (const e of sorted) {
            if (e.tick > tick) {
                break;
            }
            found = e;
        }
        return found;
    };

    const out: T[] = [];
    let emitted: T | undefined;
    for (const seg of segments) {
        const active = inForceAt(seg.srcTick);
        if (active && active !== emitted) {
            out.push({ ...active, tick: seg.destTick });
            emitted = active;
        }
        // Anything changing strictly inside this bar keeps its offset.
        for (const e of sorted) {
            if (e.tick > seg.srcTick && e.tick < seg.srcTick + seg.dTicks) {
                out.push({ ...e, tick: seg.destTick + (e.tick - seg.srcTick) });
                emitted = e;
            }
        }
    }
    return out;
};

/**
 * Rebuild a score in performance order. Measures are cloned with their geometry
 * intact and given new ticks, which is what makes the playhead sweep the same
 * printed bar twice for free.
 */
export const unrollRepeats = <S extends UnrollableScore>(score: S, order: readonly number[]): S => {
    const segments: Segment[] = [];
    // The performance starts where the score starts, which is not necessarily
    // where its first PERFORMED bar sat (and preserves the tick offset that
    // concatenated movements rely on).
    let destTick = score.measures[0]?.tick ?? 0;
    for (let s = 0; s < order.length; s++) {
        const src = order[s]!;
        const measure = score.measures[src];
        if (!measure) {
            continue;
        }
        segments.push({
            src,
            srcTick: measure.tick,
            dTicks: measure.dTicks,
            destTick,
            seamBefore: s > 0 && order[s - 1] !== src - 1,
        });
        destTick += measure.dTicks;
    }
    const totalTicks = Math.max(1, destTick);

    const measures = segments.map((seg) => ({
        ...score.measures[seg.src]!,
        tick: seg.destTick,
        srcIndex: score.measures[seg.src]!.srcIndex ?? seg.src,
    }));

    const notes: S['notes'] = [];
    for (let s = 0; s < segments.length; s++) {
        const seg = segments[s]!;
        const next = segments[s + 1];
        for (const note of score.notes) {
            if (note.t < seg.srcTick || note.t >= seg.srcTick + seg.dTicks) {
                continue;
            }
            const offset = note.t - seg.srcTick;
            let d = note.d;
            // A note held past this bar only keeps its tail when the next
            // segment really is what follows it on the page. Clipping every
            // seam would truncate legitimately long ties inside a run.
            if (next && next.seamBefore) {
                d = Math.min(d, seg.dTicks - offset);
            }
            notes.push({ ...note, t: seg.destTick + offset, d: Math.max(1, d) });
        }
    }

    const point = <T extends { tick: number }>(events: readonly T[] | undefined): T[] | undefined => {
        if (!events) {
            return undefined;
        }
        const out: T[] = [];
        for (const seg of segments) {
            for (const e of events) {
                if (e.tick >= seg.srcTick && e.tick < seg.srcTick + seg.dTicks) {
                    out.push({ ...e, tick: seg.destTick + (e.tick - seg.srcTick) });
                }
            }
        }
        return out.sort((a, b) => a.tick - b.tick);
    };

    return {
        ...score,
        measures,
        notes: notes.sort((a, b) => a.t - b.t),
        timeSignatures: remapStateEvents(score.timeSignatures, segments),
        ...(score.keySignatures ? { keySignatures: remapStateEvents(score.keySignatures, segments) } : {}),
        ...(score.clefs ? { clefs: remapStateEvents(score.clefs, segments) } : {}),
        ...(score.tempos ? { tempos: remapStateEvents(score.tempos, segments) } : {}),
        ...(score.holds ? { holds: point(score.holds) } : {}),
        totalTicks,
    };
};
