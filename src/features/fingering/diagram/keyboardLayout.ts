import { clampMidi, isBlackKey, PIANO_MAX_MIDI, PIANO_MIN_MIDI, type Hand } from '@/features/fingering/model';

/** Hand colors: RH = brand accent (keep in sync with --color-accent), LH = emerald. */
export const HAND_COLORS: Record<Hand, string> = { R: '#4338ca', L: '#16a34a' };
export const HAND_LABELS: Record<Hand, string> = { R: 'Right hand', L: 'Left hand' };

/** Abstract SVG units — the diagram scales to its container via viewBox. */
export const WHITE_KEY_W = 24;
export const WHITE_KEY_H = 96;
export const BLACK_KEY_W = 14;
export const BLACK_KEY_H = 58;

export interface KeyRect {
    midi: number;
    isBlack: boolean;
    x: number;
    w: number;
    h: number;
}

export interface KeyboardGeometry {
    /** Ascending midi order; draw whites first, then blacks on top. */
    keys: KeyRect[];
    width: number;
    height: number;
}

/**
 * Key rectangles for the inclusive midi range. Endpoints are extended outward
 * to white keys so the keyboard never starts or ends on a black sliver.
 */
export const layoutKeyboard = (minMidi: number, maxMidi: number): KeyboardGeometry => {
    let lo = clampMidi(Math.min(minMidi, maxMidi));
    let hi = clampMidi(Math.max(minMidi, maxMidi));
    while (isBlackKey(lo) && lo > PIANO_MIN_MIDI) {
        lo--;
    }
    while (isBlackKey(hi) && hi < PIANO_MAX_MIDI) {
        hi++;
    }

    const keys: KeyRect[] = [];
    let whiteCount = 0;
    for (let midi = lo; midi <= hi; midi++) {
        if (isBlackKey(midi)) {
            // Straddle the boundary between the neighboring white keys.
            keys.push({
                midi,
                isBlack: true,
                x: whiteCount * WHITE_KEY_W - BLACK_KEY_W / 2,
                w: BLACK_KEY_W,
                h: BLACK_KEY_H,
            });
        } else {
            keys.push({ midi, isBlack: false, x: whiteCount * WHITE_KEY_W, w: WHITE_KEY_W, h: WHITE_KEY_H });
            whiteCount++;
        }
    }
    return { keys, width: whiteCount * WHITE_KEY_W, height: WHITE_KEY_H };
};

/**
 * Display range for a phrase: pad the pressed range by ~a white key per side,
 * widen to at least an octave (tiny selections look cramped otherwise), and
 * land both endpoints on white keys. Compute once across the WHOLE phrase so
 * the keyboard doesn't jump between steps.
 */
export const snapRange = (minMidi: number, maxMidi: number): { min: number; max: number } => {
    let lo = clampMidi(Math.min(minMidi, maxMidi)) - 2;
    let hi = clampMidi(Math.max(minMidi, maxMidi)) + 2;
    lo = Math.max(PIANO_MIN_MIDI, lo);
    hi = Math.min(PIANO_MAX_MIDI, hi);
    while (hi - lo < 12) {
        if (lo > PIANO_MIN_MIDI) {
            lo--;
        } else if (hi < PIANO_MAX_MIDI) {
            hi++;
        } else {
            break;
        }
    }
    while (isBlackKey(lo) && lo > PIANO_MIN_MIDI) {
        lo--;
    }
    while (isBlackKey(hi) && hi < PIANO_MAX_MIDI) {
        hi++;
    }
    return { min: lo, max: hi };
};
