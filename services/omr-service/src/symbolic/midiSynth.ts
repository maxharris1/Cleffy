/**
 * Tiny Standard MIDI File builder for symbolic fixtures. Do not commit large
 * binaries — tests and the eval CLI generate these in memory.
 */

const vlq = (n: number): number[] => {
    const bytes: number[] = [n & 0x7f];
    let rest = n >> 7;
    while (rest > 0) {
        bytes.unshift((rest & 0x7f) | 0x80);
        rest >>= 7;
    }
    return bytes;
};

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const track = (events: number[]): number[] => {
    const body = [...events, 0, 0xff, 0x2f, 0];
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
};

const smf = (tpq: number, tracks: number[][]): Buffer => {
    const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(tpq)];
    return Buffer.from([...header, ...tracks.flat()]);
};

export interface SynthMidiOpts {
    meter: { num: number; den: number };
    pickupQuarters: number;
    printedBars: number;
    fifths: number;
    /** One MIDI pitch per printed bar (cycled if shorter). */
    pitches: readonly number[];
    tpq?: number;
    /** Added to every note-on tick.  tpq/24 lands on the 1/24-quarter residual. */
    onsetJitterTicks?: number;
    /** Last printed bar length in quarters. Omit to fill the meter (no padding). */
    lastBarQuarters?: number;
}

const denLog2 = (den: number): number => {
    switch (den) {
        case 1:
            return 0;
        case 2:
            return 1;
        case 4:
            return 2;
        case 8:
            return 3;
        case 16:
            return 4;
        default:
            return 2;
    }
};

/**
 * Notation-quantized (or deliberately jittered) one-note-per-bar MIDI.
 * Pickup-aware: anacrusis is bar 0 via `midiRef.place`.
 */
export const synthQuantizedMidi = (opts: SynthMidiOpts): Buffer => {
    const tpq = opts.tpq ?? 480;
    const beats = (opts.meter.num * 4) / opts.meter.den;
    const barTicks = Math.round(beats * tpq);
    const pickupTicks = Math.round(opts.pickupQuarters * tpq);
    const jitter = opts.onsetJitterTicks ?? 0;
    const pitches = opts.pitches.length > 0 ? opts.pitches : [60];
    const sf = opts.fifths & 0xff;
    const lastBarTicks =
        opts.lastBarQuarters !== undefined ? Math.max(1, Math.round(opts.lastBarQuarters * tpq)) : barTicks;
    const durOf = (isLast: boolean): number => (isLast ? lastBarTicks : barTicks);

    const events: number[] = [
        0,
        0xff,
        0x03,
        2,
        0x75,
        0x70, // name "up"
        0,
        0xff,
        0x58,
        4,
        opts.meter.num,
        denLog2(opts.meter.den),
        24,
        8,
        0,
        0xff,
        0x59,
        2,
        sf,
        0,
    ];

    const onsets: { tick: number; pitch: number; dur: number }[] = [];
    if (pickupTicks > 0) {
        onsets.push({
            tick: jitter,
            pitch: pitches[0] ?? 60,
            dur: Math.max(1, pickupTicks),
        });
        for (let bar = 1; bar < opts.printedBars; bar++) {
            onsets.push({
                tick: pickupTicks + (bar - 1) * barTicks + jitter,
                pitch: pitches[bar % pitches.length] ?? 60,
                dur: durOf(bar === opts.printedBars - 1),
            });
        }
    } else {
        for (let bar = 0; bar < opts.printedBars; bar++) {
            onsets.push({
                tick: bar * barTicks + jitter,
                pitch: pitches[bar % pitches.length] ?? 60,
                dur: durOf(bar === opts.printedBars - 1),
            });
        }
    }

    onsets.sort((a, b) => a.tick - b.tick);
    let last = 0;
    for (const note of onsets) {
        const start = Math.max(0, note.tick);
        events.push(...vlq(start - last), 0x90, note.pitch, 80);
        events.push(...vlq(note.dur), 0x80, note.pitch, 0);
        last = start + note.dur;
    }

    return smf(tpq, [track(events)]);
};
