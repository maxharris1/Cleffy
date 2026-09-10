import type { CorpusMovement } from './manifest.js';

export type RefHand = 0 | 1;

export interface RefNote {
    bar: number;
    /** Onset from the start of the (full) bar, in quarter-notes. */
    onsetQ: number;
    durQ: number;
    pitch: number;
    hand: RefHand;
}

interface SmfNote {
    tick: number;
    dur: number;
    pitch: number;
    hand: RefHand;
}

const readU16 = (buf: Buffer, i: number): number => {
    const hi = buf[i];
    const lo = buf[i + 1];
    if (hi === undefined || lo === undefined) {
        throw new Error('MIDI: truncated u16');
    }
    return (hi << 8) | lo;
};

const readU32 = (buf: Buffer, i: number): number => {
    const a = buf[i];
    const b = buf[i + 1];
    const c = buf[i + 2];
    const d = buf[i + 3];
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
        throw new Error('MIDI: truncated u32');
    }
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
};

class Cursor {
    constructor(
        private readonly buf: Buffer,
        private i: number,
        private readonly end: number,
    ) {}

    remaining(): number {
        return this.end - this.i;
    }

    u8(): number {
        if (this.i >= this.end) {
            throw new Error('MIDI: unexpected end of track');
        }
        const value = this.buf[this.i];
        this.i += 1;
        if (value === undefined) {
            throw new Error('MIDI: unexpected end of track');
        }
        return value;
    }

    bytes(n: number): Buffer {
        if (this.i + n > this.end) {
            throw new Error('MIDI: truncated payload');
        }
        const slice = this.buf.subarray(this.i, this.i + n);
        this.i += n;
        return slice;
    }

    vlq(): number {
        let value = 0;
        for (let step = 0; step < 5; step++) {
            const byte = this.u8();
            value = (value << 7) | (byte & 0x7f);
            if ((byte & 0x80) === 0) {
                return value;
            }
        }
        throw new Error('MIDI: VLQ too long');
    }
}

const parseTrack = (
    buf: Buffer,
    start: number,
    length: number,
): { name: string; notes: Array<{ tick: number; pitch: number; dur: number }> } => {
    const cur = new Cursor(buf, start, start + length);
    let tick = 0;
    let running = 0;
    let name = '';
    const pending = new Map<number, number[]>();
    const notes: Array<{ tick: number; pitch: number; dur: number }> = [];

    const pushOn = (pitch: number, at: number): void => {
        const stack = pending.get(pitch) ?? [];
        stack.push(at);
        pending.set(pitch, stack);
    };
    const popOff = (pitch: number, at: number): void => {
        const stack = pending.get(pitch);
        const on = stack?.shift();
        if (on === undefined) {
            return;
        }
        if (stack && stack.length === 0) {
            pending.delete(pitch);
        }
        const dur = at - on;
        if (dur > 0) {
            notes.push({ tick: on, pitch, dur });
        }
    };

    while (cur.remaining() > 0) {
        tick += cur.vlq();
        const first = cur.u8();
        let status = first;
        let data1: number;
        if (first < 0x80) {
            if (running === 0) {
                throw new Error('MIDI: running status with no prior status');
            }
            status = running;
            data1 = first;
        } else if (first === 0xff) {
            const type = cur.u8();
            const payload = cur.bytes(cur.vlq());
            if (type === 0x2f) {
                break;
            }
            if (type === 0x03) {
                name = payload.toString('ascii').trim();
            }
            running = 0;
            continue;
        } else if (first === 0xf0 || first === 0xf7) {
            cur.bytes(cur.vlq());
            running = 0;
            continue;
        } else {
            running = first >= 0xf0 ? 0 : first;
            data1 = cur.u8();
        }

        const cmd = status & 0xf0;
        switch (cmd) {
            case 0x80: {
                cur.u8();
                popOff(data1, tick);
                break;
            }
            case 0x90: {
                const vel = cur.u8();
                if (vel === 0) {
                    popOff(data1, tick);
                } else {
                    pushOn(data1, tick);
                }
                break;
            }
            case 0xa0:
            case 0xb0:
            case 0xe0:
                cur.u8();
                break;
            case 0xc0:
            case 0xd0:
                break;
            default:
                break;
        }
    }
    return { name, notes };
};

