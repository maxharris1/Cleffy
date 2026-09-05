import { MAX_PEDAL_EDGES } from './caps.js';
import type { Era } from './era.js';
import { MAX_VOICE_SLOT, TICKS_PER_QUARTER, type ScoreNote, type ScorePedal, type ScoreTimeSig } from './scoreData.js';

/**
 * Sustain pedalling for a score that does not mark any — most engravings of
 * piano music before the late nineteenth century, and a good share after.
 * A pianist pedals such music anyway, by ear: down with the harmony, changed
 * when it changes, lifted for rests, dry for staccato, and off altogether when
 * the fingers are changing chords faster than a foot can follow.
 *
 * This works on the performed timeline (repeats already unrolled) and only
 * where the engraving is silent: everywhere when there are no pedal marks at
 * all, otherwise in the stretches of at least {@link UNPEDALLED_GAP_BARS}
 * bars between a lift and the next depression, where a marked-up piece has
 * simply stopped saying.
 */

/** A pedal-less stretch shorter than this, in a piece that does pedal, means "no pedal here". */
export const UNPEDALLED_GAP_BARS = 8;
/** The gate a staccato dot applies to a note's length (see musicxml.ts). */
export const STACCATO_GATE_MAX = 0.5;
/** More harmony changes than this inside one beat and the foot gives up. */
export const MAX_SET_CHANGES_PER_BEAT = 2;

export interface AutoPedalScore {
    notes: readonly ScoreNote[];
    measures: ReadonlyArray<{ tick: number; dTicks: number }>;
    timeSignatures: readonly ScoreTimeSig[];
    pedals: readonly ScorePedal[];
    totalTicks: number;
}

export interface AutoPedalResult {
    /** The score's edges with the inferred ones folded in, tick-sorted. */
    pedals: ScorePedal[];
    /** True when any edge was inferred. */
    inferred: boolean;
}

type Granularity = 'beat' | 'bar';

interface Region {
    from: number;
    to: number;
}

const SLOTS_PER_HAND = MAX_VOICE_SLOT + 1;

const ticksPerBeat = (den: number): number => (TICKS_PER_QUARTER * 4) / den;

/** The felt beat: dotted in compound meters, the denominator's note otherwise. */
const beatTicks = (sig: ScoreTimeSig): number => {
    const base = ticksPerBeat(sig.den);
    return sig.den >= 8 && sig.num >= 6 && sig.num % 3 === 0 ? base * 3 : base;
};

const timeSigAt = (sigs: readonly ScoreTimeSig[], tick: number): ScoreTimeSig => {
    let current: ScoreTimeSig = sigs[0] ?? { tick: 0, num: 4, den: 4 };
    for (const sig of sigs) {
        if (sig.tick > tick) {
            break;
        }
        current = sig;
    }
    return current;
};

/**
 * Stretches where the pedal is up and nothing says otherwise. With no marks at
 * all, the whole score; with marks, the gaps of at least
 * {@link UNPEDALLED_GAP_BARS} bars between a lift and the next depression.
 */
const unpedalledRegions = (score: AutoPedalScore): Region[] => {
    if (score.pedals.length === 0) {
        return [{ from: 0, to: score.totalTicks }];
    }
    const edges = [...score.pedals].sort((a, b) => a.tick - b.tick);
    const gaps: Region[] = [];
    let down = false;
    let from = 0;
    for (const edge of edges) {
        if (edge.k === 'down') {
            if (!down && edge.tick > from) {
                gaps.push({ from, to: edge.tick });
            }
            down = true;
        } else {
            from = edge.tick;
            down = false;
        }
    }
    if (!down && score.totalTicks > from) {
        gaps.push({ from, to: score.totalTicks });
    }
    return gaps.filter(
        (gap) => score.measures.filter((m) => m.tick >= gap.from && m.tick < gap.to).length >= UNPEDALLED_GAP_BARS,
    );
};

