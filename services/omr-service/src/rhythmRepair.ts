import type { RawEvent, RawMeasure } from './musicxml.js';
import { TICKS_PER_QUARTER } from './scoreData.js';

/**
 * Rhythm repair — put back the one symbol OMR most plausibly lost.
 *
 * A bar whose content does not add up to its signature was, in almost every
 * case seen, damaged by a SINGLE misread: a dot not seen, a flag missed (an
 * eighth read as a quarter), a rest hallucinated from a smudge, or a rest
 * dropped. Padding the bar to length (the fallback that still runs after this)
 * keeps later bars on the grid but leaves the damaged bar limping: every note
 * after the misread is early or late, and a lost dot becomes a hole.
 *
 * The repair is deliberately narrow. It tries, in order, (a) toggling a dot,
 * (b) halving or doubling a note, (c) inserting a rest at the end of the voice,
 * (d) deleting a duplicated rest — and accepts an edit only when the voice
 * then sums EXACTLY to the bar and there is independent evidence that this is
 * what was engraved: either the same voice in the previous or next bar has the
 * same onset pattern (the figure repeats), or the edited note sits inside a
 * beam group that the edit makes land on the beat grid. One edit per
 * bar-voice, and never on a bar the meter reconciliation has already explained
 * (the caller runs that first), so a systematically long span is still read as
 * a misread signature rather than a hundred lost dots.
 */

type Sig = { num: number; den: number };
type NoteEvent = Extract<RawEvent, { k: 'note' }>;
type RestEvent = Extract<RawEvent, { k: 'rest' }>;
type RhythmEvent = NoteEvent | RestEvent;

type RhythmEditKind = 'add_dot' | 'remove_dot' | 'halve' | 'double' | 'insert_rest' | 'delete_rest';

/** Note types in halving order; a doubled whole or a halved 128th is not notation. */
const TYPE_ORDER = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th'];

/**
 * One rhythmic position of a voice: the note (or rest) that advances the
 * cursor plus any chord members hanging off it.
 */
interface Item {
    principal: RhythmEvent;
    members: NoteEvent[];
}

interface Candidate {
    kind: RhythmEditKind;
    /** Item edited; for `insert_rest` the item the rest follows (or -1). */
    index: number;
    /** New principal duration for dot/halve/double edits. */
    newDur?: number;
    /** Duration of the rest to insert. */
    restDur?: number;
}

const barTicksOf = (sig: Sig): number => Math.max(1, Math.round(sig.num * ((TICKS_PER_QUARTER * 4) / sig.den)));
const beatTicksOf = (sig: Sig): number => Math.max(1, Math.round((TICKS_PER_QUARTER * 4) / sig.den));

const voiceKey = (ev: RhythmEvent): string => `${ev.staff}:${ev.voice}`;

const isRhythm = (ev: RawEvent): ev is RhythmEvent => ev.k === 'note' || ev.k === 'rest';

/** A bar's voices in document order, each as its chain of rhythmic items. */
const voicesOf = (raw: RawMeasure): Map<string, Item[]> => {
    const voices = new Map<string, Item[]>();
    for (const ev of raw.events) {
        if (!isRhythm(ev)) {
            continue;
        }
        const key = voiceKey(ev);
        let items = voices.get(key);
        if (!items) {
            items = [];
            voices.set(key, items);
        }
        const last = items[items.length - 1];
        if (ev.k === 'note' && ev.chord && last) {
            last.members.push(ev);
        } else {
            items.push({ principal: ev, members: [] });
        }
    }
    return voices;
};

const sumOf = (items: readonly Item[]): number => items.reduce((acc, item) => acc + item.principal.dur, 0);

