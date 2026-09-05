import { MAX_PEDAL_EDGES } from './caps.js';
import type { Era } from './era.js';
import { GATE_STACCATO, type GatedNote } from './musicxml.js';
import { MAX_VOICE_SLOT, TICKS_PER_QUARTER, type ScorePedal, type ScoreTimeSig } from './scoreData.js';

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
/** More harmony changes than this inside one beat and the foot gives up. */
export const MAX_SET_CHANGES_PER_BEAT = 2;

export interface AutoPedalScore {
    /** Parser output keeps each note's articulation gate; older or synthetic notes carry none. */
    notes: readonly GatedNote[];
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

/** How often the pedal may change: every felt beat, or every so many bars. */
type Step = 'beat' | number;
/**
 * Coarsening ladder for scores whose beat-level pedalling would breach the
 * edge ceiling: a change per bar, then per 2, 4 and 8 bars. Past that the
 * inference gives up and the score keeps only its printed edges.
 */
const COARSENING: readonly Step[] = ['beat', 1, 2, 4, 8];

interface Region {
    from: number;
    to: number;
}

/** One stretch the pedal is judged over: its bounds and the felt beat at its start. */
interface Window {
    b0: number;
    b1: number;
    beat: number;
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

/**
 * Stretches where the pedal is up and nothing says otherwise. With no marks at
 * all, the whole score; with marks, the gaps of at least
 * {@link UNPEDALLED_GAP_BARS} bars before the first depression and between a
 * lift and the next depression.
 */
const unpedalledRegions = (score: AutoPedalScore): Region[] => {
    if (score.pedals.length === 0) {
        return [{ from: 0, to: score.totalTicks }];
    }
    const edges = [...score.pedals].sort(byEdgeOrder);
    const gaps: Region[] = [];
    let down = false;
    let from = 0;
    for (const edge of edges) {
        if (!down && edge.tick > from) {
            // The pedal was up from `from` to here, whichever edge this is: a
            // depression ends the gap, a lift with nothing down before it
            // (OMR lost the depression) does too.
            gaps.push({ from, to: edge.tick });
        }
        if (edge.k === 'down') {
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
 * Whether a note was engraved staccato, read back from its gated length, for
 * notes that carry no `gate` of their own. `d` is the notated length times a
 * gate — {@link GATE_STACCATO} for a dot, half that for a wedge, 0.9 for a
 * plain note — and the notated length is the gap to the next onset in the
 * voice, or that gap less a rest of the same or three times the note's
 * length. A plain note before a rest lands on 0.45 of its gap, never on a
 * half, so the exact match tells them apart where a threshold on the ratio
 * could not. A slurred note before an equal rest (gate 1, half its gap) is
 * the case this cannot tell apart, which is why the parser stamps the gate.
 */
const isStaccatoLength = (d: number, gap: number): boolean => {
    for (const span of [gap, gap / 2, gap / 4]) {
        if (Math.round(span * GATE_STACCATO) === d || Math.round(span * GATE_STACCATO * 0.5) === d) {
            return true;
        }
    }
    return false;
};

/**
 * Per note, whether it is staccato: by the articulation gate the parser
 * stamped where there is one, else read back from the length. Chord members
 * share a successor; a voice's last note has none and reads as sustained.
 */
const staccatoFlags = (notes: readonly GatedNote[]): boolean[] => {
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
            if (note.gate !== undefined) {
                flags[index] = note.gate <= GATE_STACCATO;
                continue;
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

/** The windows of one region at the given step, in tick order. */
const windowsOf = (score: AutoPedalScore, region: Region, step: Step): Window[] => {
    const windows: Window[] = [];
    const overlaps = (b0: number, b1: number): boolean => b1 > region.from && b0 < region.to;
    if (step === 'beat') {
        for (const measure of score.measures) {
            const barEnd = measure.tick + measure.dTicks;
            if (!overlaps(measure.tick, barEnd)) {
                continue;
            }
            const beat = beatTicks(timeSigAt(score.timeSignatures, measure.tick));
            for (let b0 = measure.tick; b0 < barEnd; b0 += beat) {
                const b1 = Math.min(b0 + beat, barEnd);
                if (overlaps(b0, b1)) {
                    windows.push({ b0, b1, beat });
                }
            }
        }
        return windows;
    }
    for (let i = 0; i < score.measures.length; i += step) {
        const first = score.measures[i];
        const last = score.measures[Math.min(i + step, score.measures.length) - 1];
        if (!first || !last) {
            continue;
        }
        const b1 = last.tick + last.dTicks;
        if (overlaps(first.tick, b1)) {
            windows.push({ b0: first.tick, b1, beat: beatTicks(timeSigAt(score.timeSignatures, first.tick)) });
        }
    }
    return windows;
};

/** Pedal one unpedalled region, changing at most once per window. */
const pedalRegion = (
    score: AutoPedalScore,
    notes: readonly GatedNote[],
    staccato: readonly boolean[],
    region: Region,
    era: Era,
    step: Step,
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

    for (const { b0, b1, beat } of windowsOf(score, region, step)) {
        // The churn rule is per beat; a coarser window tolerates proportionally more.
        const maxChanges = MAX_SET_CHANGES_PER_BEAT * Math.max(1, (b1 - b0) / beat);
        // A window straddling the region's edge only judges the part inside
        // it: an attack under a printed depression must not take an inferred
        // one, and an attack past a printed lift is that lift's business.
        const from = Math.max(b0, region.from);
        const to = Math.min(b1, region.to);
        const attacks: number[] = [];
        while (cursor < notes.length && (notes[cursor]?.t ?? Infinity) < b1) {
            const note = notes[cursor];
            if (note) {
                if (note.t >= from && note.t < to) {
                    attacks.push(cursor);
                }
                maxEnd = Math.max(maxEnd, note.t + note.d);
            }
            cursor += 1;
        }
        const sounding = attacks.length > 0 || maxEnd > from;
        if (!sounding) {
            if (down) {
                edges.push(edge(from, 'up'));
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
    if (down) {
        edges.push(edge(region.to, 'up'));
    }
    return edges;
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
    for (const step of COARSENING) {
        const inferred = regions.flatMap((region) => pedalRegion(score, notes, staccato, region, era, step));
        if (score.pedals.length + inferred.length > MAX_PEDAL_EDGES) {
            continue; // over the schema ceiling: try a coarser step, still pedalling
        }
        if (inferred.length === 0) {
            return untouched;
        }
        return { pedals: [...score.pedals, ...inferred].sort(byEdgeOrder), inferred: true };
    }
    // Even a change per eight bars would breach the ceiling: printed edges only.
    return untouched;
};
