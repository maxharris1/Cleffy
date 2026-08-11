/**
 * Fingering domain model — the contract that makes "one diagram renderer, N
 * populators" true. Vision, ScoreData (OMR), and manual entry all produce a
 * RecognizedRegion; page annotations and the suggestion engine produce
 * FingeringSequences; the keyboard diagram consumes FingeringEvents.
 */

export type Hand = 'L' | 'R';
export type Finger = 1 | 2 | 3 | 4 | 5;
export type Staff = 'upper' | 'lower';
export type Confidence = 'high' | 'medium' | 'low';
export type Clef = 'treble' | 'bass' | 'alto' | 'tenor' | 'none';

/** Rect in normalized page coordinates ({x,y,w,h} ∈ [0,1], same space as TextPayload). */
export interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Playable piano range: A0–C8. */
export const PIANO_MIN_MIDI = 21;
export const PIANO_MAX_MIDI = 108;

/** One note recognized on the page (vision) or entered by hand. */
export interface RecognizedNote {
    /** Client uuid — review edits and fingering pins key on it. */
    id: string;
    /** 21..108; clamp with clampMidi on ingest. */
    midi: number;
    /** Spelled display name, e.g. "C#4" / "Bb3" (midiToName). */
    name: string;
    staff: Staff;
    /** Notehead bbox in normalized page coords; all-zero for manual entries. */
    bbox: NormRect;
    /** Horizontal simultaneity group — notes sharing an index sound together. */
    eventIndex: number;
    /** Fingering read off the page (or set in review), if any. */
    annotatedFinger: Finger | null;
    fingerSource: 'vision' | 'client-text' | 'manual' | null;
    /** How sure vision was that the digit belongs to THIS note (merge input). */
    fingerConfidence?: Confidence;
    confidence: Confidence;
}

/** Everything known about one selected region — what the review UI edits. */
export interface RecognizedRegion {
    docId: string;
    page: number;
    /** The selection rect in normalized page coords. */
    rect: NormRect;
    /** -7..7 (sharps positive) — affects display spelling only. */
    keySignature: number;
    clefs: { upper: Clef; lower: Clef };
    notes: RecognizedNote[];
    /** Staff → hand mapping; default upper→R, lower→L, user-swappable. */
    handOf: Record<Staff, Hand>;
    source: 'omr' | 'vision' | 'manual';
}

export interface FingeredNote {
    noteId: string;
    midi: number;
    finger: Finger | null;
}

/** One time-step for one hand; notes sorted by ascending midi. The renderer unit. */
export interface FingeringEvent {
    /** The region eventIndex this step came from (merge key across hands). */
    index: number;
    hand: Hand;
    notes: FingeredNote[];
}

export interface FingeringSequence {
    hand: Hand;
    events: FingeringEvent[];
    source: 'annotated' | 'suggested';
}

export const clampMidi = (midi: number): number =>
    Math.min(PIANO_MAX_MIDI, Math.max(PIANO_MIN_MIDI, Math.round(midi)));

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Spell a midi pitch for display — flat names in flat keys, sharps otherwise. */
export const midiToName = (midi: number, keySignature = 0): string => {
    const pc = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    const names = keySignature < 0 ? FLAT_NAMES : SHARP_NAMES;
    return `${names[pc]}${octave}`;
};