/** Onset rels after applying `candidate`, i.e. the rhythm the voice would then have. */
const patternAfter = (items: readonly Item[], candidate: Candidate): number[] => {
    const rels = items.map((item) => item.principal.rel);
    switch (candidate.kind) {
        case 'add_dot':
        case 'remove_dot':
        case 'halve':
        case 'double': {
            const edited = items[candidate.index];
            const newDur = candidate.newDur;
            if (!edited || newDur === undefined) {
                return rels;
            }
            const delta = newDur - edited.principal.dur;
            return rels.map((rel, i) => (i > candidate.index ? rel + delta : rel));
        }
        case 'insert_rest': {
            const last = items[items.length - 1];
            rels.push(last ? last.principal.rel + last.principal.dur : 0);
            return rels;
        }
        case 'delete_rest': {
            const deleted = items[candidate.index];
            if (!deleted) {
                return rels;
            }
            return rels
                .filter((_, i) => i !== candidate.index)
                .map((rel) => (rel > deleted.principal.rel ? rel - deleted.principal.dur : rel));
        }
        default: {
            const exhaustive: never = candidate.kind;
            return exhaustive;
        }
    }
};

const sameOnsets = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((rel, i) => rel === b[i]);

/**
 * Onset patterns of the same voice in the neighbouring bars — but only from a
 * neighbour that is itself whole: a broken bar is no witness for another.
 */
const neighbourPatterns = (
    raws: readonly RawMeasure[],
    sigs: ReadonlyArray<Sig>,
    pos: number,
    key: string,
    expected: number,
): number[][] => {
    const patterns: number[][] = [];
    for (const q of [pos - 1, pos + 1]) {
        const raw = raws[q];
        if (!raw || raw.isPickup || barTicksOf(sigs[q] ?? raw.sig) !== expected) {
            continue;
        }
        const items = voicesOf(raw).get(key);
        if (!items || sumOf(items) !== expected) {
            continue;
        }
        patterns.push(items.map((item) => item.principal.rel));
    }
    return patterns;
};

const noteOf = (item: Item | undefined): NoteEvent | null =>
    item && item.principal.k === 'note' ? item.principal : null;

/**
 * Whether the edit makes the beam group around the edited note sit on the beat
 * grid. Beams are the engraver's own statement of grouping, and a group is
 * drawn over a beat (or a whole number of them), so a group that lands exactly
 * on beats after the edit — and did not before — was almost certainly engraved
 * that way.
 */
const beamGroupAligns = (items: readonly Item[], candidate: Candidate, beat: number): boolean => {
    switch (candidate.kind) {
        case 'add_dot':
        case 'remove_dot':
        case 'halve':
        case 'double': {
            const edited = noteOf(items[candidate.index]);
            if (!edited || !edited.beam || candidate.newDur === undefined) {
                return false;
            }
            let first = candidate.index;
            while (first > 0 && noteOf(items[first])?.beam !== 'begin') {
                const prev = noteOf(items[first - 1]);
                if (!prev || !prev.beam) {
                    return false;
                }
                first -= 1;
            }
            if (noteOf(items[first])?.beam !== 'begin') {
                return false;
            }
            let last = candidate.index;
            while (noteOf(items[last])?.beam !== 'end') {
                const next = noteOf(items[last + 1]);
                if (!next || !next.beam) {
                    return false;
                }
                last += 1;
            }
            const start = items[first]?.principal.rel ?? 0;
            const lastItem = items[last];
            if (!lastItem) {
                return false;
            }
            const delta = candidate.newDur - edited.dur;
            const end = lastItem.principal.rel + lastItem.principal.dur + delta;
            const endBefore = end - delta;
            return start % beat === 0 && end % beat === 0 && end > start && endBefore % beat !== 0;
        }
        case 'insert_rest': {
            // The content stops where a beam group closes, on the beat: the rest
            // that followed it was lost, not the group's last note.
            const last = items[items.length - 1];
            const lastNote = noteOf(last);
            if (!last || !lastNote) {
                return false;
            }
            return lastNote.beam === 'end' && (last.principal.rel + last.principal.dur) % beat === 0;
        }
        case 'delete_rest': {
            const deleted = items[candidate.index];
            if (!deleted || deleted.principal.rel % beat !== 0) {
                return false;
            }
            return (
                noteOf(items[candidate.index - 1])?.beam === 'end' ||
                noteOf(items[candidate.index + 1])?.beam === 'begin'
            );
        }
        default: {
            const exhaustive: never = candidate.kind;
            return exhaustive;
        }
    }
};

const typeIndex = (note: NoteEvent): number => (note.type ? TYPE_ORDER.indexOf(note.type) : -1);

