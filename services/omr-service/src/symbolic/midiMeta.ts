import { parseSmfForTest } from '../eval/midiRef.js';
import type { Meter } from './signals.js';

/**
 * Time-signature meta events (FF 58) straight from the SMF. `midiRef` only
 * reads notes and key signatures, and a MIDI candidate has to be barred by its
 * OWN meter: copying the PDF's meter onto it made the meter check a no-op and
 * barred every text-less scan in 4/4.
 */
export interface MidiTimeSignature {
    /** Absolute tick in the file's own ticks-per-quarter. */
    tick: number;
    num: number;
    den: number;
}

const readU32 = (buf: Buffer, at: number): number => buf.readUInt32BE(at);

/** Bytes a channel message carries after its status byte. */
const channelDataLength = (status: number): number => {
    const cmd = status & 0xf0;
    return cmd === 0xc0 || cmd === 0xd0 ? 1 : 2;
};

const readVlq = (buf: Buffer, pos: { at: number }, end: number): number => {
    let value = 0;
    for (let i = 0; i < 4 && pos.at < end; i++) {
        const byte = buf[pos.at++] ?? 0;
        value = (value << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) {
            return value;
        }
    }
    return value;
};

const timeSignaturesOfTrack = (buf: Buffer, start: number, end: number): MidiTimeSignature[] => {
    const out: MidiTimeSignature[] = [];
    const pos = { at: start };
    let tick = 0;
    let running = 0;
    while (pos.at < end) {
        tick += readVlq(buf, pos, end);
        const first = buf[pos.at];
        if (first === undefined) {
            break;
        }
        if (first === 0xff) {
            const type = buf[pos.at + 1] ?? 0;
            pos.at += 2;
            const length = readVlq(buf, pos, end);
            if (type === 0x2f) {
                break;
            }
            if (type === 0x58 && length >= 2) {
                const num = buf[pos.at] ?? 0;
                const denPow = buf[pos.at + 1] ?? 0;
                if (num > 0 && denPow <= 6) {
                    out.push({ tick, num, den: 2 ** denPow });
                }
            }
            pos.at += length;
            running = 0;
            continue;
        }
        if (first === 0xf0 || first === 0xf7) {
            pos.at += 1;
            pos.at += readVlq(buf, pos, end);
            running = 0;
            continue;
        }
        if (first >= 0x80) {
            running = first;
            pos.at += 1;
        } else if (running === 0) {
            // Malformed: data byte with no status to run from.
            break;
        }
        pos.at += channelDataLength(running);
    }
    return out;
};

/** Every FF 58 in every track, sorted by tick. Empty for a malformed file. */
export const timeSignaturesFromMidi = (buf: Buffer): MidiTimeSignature[] => {
    if (buf.length < 14 || buf.subarray(0, 4).toString('ascii') !== 'MThd') {
        return [];
    }
    const out: MidiTimeSignature[] = [];
    let at = 8 + readU32(buf, 4);
    while (at + 8 <= buf.length) {
        const id = buf.subarray(at, at + 4).toString('ascii');
        const length = readU32(buf, at + 4);
        const start = at + 8;
        const end = Math.min(buf.length, start + length);
        if (id === 'MTrk') {
            out.push(...timeSignaturesOfTrack(buf, start, end));
        }
        at = start + length;
    }
    return out.sort((a, b) => a.tick - b.tick);
};

/**
 * The meter the MIDI opens in (its earliest FF 58). Null when the file carries
 * none — only then does the caller fall back to the PDF's meter, then 4/4.
 */
export const meterFromMidi = (buf: Buffer): Meter | null => {
    const first = timeSignaturesFromMidi(buf)[0];
    return first === undefined ? null : { num: first.num, den: first.den };
};

/** Bars of the opening scanned for the downbeat. Later voltas shift the phase. */
const PICKUP_WINDOW_BARS = 8;

/**
 * Anacrusis length in quarters, read from where the MIDI's downbeats fall.
 * The PDF can only say THAT a pickup exists (a narrow first box, `pickupFlagged`)
 * — the box width includes clef/key/meter, so it cannot give the length. Notation
 * MIDI (Mutopia/LilyPond) starts the pickup at tick 0, so every downbeat sits at
 * `pickup + k * bar`. Each grid phase in [0, bar) is scored by the note length
 * starting on it over the opening bars; the heaviest phase is the pickup. Phase 0
 * wins ties, so an unconvincing MIDI keeps the plain grid.
 *
 * Callers gate this on `pickupFlagged`: unconditioned, the heaviest phase lands off
 * the barline on accompaniment-driven pieces (Gymnopédie, Bach inventions), so the
 * PDF flag is what licenses a non-zero answer. Checked against the eval corpus
 * pins: Chopin Op. 28/4 (2/2, 1), Für Elise (3/8, 0.5), Schumann Op. 68/5 (4/4, 3).
 */
export const pickupQuartersFromMidi = (buf: Buffer, meter: Meter): number => {
    const parsed = parseSmfForTest(buf);
    const tpq = parsed.tpq;
    const barTicks = Math.round(((meter.num * 4) / meter.den) * tpq);
    const beatTicks = Math.round((4 / meter.den) * tpq);
    const unit = Math.max(1, Math.round(Math.min(beatTicks, tpq) / 2));
    if (parsed.notes.length === 0 || barTicks <= unit) {
        return 0;
    }
    let bestPhase = 0;
    let bestWeight = -1;
    for (let phase = 0; phase < barTicks; phase += unit) {
        const end = phase + PICKUP_WINDOW_BARS * barTicks;
        let weight = 0;
        for (const note of parsed.notes) {
            if (note.tick >= phase && note.tick < end && (note.tick - phase) % barTicks === 0) {
                weight += note.dur;
            }
        }
        if (weight > bestWeight) {
            bestWeight = weight;
            bestPhase = phase;
        }
    }
    return bestPhase / tpq;
};
