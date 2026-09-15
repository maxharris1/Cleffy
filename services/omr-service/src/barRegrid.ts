import type { RawEvent, RawMeasure } from './musicxml.js';
import { TICKS_PER_QUARTER } from './scoreData.js';

/**
 * Bar regrid — read a damaged bar's onsets off the engraving instead of off the
 * writer's voice threading.
 *
 * A MusicXML voice is a SEQUENCE: each note starts where the previous one
 * ended. When OMR threads two printed voices into one <voice> — a sustained
 * bass and the inner line stacked above it, say — every note after the join is
 * pushed later by the whole length of the voice it was glued onto, and the
 * <forward> offsets the writer computes for the other voices inherit that
 * error. The bar then runs long, and padding or a per-voice repair can only
 * make it longer. But nothing about the PAGE is ambiguous in that bar: the
 * heads are printed where they sound.
 *
 * So this reads the bar back out of the engraving, using only facts about
 * notation:
 *
 *   1. Heads printed at the same horizontal position sound together, and a head
 *      further right sounds later. (`default-x` is measured from the barline.)
 *   2. Inside one printed voice, the next symbol starts where the previous one
 *      ended — but only inside ONE voice, and a change of stem direction is the
 *      engraver saying the voice changed.
 *   3. Nothing in a bar sounds past the barline, and the bar is full.
 *
 * Those give a lower and an upper bound for every engraved column. The regrid
 * is accepted ONLY when the two meet everywhere — one arrangement of the heads
 * satisfies the page, and it fills the bar exactly. Anything less (a genuinely
 * dropped notehead that leaves a column's onset free, an over-read duration
 * that makes the bar unfillable) is left for the rhythm repair and the padding
 * to handle, because then the page did not determine the answer and this would
 * be guessing.
 */

type Sig = { num: number; den: number };
type NoteEvent = Extract<RawEvent, { k: 'note' }>;
type RestEvent = Extract<RawEvent, { k: 'rest' }>;
type RhythmEvent = NoteEvent | RestEvent;

/**
 * Horizontal slack, in tenths, inside which two heads are one engraved column.
 * A staff space is 10 tenths and a head about 12 wide, so heads that really do
 * sound at different times are never this close; heads that sound together are
 * only apart at all because of stem side, accidentals and seconds.
 */
const COLUMN_TENTHS = 4;

const barTicksOf = (sig: Sig): number => Math.max(1, Math.round(sig.num * ((TICKS_PER_QUARTER * 4) / sig.den)));

const isRhythm = (ev: RawEvent): ev is RhythmEvent => ev.k === 'note' || ev.k === 'rest';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** One engraved column position of one voice: the note or rest plus its chord members. */
interface Item {
    principal: RhythmEvent;
    members: NoteEvent[];
    /** Longest sound attacked here — the principal or one of its members. */
    dur: number;
    x: number;
    col: number;
}

/** `a → b` in one printed voice: b starts where a ended. */
interface Link {
    from: number;
    to: number;
    dur: number;
}

/** The bar's rhythmic items, or null when any of them was printed without a position. */
const itemsOf = (raw: RawMeasure): Item[] | null => {
    const items: Item[] = [];
    for (const ev of raw.events) {
        if (!isRhythm(ev)) {
            continue;
        }
        const last = items[items.length - 1];
        if (ev.k === 'note' && ev.chord) {
            if (!last) {
                return null;
            }
            last.members.push(ev);
            last.dur = Math.max(last.dur, ev.dur);
            continue;
        }
        if (ev.x === undefined || ev.dur <= 0) {
            return null;
        }
        items.push({ principal: ev, members: [], dur: ev.dur, x: ev.x, col: -1 });
    }
    return items.length >= 2 ? items : null;
};

/** Number the engraved columns left to right, and stamp each item with its own. */
const assignColumns = (items: readonly Item[]): number => {
    const sorted = [...items].sort((a, b) => a.x - b.x);
    let col = -1;
    let anchor = Number.NEGATIVE_INFINITY;
    for (const item of sorted) {
        if (item.x - anchor > COLUMN_TENTHS) {
            col += 1;
            anchor = item.x;
        }
        item.col = col;
    }
    return col + 1;
};

/**
 * Whether the onsets the writer gave contradict the page: two heads in one
 * column attacked at different ticks, or a column to the right attacked no
 * later than one to its left.
 */