/** Edits that would make the voice sum exactly `expected`, in preference order. */
const candidatesFor = (items: readonly Item[], sum: number, expected: number): Candidate[] => {
    const out: Candidate[] = [];
    const need = expected - sum;
    const editable = (item: Item): boolean => !(item.principal.k === 'rest' && item.principal.measureRest);

    // (a) a dot lost or hallucinated.
    items.forEach((item, index) => {
        if (!editable(item)) {
            return;
        }
        const { dur } = item.principal;
        const dots = item.principal.k === 'note' ? item.principal.dots : 0;
        if (dots === 0 && dur % 2 === 0 && dur / 2 === need) {
            out.push({ kind: 'add_dot', index, newDur: dur + dur / 2 });
        } else if (dots === 1 && dur % 3 === 0 && -dur / 3 === need) {
            out.push({ kind: 'remove_dot', index, newDur: dur - dur / 3 });
        }
    });

    // (b) a flag lost or hallucinated: only notes, and only within notation.
    items.forEach((item, index) => {
        const note = noteOf(item);
        if (!note || note.dots > 1) {
            return;
        }
        const idx = typeIndex(note);
        if (need < 0 && note.dur % 2 === 0 && -note.dur / 2 === need && idx !== TYPE_ORDER.length - 1) {
            out.push({ kind: 'halve', index, newDur: note.dur / 2 });
        } else if (need > 0 && note.dur === need && idx !== 0) {
            out.push({ kind: 'double', index, newDur: note.dur * 2 });
        }
    });

    // (c) a trailing rest lost.
    if (need > 0) {
        out.push({ kind: 'insert_rest', index: items.length - 1, restDur: need });
    }

    // (d) a rest read twice: only a rest with a twin beside it.
    if (need < 0) {
        items.forEach((item, index) => {
            if (item.principal.k !== 'rest' || item.principal.dur !== -need || !editable(item)) {
                return;
            }
            const twin = (other: Item | undefined): boolean =>
                other !== undefined && other.principal.k === 'rest' && other.principal.dur === item.principal.dur;
            if (twin(items[index - 1]) || twin(items[index + 1])) {
                out.push({ kind: 'delete_rest', index });
            }
        });
    }
    return out;
};

/**
 * Move everything from `boundary` on by `delta`: the voice's own later items,
 * and the directions engraved at or after that point that belong to the same
 * line — a dynamic written for this voice, or, where nothing else is playing
 * on the staff (or in the bar, for staff-less marks), a grace, wedge, pedal or
 * tempo mark. With a second voice on the staff those could as well be its, so
 * they stay where they were read.
 */
const shiftFrom = (raw: RawMeasure, items: readonly Item[], from: number, boundary: number, delta: number): void => {
    for (let i = from; i < items.length; i++) {
        const item = items[i];
        if (!item) {
            continue;
        }
        item.principal.rel += delta;
        for (const member of item.members) {
            member.rel += delta;
        }
    }
    const sample = items[0]?.principal;
    if (!sample) {
        return;
    }
    const voices = voicesOf(raw);
    const aloneInBar = voices.size === 1;
    const aloneOnStaff = [...voices.keys()].filter((k) => k.startsWith(`${sample.staff}:`)).length === 1;
    const staffAlone = (staff: number | null): boolean =>
        staff === null ? aloneInBar : staff === sample.staff && aloneOnStaff;
    for (const ev of raw.events) {
        if (ev.k === 'swing' || isRhythm(ev) || ev.rel < boundary) {
            continue;
        }
        switch (ev.k) {
            case 'dyn':
                if (
                    ev.voice !== null
                        ? ev.voice === sample.voice && (ev.staff === null || ev.staff === sample.staff)
                        : staffAlone(ev.staff)
                ) {
                    ev.rel += delta;
                }
                break;
            case 'grace':
            case 'accentDyn':
            case 'wedge':
                if (staffAlone(ev.staff)) {
                    ev.rel += delta;
                }
                break;
            case 'pedal':
            case 'tempo':
            case 'gradual':
                if (aloneInBar) {
                    ev.rel += delta;
                }
                break;
            case 'time':
            case 'key':
            case 'clef':
                break;
            default: {
                const exhaustive: never = ev;
                return exhaustive;
            }
        }
    }
};