/**
 * Whether a note was engraved staccato, read back from its gated length.
 * `d` is the notated length times a gate — {@link STACCATO_GATE_MAX} for a
 * dot, half that for a wedge, 0.9 for a plain note — and the notated length
 * is the gap to the next onset in the voice, or that gap less a rest of the
 * same or three times the note's length. A plain note before a rest lands
 * on 0.45 of its gap, never on a half, so the exact match tells them apart
 * where a threshold on the ratio could not.
 */
const isStaccatoLength = (d: number, gap: number): boolean => {
    for (const span of [gap, gap / 2, gap / 4]) {
        if (Math.round(span * STACCATO_GATE_MAX) === d || Math.round(span * STACCATO_GATE_MAX * 0.5) === d) {
            return true;
        }
    }
    return false;
};

/**
 * Per note, whether it is staccato. Chord members share a successor; a
 * voice's last note has none and reads as sustained.
 */
const staccatoFlags = (notes: readonly ScoreNote[]): boolean[] => {
    const flags = new Array<boolean>(notes.length).fill(false);
    const byVoice = new Map<number, number[]>();
    notes.forEach((note, index) => {
        const key = note.h * SLOTS_PER_HAND + (note.vc ?? 0);
        const list = byVoice.get(key) ?? [];
        list.push(index);
        byVoice.set(key, list);
    });
    for (const indices of byVoice.values()) {
        let next = 0;
        for (let i = 0; i < indices.length; i++) {
            const index = indices[i] ?? 0;
            const note = notes[index];
            if (!note) {
                continue;
            }
            while (next < indices.length && (notes[indices[next] ?? 0]?.t ?? 0) <= note.t) {
                next += 1;
            }
            const successor = next < indices.length ? notes[indices[next] ?? 0] : undefined;
            if (successor && successor.t > note.t) {
                flags[index] = isStaccatoLength(note.d, successor.t - note.t);
            }
        }
    }
    return flags;
};

const pitchClass = (midi: number): number => ((midi % 12) + 12) % 12;

const hasNewPitchClass = (set: ReadonlySet<number>, against: ReadonlySet<number>): boolean => {
    for (const pc of set) {
        if (!against.has(pc)) {
            return true;
        }
    }
    return false;
};