const contradictsColumns = (items: readonly Item[], columns: number): boolean => {
    const relOf: Array<number | null> = new Array(columns).fill(null);
    for (const item of items) {
        const seen = relOf[item.col];
        if (seen !== undefined && seen !== null && seen !== item.principal.rel) {
            return true;
        }
        relOf[item.col] = item.principal.rel;
    }
    let last = -1;
    for (const rel of relOf) {
        if (rel === null) {
            continue;
        }
        if (rel <= last) {
            return true;
        }
        last = rel;
    }
    return false;
};

/**
 * Chain links, one printed voice at a time. A <voice> is cut wherever the stem
 * direction flips — the engraver's own statement that a different voice is
 * speaking — and wherever the next symbol is not further right, which no single
 * voice ever does.
 */
const linksOf = (items: readonly Item[]): Link[] => {
    const byVoice = new Map<string, Item[]>();
    for (const item of items) {
        const key = `${item.principal.staff}:${item.principal.voice}`;
        let chain = byVoice.get(key);
        if (!chain) {
            chain = [];
            byVoice.set(key, chain);
        }
        chain.push(item);
    }
    const links: Link[] = [];
    for (const chain of byVoice.values()) {
        let runStem: 'up' | 'down' | undefined;
        for (let i = 0; i < chain.length; i++) {
            const item = chain[i];
            const next = chain[i + 1];
            if (!item) {
                continue;
            }
            const stem = item.principal.k === 'note' ? item.principal.stem : undefined;
            runStem = runStem ?? stem;
            if (!next) {
                continue;
            }
            const nextStem = next.principal.k === 'note' ? next.principal.stem : undefined;
            const flips = nextStem !== undefined && runStem !== undefined && nextStem !== runStem;
            if (flips || next.col <= item.col) {
                runStem = undefined;
                continue;
            }
            links.push({ from: item.col, to: next.col, dur: item.principal.dur });
        }
    }
    return links;
};

/**
 * The grid every value printed in the bar lives on. Onsets are sums of printed
 * durations, so two of them never differ by less than this — it is what makes
 * "the column to the right is later" into a number.
 */
const gridUnit = (items: readonly Item[]): number => {
    let unit = 0;
    for (const item of items) {
        unit = gcd(unit, item.principal.dur);
        for (const member of item.members) {
            unit = gcd(unit, member.dur);
        }
    }
    return Math.max(1, unit);
};

/**
 * The one onset per column the page allows, or null when the page leaves any of
 * them free or the result would not fill the bar exactly.
 *
 * Lower bounds run left to right (a column is at least one grid step past the
 * one before it, and at least where a link into it lands); upper bounds run
 * right to left (a column is at least a step before the next one, close enough
 * to the barline for its own longest note to fit, and early enough for every
 * link out of it to fit). Where the two meet, the column has exactly one
 * possible onset.
 */
const solveColumns = (items: readonly Item[], columns: number, expected: number): number[] | null => {
    const maxDur = new Array<number>(columns).fill(0);
    for (const item of items) {
        maxDur[item.col] = Math.max(maxDur[item.col] ?? 0, item.dur);
    }
    // Every onset in the bar is a sum of the values printed in it, so no two
    // columns are closer together than the grid those values share.
    const unit = gridUnit(items);
    const linksFrom = new Map<number, Link[]>();
    for (const link of linksOf(items)) {
        const list = linksFrom.get(link.from);
        if (list) {
            list.push(link);
        } else {
            linksFrom.set(link.from, [link]);
        }
    }

    const lower = new Array<number>(columns).fill(0);
    for (let col = 0; col < columns; col++) {
        if (col > 0) {
            lower[col] = Math.max(lower[col] ?? 0, (lower[col - 1] ?? 0) + unit);
        }
        for (const link of linksFrom.get(col) ?? []) {
            lower[link.to] = Math.max(lower[link.to] ?? 0, (lower[col] ?? 0) + link.dur);
        }
    }

    const upper = new Array<number>(columns).fill(Number.POSITIVE_INFINITY);
    for (let col = columns - 1; col >= 0; col--) {
        let bound = expected - (maxDur[col] ?? 0);
        if (col < columns - 1) {
            bound = Math.min(bound, (upper[col + 1] ?? 0) - unit);
        }
        for (const link of linksFrom.get(col) ?? []) {
            bound = Math.min(bound, (upper[link.to] ?? 0) - link.dur);
        }
        upper[col] = bound;
    }

    if ((lower[0] ?? -1) !== 0) {
        return null;
    }
    for (let col = 0; col < columns; col++) {
        if (lower[col] !== upper[col]) {
            return null;
        }
    }
    let extent = 0;
    for (const item of items) {
        extent = Math.max(extent, (lower[item.col] ?? 0) + item.dur);
    }
    return extent === expected ? lower : null;
};

