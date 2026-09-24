import { notesFromMidi, parseSmfForTest, refBarsOf } from '../eval/midiRef.js';
import {
    SCORE_DATA_WRITE_VERSION,
    TICKS_PER_QUARTER,
    scoreDataSchema,
    type ScoreData,
    type ScoreMeasure,
    type ScoreNote,
} from '../scoreData.js';
import { type Meter } from './signals.js';

export type PrintedPartial = { bar: number; quarters: number };

const beatsOf = (meter: Meter): number => (meter.num * 4) / meter.den;

const movementStub = (
    meter: Meter,
    pickupQuarters: number,
    printedBars: number,
    fifths: number,
    partialBars: readonly PrintedPartial[],
) => ({
    name: 'symbolic',
    midi: 'symbolic.mid',
    meter,
    pickupQuarters,
    partialBars: [...partialBars],
    printedBars: Math.max(1, printedBars),
    expectedFifths: fifths,
    expectedTempo: { min: 40, max: 200 },
    repeatsUnfoldedInMidi: false,
    expectedHolds: 0,
    expectedExtraNotes: 0,
});

const partialTicks = (partials: readonly PrintedPartial[]): Map<number, number> =>
    new Map(partials.map((p) => [p.bar, Math.round(p.quarters * TICKS_PER_QUARTER)]));

/** Same walk as `midiRef.place()`: pickup, then each body bar's printed length. */
const startTickOf = (
    bar: number,
    barTicks: number,
    pickupTicks: number,
    partials: ReadonlyMap<number, number>,
): number => {
    if (pickupTicks > 0 && bar <= 0) {
        return 0;
    }
    let start = pickupTicks;
    for (let b = 1; b < bar; b++) {
        start += partials.get(b) ?? barTicks;
    }
    return start;
};

const lengthOf = (
    bar: number,
    barTicks: number,
    pickupTicks: number,
    partials: ReadonlyMap<number, number>,
): number => {
    if (pickupTicks > 0 && bar === 0) {
        return Math.max(1, pickupTicks);
    }
    return Math.max(1, partials.get(bar) ?? barTicks);
};

/**
 * Thin ScoreData builder for notation-quantized MIDI. Measures use the same
 * `n` / `tick` / `dTicks` / `srcIndex` shape playback walks. Pickup is
 * right-aligned via `place()` (content length, never padded). The last bar is
 * content length, not a full meter. Mid-piece fragments follow `partialBars`.
 */
export const scoreDataFromMidi = (
    buf: Buffer,
    opts: {
        meter: Meter;
        pickupQuarters: number;
        fifths: number;
        partialBars?: readonly PrintedPartial[];
    },
): ScoreData => {
    const parsed = parseSmfForTest(buf);
    if (parsed.notes.length === 0) {
        throw new Error('MIDI has no notes');
    }
    const scale = TICKS_PER_QUARTER / parsed.tpq;
    const toTicks = (midiTick: number): number => Math.max(0, Math.round(midiTick * scale));
    const toDur = (midiDur: number): number => Math.max(1, Math.round(midiDur * scale));
    const notes: ScoreNote[] = parsed.notes.map((n) => ({
        t: toTicks(n.tick),
        d: toDur(n.dur),
        p: n.pitch,
        h: n.hand,
    }));

    const barTicks = Math.max(1, Math.round(beatsOf(opts.meter) * TICKS_PER_QUARTER));
    const pickupTicks = Math.round(opts.pickupQuarters * TICKS_PER_QUARTER);
    const fragments = opts.partialBars ?? [];
    const partials = partialTicks(fragments);
    const refNotes = notesFromMidi(
        buf,
        movementStub(opts.meter, opts.pickupQuarters, 1, opts.fifths, fragments),
    );
    const barIds = [...refBarsOf(refNotes).keys()].sort((a, b) => a - b);
    const minBar = barIds[0] ?? (pickupTicks > 0 ? 0 : 1);
    const maxBar = barIds[barIds.length - 1] ?? minBar;

    const measures: ScoreMeasure[] = [];
    for (let bar = minBar, index = 0; bar <= maxBar; bar++, index++) {
        const tick = startTickOf(bar, barTicks, pickupTicks, partials);
        const isLast = bar === maxBar;
        let dTicks = lengthOf(bar, barTicks, pickupTicks, partials);
        if (isLast) {
            const contentEnd = notes.reduce((end, n) => Math.max(end, n.t + n.d), tick);
            dTicks = Math.max(1, contentEnd - tick);
        }
        measures.push({
            n: bar,
            tick,
            dTicks,
            page: -1,
            sys: -1,
            x0: 0,
            x1: 1,
            srcIndex: index,
        });
    }

    const last = measures[measures.length - 1];
    const candidate: ScoreData = {
        version: SCORE_DATA_WRITE_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: 80,
        timeSignatures: [{ tick: 0, num: opts.meter.num, den: opts.meter.den }],
        keySignatures: [{ tick: 0, fifths: opts.fifths }],
        totalTicks: Math.max(1, last ? last.tick + last.dTicks : 1),
        notes,
        measures,
        systems: [],
        warnings: [],
    };
    const checked = scoreDataSchema.safeParse(candidate);
    if (!checked.success) {
        throw new Error(`ScoreData failed self-check: ${checked.error.issues[0]?.message}`);
    }
    return checked.data;
};