/** Pedal one unpedalled region at the given granularity. */
const pedalRegion = (
    score: AutoPedalScore,
    notes: readonly ScoreNote[],
    staccato: readonly boolean[],
    region: Region,
    era: Era,
    granularity: Granularity,
): ScorePedal[] => {
    const edges: ScorePedal[] = [];
    const edge = (tick: number, k: ScorePedal['k']): ScorePedal => ({ tick, k, src: 'inferred' });
    let down = false;
    // Pitch classes ringing under the current depression, and the bass it was
    // taken on; the re-catch rule reads whichever its era listens for.
    let ringing = new Set<number>();
    let bass = -1;
    let cursor = 0;
    // Latest end among notes already passed, so a beat with no onset can still
    // tell a held note from a rest.
    let maxEnd = 0;

    for (const measure of score.measures) {
        const barEnd = measure.tick + measure.dTicks;
        if (barEnd <= region.from || measure.tick >= region.to) {
            continue;
        }
        const beat = beatTicks(timeSigAt(score.timeSignatures, measure.tick));
        const step = granularity === 'bar' ? measure.dTicks : beat;
        // The churn rule is per beat; a coarser step tolerates proportionally more.
        const maxChanges = MAX_SET_CHANGES_PER_BEAT * Math.max(1, step / beat);
        for (let b0 = measure.tick; b0 < barEnd; b0 += step) {
            const b1 = Math.min(b0 + step, barEnd);
            if (b1 <= region.from || b0 >= region.to) {
                continue;
            }
            const attacks: number[] = [];
            while (cursor < notes.length && (notes[cursor]?.t ?? Infinity) < b1) {
                const note = notes[cursor];
                if (note) {
                    if (note.t >= b0) {
                        attacks.push(cursor);
                    }
                    maxEnd = Math.max(maxEnd, note.t + note.d);
                }
                cursor += 1;
            }
            const sounding = attacks.length > 0 || maxEnd > b0;
            if (!sounding) {
                if (down) {
                    edges.push(edge(b0, 'up'));
                    down = false;
                }
                continue;
            }
            if (attacks.length === 0) {
                continue; // a note held across the beat: leave the foot where it is
            }

            let dots = 0;
            let changes = 0;
            let lastOnset = -1;
            let lastSet: Set<number> | null = null;
            let set = new Set<number>();
            let lowest = Infinity;
            const beatSet = new Set<number>();
            for (const index of attacks) {
                const note = notes[index];
                if (!note) {
                    continue;
                }
                if (staccato[index]) {
                    dots += 1;
                }
                if (note.t !== lastOnset) {
                    if (lastSet && hasNewPitchClass(set, lastSet)) {
                        changes += 1;
                    }
                    lastSet = set;
                    set = new Set<number>();
                    lastOnset = note.t;
                }
                set.add(pitchClass(note.p));
                beatSet.add(pitchClass(note.p));
                lowest = Math.min(lowest, note.p);
            }
            if (lastSet && hasNewPitchClass(set, lastSet)) {
                changes += 1;
            }
            const dry = dots * 2 > attacks.length || changes > maxChanges;
            const at = notes[attacks[0] ?? 0]?.t ?? b0;

            if (dry) {
                if (down) {
                    edges.push(edge(at, 'up'));
                    down = false;
                }
                continue;
            }
            const beatBass = pitchClass(lowest);
            if (!down) {
                edges.push(edge(at, 'down'));
                down = true;
                ringing = new Set(beatSet);
                bass = beatBass;
                continue;
            }
            // Classical pedalling clears only when the bass moves; later styles
            // clear whenever a new pitch class would blur into what is ringing.
            const recatch = era === 'classical' ? beatBass !== bass : hasNewPitchClass(beatSet, ringing);
            if (recatch) {
                edges.push(edge(at, 'up'), edge(at, 'down'));
                ringing = new Set(beatSet);
                bass = beatBass;
            } else {
                for (const pc of beatSet) {
                    ringing.add(pc);
                }
            }
        }
    }
    if (down) {
        edges.push(edge(region.to, 'up'));
    }
    return edges;
};

/** Tick order; where a lift and a depression share a tick, the lift comes first — a re-catch. */
const byEdgeOrder = (a: ScorePedal, b: ScorePedal): number => {
    if (a.tick !== b.tick) {
        return a.tick - b.tick;
    }
    if (a.k === b.k) {
        return 0;
    }
    return a.k === 'up' ? -1 : 1;
};

export const inferAutoPedal = (score: AutoPedalScore, era: Era): AutoPedalResult => {
    const untouched: AutoPedalResult = { pedals: [...score.pedals], inferred: false };
    // Harpsichords and organs have no damper pedal; Baroque keyboard music is
    // played dry on the piano too, as a rule.
    if (era === 'baroque' || score.notes.length === 0 || score.measures.length === 0) {
        return untouched;
    }
    const regions = unpedalledRegions(score);
    if (regions.length === 0) {
        return untouched;
    }
    const notes = [...score.notes].sort((a, b) => a.t - b.t);
    const staccato = staccatoFlags(notes);
    const infer = (granularity: Granularity): ScorePedal[] =>
        regions.flatMap((region) => pedalRegion(score, notes, staccato, region, era, granularity));

    let inferred = infer('beat');
    if (score.pedals.length + inferred.length > MAX_PEDAL_EDGES) {
        // Over the schema ceiling: a change per bar is coarser but still pedalling.
        inferred = infer('bar');
    }
    if (inferred.length === 0) {
        return untouched;
    }
    return { pedals: [...score.pedals, ...inferred].sort(byEdgeOrder), inferred: true };
};