const retype = (note: NoteEvent, kind: 'halve' | 'double'): void => {
    const idx = typeIndex(note);
    if (idx < 0) {
        return;
    }
    const next = TYPE_ORDER[kind === 'halve' ? idx + 1 : idx - 1];
    if (next) {
        note.type = next;
    }
};

const apply = (raw: RawMeasure, items: Item[], candidate: Candidate): void => {
    switch (candidate.kind) {
        case 'add_dot':
        case 'remove_dot':
        case 'halve':
        case 'double': {
            const item = items[candidate.index];
            if (!item || candidate.newDur === undefined) {
                return;
            }
            const delta = candidate.newDur - item.principal.dur;
            const boundary = item.principal.rel + item.principal.dur;
            item.principal.dur = candidate.newDur;
            for (const member of item.members) {
                member.dur = candidate.newDur;
            }
            const notes = item.principal.k === 'note' ? [item.principal, ...item.members] : [];
            for (const note of notes) {
                if (candidate.kind === 'add_dot') {
                    note.dots = 1;
                } else if (candidate.kind === 'remove_dot') {
                    note.dots = 0;
                } else {
                    retype(note, candidate.kind);
                }
            }
            shiftFrom(raw, items, candidate.index + 1, boundary, delta);
            return;
        }
        case 'insert_rest': {
            const last = items[items.length - 1];
            const sample = last?.principal;
            if (!sample || candidate.restDur === undefined) {
                return;
            }
            raw.events.push({
                k: 'rest',
                rel: sample.rel + sample.dur,
                dur: candidate.restDur,
                staff: sample.staff,
                voice: sample.voice,
                measureRest: false,
            });
            return;
        }
        case 'delete_rest': {
            const item = items[candidate.index];
            if (!item) {
                return;
            }
            const at = raw.events.indexOf(item.principal);
            if (at >= 0) {
                raw.events.splice(at, 1);
            }
            shiftFrom(raw, items, candidate.index + 1, item.principal.rel + item.principal.dur, -item.principal.dur);
            return;
        }
        default: {
            const exhaustive: never = candidate.kind;
            return exhaustive;
        }
    }
};

/**
 * Repair the bars of one part in place. `sigs` are the per-bar EFFECTIVE
 * signatures (after meter reconciliation). Returns how many bar-voices were
 * edited and raises `rhythm_repaired` when any was.
 */
export const repairRhythm = (raws: readonly RawMeasure[], sigs: ReadonlyArray<Sig>, warnings: Set<string>): number => {
    let repairs = 0;
    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        // Pickups are legitimately short, and so is the final bar of a part
        // (the meter reconciliation skips it for the same reason).
        if (!raw || raw.isPickup || pos === raws.length - 1) {
            continue;
        }
        const sig = sigs[pos] ?? raw.sig;
        const expected = barTicksOf(sig);
        const beat = beatTicksOf(sig);
        let edited = false;
        // Per voice, not per bar: a voice that lost a dot under a whole second
        // voice leaves the bar the right length and its own later notes early.
        for (const [key, items] of voicesOf(raw)) {
            const sum = sumOf(items);
            if (sum === expected || sum === 0) {
                continue;
            }
            const witnesses = neighbourPatterns(raws, sigs, pos, key, expected);
            const chosen = candidatesFor(items, sum, expected).find((candidate) => {
                const pattern = patternAfter(items, candidate);
                return witnesses.some((w) => sameOnsets(w, pattern)) || beamGroupAligns(items, candidate, beat);
            });
            if (!chosen) {
                continue;
            }
            apply(raw, items, chosen);
            repairs += 1;
            edited = true;
        }
        if (edited) {
            let content = 0;
            for (const ev of raw.events) {
                if (isRhythm(ev)) {
                    content = Math.max(content, ev.rel + ev.dur);
                }
            }
            raw.contentTicks = content;
        }
    }
    if (repairs > 0) {
        warnings.add('rhythm_repaired');
    }
    return repairs;
};