export const isBlackKey = (midi: number): boolean => {
    const pc = ((midi % 12) + 12) % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
};

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const parseSpelledName = (name: string): { letter: string; accidental: string; shift: number } | null => {
    const match = /^([A-Ga-g])(##|#|bb|b|x)?(-?\d+)?$/.exec(name.trim());
    if (!match) {
        return null;
    }
    const letter = (match[1] as string).toUpperCase();
    const accidental = match[2] ?? '';
    const shift =
        accidental === 'x' || accidental === '##'
            ? 2
            : accidental === '#'
              ? 1
              : accidental === 'bb'
                ? -2
                : accidental === 'b'
                  ? -1
                  : 0;
    return { letter, accidental: accidental === 'x' ? '##' : accidental, shift };
};

/**
 * Keep the score's printed spelling when it names this exact pitch — a B♭
 * passing tone in C major must display as "Bb4", not the key-signature
 * respelling "A#4". Only the octave digit is recomputed from midi (so a
 * misread octave can't survive). Returns null when the spelling contradicts
 * the pitch — fall back to midiToName then.
 */
export const respellFromPrinted = (printedName: string, midi: number): string | null => {
    const parsed = parseSpelledName(printedName);
    if (!parsed) {
        return null;
    }
    const pc = ((LETTER_PC[parsed.letter] as number) + parsed.shift + 120) % 12;
    if (pc !== ((midi % 12) + 12) % 12) {
        return null;
    }
    // The LETTER's octave, not the sounding octave: Cb5 is midi 71, B#3 is 60.
    const octave = Math.floor((midi - parsed.shift) / 12) - 1;
    return `${parsed.letter}${parsed.accidental}${octave}`;
};

export const emptyRegion = (docId: string, page: number, rect: NormRect): RecognizedRegion => ({
    docId,
    page,
    rect,
    keySignature: 0,
    clefs: { upper: 'treble', lower: 'bass' },
    notes: [],
    handOf: { upper: 'R', lower: 'L' },
    source: 'manual',
});

const xCenter = (n: RecognizedNote): number => n.bbox.x + n.bbox.w / 2;

/**
 * Event groups in performance order: [eventIndex, notes][]. OMR regions use
 * tick-assigned eventIndex (required across system breaks where page-x resets).
 * Vision/manual sort by notehead x-center, falling back to eventIndex.
 */
const orderedEventGroups = (
    notes: readonly RecognizedNote[],
    orderBy: 'eventIndex' | 'x',
): Array<[number, RecognizedNote[]]> => {
    const byEvent = new Map<number, RecognizedNote[]>();
    for (const note of notes) {
        const group = byEvent.get(note.eventIndex);
        if (group) {
            group.push(note);
        } else {
            byEvent.set(note.eventIndex, [note]);
        }
    }
    return [...byEvent.entries()].sort((a, b) => {
        if (orderBy === 'eventIndex') {
            return a[0] - b[0];
        }
        const ax = Math.min(...a[1].map(xCenter));
        const bx = Math.min(...b[1].map(xCenter));
        return ax !== bx ? ax - bx : a[0] - b[0];
    });
};

/**
 * Fallback simultaneity grouping when eventIndex is missing or suspect:
 * cluster by notehead x-center, starting a new event when the gap exceeds
 * 0.6 × the median notehead width. Returns copies with eventIndex 0..n.
 */
export const groupIntoEvents = (notes: readonly RecognizedNote[]): RecognizedNote[] => {
    if (notes.length === 0) {
        return [];
    }
    const sorted = [...notes].sort((a, b) => xCenter(a) - xCenter(b));
    const widths = sorted
        .map((n) => n.bbox.w)
        .filter((w) => w > 0)
        .sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)] ?? 0.01;
    const threshold = 0.6 * median;

    let eventIndex = 0;
    let prevX = xCenter(sorted[0] as RecognizedNote);
    return sorted.map((note) => {
        const cx = xCenter(note);
        if (cx - prevX > threshold) {
            eventIndex += 1;
        }
        prevX = cx;
        return { ...note, eventIndex };
    });
};

/**
 * Per-hand sequences carrying the fingerings written on (or entered for) the
 * score. Events keep their region eventIndex so the panel can merge L/R steps.
 */
export const buildSequences = (region: RecognizedRegion): Record<Hand, FingeringSequence | null> => {
    const orderBy = region.source === 'omr' ? 'eventIndex' : 'x';
    const result: Record<Hand, FingeringSequence | null> = { L: null, R: null };
    for (const hand of ['L', 'R'] as const) {
        const notes = region.notes.filter((n) => region.handOf[n.staff] === hand);
        if (notes.length === 0) {
            continue;
        }
        const events: FingeringEvent[] = orderedEventGroups(notes, orderBy).map(([index, group]) => ({
            index,
            hand,
            notes: [...group]
                .sort((a, b) => a.midi - b.midi)
                .map((n) => ({ noteId: n.id, midi: n.midi, finger: n.annotatedFinger })),
        }));
        result[hand] = { hand, events, source: 'annotated' };
    }
    return result;
};

/** Union of event indices across both hands, in performance / page order. */
export const mergedEventIndices = (region: RecognizedRegion): number[] =>
    orderedEventGroups(region.notes, region.source === 'omr' ? 'eventIndex' : 'x').map(([index]) => index);

/** Keys down at one merged step, both hands, for the keyboard diagram. */
export const pressedAtIndex = (
    sequences: Record<Hand, FingeringSequence | null>,
    index: number,
): Array<{ midi: number; finger: Finger | null; hand: Hand }> => {
    const pressed: Array<{ midi: number; finger: Finger | null; hand: Hand }> = [];
    for (const hand of ['L', 'R'] as const) {
        const event = sequences[hand]?.events.find((e) => e.index === index);
        for (const note of event?.notes ?? []) {
            pressed.push({ midi: note.midi, finger: note.finger, hand });
        }
    }
    return pressed;
};