const parseSmf = (buf: Buffer): { tpq: number; tracks: ReturnType<typeof parseTrack>[] } => {
    if (buf.length < 14 || buf.subarray(0, 4).toString('ascii') !== 'MThd') {
        throw new Error('MIDI: not a Standard MIDI File');
    }
    const headerLen = readU32(buf, 4);
    if (headerLen < 6) {
        throw new Error('MIDI: short header');
    }
    const ntrks = readU16(buf, 10);
    const division = readU16(buf, 12);
    if (division & 0x8000) {
        throw new Error('MIDI: SMPTE division is not supported');
    }
    const tpq = division;
    const tracks: ReturnType<typeof parseTrack>[] = [];
    let offset = 8 + headerLen;
    for (let i = 0; i < ntrks; i++) {
        if (offset + 8 > buf.length || buf.subarray(offset, offset + 4).toString('ascii') !== 'MTrk') {
            throw new Error(`MIDI: missing MTrk at track ${i}`);
        }
        const len = readU32(buf, offset + 4);
        tracks.push(parseTrack(buf, offset + 8, len));
        offset += 8 + len;
    }
    return { tpq, tracks };
};

const handOf = (tracks: ReturnType<typeof parseTrack>[]): Array<RefHand | null> => {
    const named = tracks.map((track) => {
        const lower = track.name.toLowerCase();
        if (lower === 'up' || lower === 'treble' || lower === 'rh') {
            return 0 as const;
        }
        if (lower === 'down' || lower === 'bass' || lower === 'lh') {
            return 1 as const;
        }
        return null;
    });
    if (named.some((hand) => hand !== null)) {
        return named;
    }
    let next: RefHand = 0;
    return tracks.map((track) => {
        if (track.notes.length === 0) {
            return null;
        }
        const hand = next;
        next = 1;
        return hand;
    });
};

const place = (tick: number, tpq: number, beats: number, pickup: number): { bar: number; onsetQ: number } => {
    const barTicks = tpq * beats;
    const pickupTicks = Math.round(pickup * tpq);
    if (pickupTicks > 0) {
        if (tick < pickupTicks) {
            return { bar: 0, onsetQ: (tick + (barTicks - pickupTicks)) / tpq };
        }
        const body = tick - pickupTicks;
        return { bar: 1 + Math.floor(body / barTicks), onsetQ: (body % barTicks) / tpq };
    }
    return { bar: 1 + Math.floor(tick / barTicks), onsetQ: (tick % barTicks) / tpq };
};

/** Snap an onset to 1/12 of a quarter so triplets stay exact. */
export const quantizeOnset = (quarters: number): number => Math.round(quarters * 12) / 12;

export const notesFromMidi = (buf: Buffer, movement: CorpusMovement): RefNote[] => {
    const { tpq, tracks } = parseSmf(buf);
    const hands = handOf(tracks);
    const beats = (movement.meter.num * 4) / movement.meter.den;
    const out: RefNote[] = [];
    tracks.forEach((track, i) => {
        const hand = hands[i];
        if (hand === null || hand === undefined) {
            return;
        }
        for (const note of track.notes) {
            const placed = place(note.tick, tpq, beats, movement.pickupQuarters);
            out.push({
                bar: placed.bar,
                onsetQ: quantizeOnset(placed.onsetQ),
                durQ: note.dur / tpq,
                pitch: note.pitch,
                hand,
            });
        }
    });
    return out;
};

/** Group reference notes by engraved bar number. */
export const refBarsOf = (notes: readonly RefNote[]): Map<number, RefNote[]> => {
    const bars = new Map<number, RefNote[]>();
    for (const note of notes) {
        const list = bars.get(note.bar) ?? [];
        list.push(note);
        bars.set(note.bar, list);
    }
    return bars;
};

/** Exposed for tests that need to inspect the raw SMF parse. */
export const parseSmfForTest = (buf: Buffer): { tpq: number; trackNames: string[]; notes: SmfNote[] } => {
    const { tpq, tracks } = parseSmf(buf);
    const hands = handOf(tracks);
    const notes: SmfNote[] = [];
    tracks.forEach((track, i) => {
        const hand = hands[i] ?? 0;
        for (const note of track.notes) {
            notes.push({ tick: note.tick, dur: note.dur, pitch: note.pitch, hand });
        }
    });
    return { tpq, trackNames: tracks.map((t) => t.name), notes };
};
