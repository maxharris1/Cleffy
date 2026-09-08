import type { RawEvent, RawMeasure } from './musicxml.js';

/**
 * Key-signature repair — drop the single-staff and one-system-and-back
 * misreads Audiveris produces on piano scores, then re-spell notes that
 * were read under the wrong key.
 *
 * 17 of 20 spurious keys on the Moonlight export were `<key number="1|2">`
 * while the other staff kept the part's 4 sharps. The rest were a whole-part
 * change at a system start that reverted within a bar or two. A genuine
 * mid-piece change is both staves (or a whole-part key) and does not snap
 * back, so it is left alone.
 */

type NoteEvent = Extract<RawEvent, { k: 'note' }>;
type KeyEvent = Extract<RawEvent, { k: 'key' }>;

const STEP_COUNT = 7;
/** F C G D A E B — the order sharps are added. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
/** B E A D G C F — the order flats are added. */
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];

/** Accidental the key signature puts on `step` (0=C … 6=B). */
export const keyAlter = (step: number, fifths: number): number => {
    if (step < 0 || step >= STEP_COUNT) {
        return 0;
    }
    if (fifths > 0) {
        return SHARP_ORDER.slice(0, Math.min(7, fifths)).includes(step) ? 1 : 0;
    }
    if (fifths < 0) {
        return FLAT_ORDER.slice(0, Math.min(7, -fifths)).includes(step) ? -1 : 0;
    }
    return 0;
};

interface Drop {
    /** Measure index of the dropped key. */
    from: number;
    /** Last measure to re-spell (inclusive); the reverting key's measure, or the part end. */
    to: number;
    /** Staff to re-spell, or both when the dropped key was whole-part. */
    staff: 0 | 1 | null;
    trueFifths: number;
}

const isKey = (ev: RawEvent): ev is KeyEvent => ev.k === 'key';
const isNote = (ev: RawEvent): ev is NoteEvent => ev.k === 'note';

const keysIn = (raw: RawMeasure): KeyEvent[] => raw.events.filter(isKey);

/** 1-based MusicXML staff ↔ 0-based key.staff. */
const noteOnStaff = (noteStaff: number, staff: 0 | 1 | null): boolean =>
    staff === null || noteStaff === staff + 1;

const fifthsInForce = (partFifths: number, staffFifths: Array<number | undefined>, staff: 0 | 1): number =>
    staffFifths[staff] ?? partFifths;

/**
 * Re-spell notes on `staff` from `from` through `to` that have no printed
 * accidental and are not a tie-stop: they were read under the dropped key.
 */
const respell = (raws: readonly RawMeasure[], drop: Drop): number => {
    let changed = 0;
    for (let pos = drop.from; pos <= drop.to; pos++) {
        const raw = raws[pos];
        if (!raw) {
            continue;
        }
        const explicit = new Set<string>();
        for (const ev of raw.events) {
            if (!isNote(ev) || !ev.spell || !noteOnStaff(ev.staff, drop.staff)) {
                continue;
            }
            const key = `${ev.spell.step}:${ev.spell.octave}`;
            if (ev.spell.explicit) {
                explicit.add(key);
                continue;
            }
            if (ev.tieStop || explicit.has(key)) {
                continue;
            }
            const nextAlter = keyAlter(ev.spell.step, drop.trueFifths);
            const delta = nextAlter - ev.spell.alter;
            if (delta === 0) {
                continue;
            }
            const midi = ev.midi + delta;
            if (midi < 0 || midi > 127) {
                continue;
            }
            ev.midi = midi;
            ev.spell = { ...ev.spell, alter: nextAlter };
            changed += 1;
        }
    }
    return changed;
};

/**
 * Repair the keys of one part in place. Returns how many key events were
 * dropped. Raises `key_signature_repaired` when any was.
 */
export const repairKeySignatures = (raws: readonly RawMeasure[], warnings: Set<string>): number => {
    const drops: Drop[] = [];
    let partFifths = 0;
    let havePart = false;
    const staffFifths: Array<number | undefined> = [undefined, undefined];

    const revertWithin = (from: number, fifths: number): number | null => {
        const last = Math.min(raws.length - 1, from + 4);
        for (let pos = from + 1; pos <= last; pos++) {
            const raw = raws[pos];
            if (!raw) {
                continue;
            }
            if (keysIn(raw).some((k) => k.staff === null && k.fifths === fifths)) {
                return pos;
            }
        }
        return null;
    };

    for (let pos = 0; pos < raws.length; pos++) {
        const raw = raws[pos];
        if (!raw) {
            continue;
        }
        const keys = keysIn(raw);
        const dropped = new Set<KeyEvent>();

        for (const key of keys) {
            if (key.staff === null) {
                continue;
            }
            const other: 0 | 1 = key.staff === 0 ? 1 : 0;
            const otherNow = fifthsInForce(partFifths, staffFifths, other);
            const peer = keys.some((k) => k.staff === other && k.fifths === key.fifths);
            const partChange = keys.some((k) => k.staff === null && k.fifths === key.fifths);
            if (key.fifths !== otherNow && !peer && !partChange) {
                dropped.add(key);
                drops.push({ from: pos, to: raws.length - 1, staff: key.staff, trueFifths: otherNow });
            }
        }

        for (const key of keys) {
            if (key.staff !== null || dropped.has(key)) {
                continue;
            }
            if (raw.newSystem && havePart && key.fifths !== partFifths) {
                const back = revertWithin(pos, partFifths);
                if (back !== null) {
                    dropped.add(key);
                    const revertingRaw = raws[back];
                    const reverting = revertingRaw
                        ? keysIn(revertingRaw).find((k) => k.staff === null && k.fifths === partFifths)
                        : undefined;
                    if (reverting && revertingRaw) {
                        // The snap-back is part of the misread; drop it too so
                        // the 42-entry list collapses rather than flickering.
                        revertingRaw.events = revertingRaw.events.filter((ev) => ev !== reverting);
                    }
                    drops.push({ from: pos, to: back, staff: null, trueFifths: partFifths });
                }
            }
        }

        if (dropped.size > 0) {
            raw.events = raw.events.filter((ev) => !isKey(ev) || !dropped.has(ev));
        }
        for (const key of keysIn(raw)) {
            if (key.staff === null) {
                partFifths = key.fifths;
                havePart = true;
                staffFifths[0] = undefined;
                staffFifths[1] = undefined;
            } else {
                staffFifths[key.staff] = key.fifths;
            }
        }
    }

    if (drops.length === 0) {
        return 0;
    }
    // A later drop on the same staff shortens an open interval so we don't
    // re-spell past a key we have already decided was real.
    for (const drop of drops) {
        respell(raws, drop);
    }
    warnings.add('key_signature_repaired');
    return drops.length;
};