/**
 * A tie says its two notes are one sound with no gap. Where the regrid puts the
 * second one later than the first one ends, the first one's printed value was
 * under-read — a dot or a flag the engine did not see — and the tie is the page
 * saying so.
 */
const closeTieGaps = (items: readonly Item[], onsets: readonly number[]): void => {
    const byVoice = new Map<string, Item[]>();
    for (const item of items) {
        const key = `${item.principal.staff}:${item.principal.voice}`;
        let chain = byVoice.get(key);
        if (!chain) {
            chain = [];
            byVoice.set(key, chain);
        }
        chain.push(item);
    }
    for (const chain of byVoice.values()) {
        for (let i = 0; i + 1 < chain.length; i++) {
            const item = chain[i];
            const next = chain[i + 1];
            const held = item?.principal;
            const stop = next?.principal;
            if (!item || !next || held?.k !== 'note' || stop?.k !== 'note') {
                continue;
            }
            if (!held.tieStart || !stop.tieStop || held.midi !== stop.midi || item.members.length > 0) {
                continue;
            }
            const start = onsets[item.col] ?? 0;
            const gap = (onsets[next.col] ?? 0) - (start + held.dur);
            if (gap <= 0) {
                continue;
            }
            const grown = held.dur + gap;
            if (grown === held.dur * 1.5) {
                held.dots = 1;
            }
            held.dur = grown;
            item.dur = Math.max(item.dur, grown);
        }
    }
};

/** Move a mark that is not a sound to the new onset of the column it was written at. */
const remapMarks = (raw: RawMeasure, items: readonly Item[], onsets: readonly number[], expected: number): void => {
    const table = [...items]
        .map((item) => ({ from: item.principal.rel, to: onsets[item.col] ?? 0 }))
        .sort((a, b) => a.from - b.from);
    for (const ev of raw.events) {
        if (isRhythm(ev) || !('rel' in ev)) {
            continue;
        }
        let mapped = 0;
        for (const entry of table) {
            if (entry.from > ev.rel) {
                break;
            }
            mapped = entry.to;
        }
        ev.rel = Math.min(Math.max(mapped, 0), expected);
    }
};

/**
 * Regrid the bars of one part in place. `sigs` are the per-bar EFFECTIVE
 * signatures (after meter reconciliation), exactly as the rhythm repair takes
 * them — a systematically long span is a misread signature, not a bar to
 * rebuild. Returns how many bars were rebuilt and raises `bar_regridded`.
 */
export const regridBars = (raws: readonly RawMeasure[], sigs: ReadonlyArray<Sig>, warnings: Set<string>): number => {
    let regridded = 0;
    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        // A pickup is legitimately short, so "fills the bar exactly" is not a
        // test it can pass and not a shape it should be pushed into.
        if (!raw || raw.isPickup) {
            continue;
        }
        const expected = barTicksOf(sigs[pos] ?? raw.sig);
        const items = itemsOf(raw);
        if (!items) {
            continue;
        }
        const columns = assignColumns(items);
        if (columns < 2) {
            continue;
        }
        if (raw.contentTicks === expected && !contradictsColumns(items, columns)) {
            continue;
        }
        // The leftmost column is the barline: something has to start the bar,
        // and if nothing the writer placed there does, this is not a bar whose
        // onsets can be read off the page.
        if (!items.some((item) => item.col === 0 && item.principal.rel === 0)) {
            continue;
        }
        const onsets = solveColumns(items, columns, expected);
        if (!onsets) {
            continue;
        }
        if (items.every((item) => item.principal.rel === onsets[item.col])) {
            continue;
        }
        remapMarks(raw, items, onsets, expected);
        for (const item of items) {
            const rel = onsets[item.col] ?? 0;
            item.principal.rel = rel;
            for (const member of item.members) {
                member.rel = rel;
            }
        }
        closeTieGaps(items, onsets);
        raw.contentTicks = expected;
        regridded += 1;
    }
    if (regridded > 0) {
        warnings.add('bar_regridded');
    }
    return regridded;
};
