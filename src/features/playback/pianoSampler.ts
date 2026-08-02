/**
 * Bundled piano voice: 29 Salamander Grand anchors (every minor third,
 * C1–C8) served from /audio/piano and pitch-shifted at most ±1.5 semitones
 * via playbackRate. Regenerate the files with scripts/fetch-piano-samples.mjs
 * (keep ANCHOR list and that script in sync).
 *
 * Sample credit: Salamander Grand Piano by Alexander Holm, CC BY 3.0.
 */

const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'] as const;

const FIRST_ANCHOR_MIDI = 24; // C1
const LAST_ANCHOR_MIDI = 108; // C8
const ANCHOR_STEP = 3;

/** MIDI numbers of the bundled anchor samples, ascending. */
export const PIANO_ANCHORS: readonly number[] = Array.from(
    { length: (LAST_ANCHOR_MIDI - FIRST_ANCHOR_MIDI) / ANCHOR_STEP + 1 },
    (_, i) => FIRST_ANCHOR_MIDI + i * ANCHOR_STEP,
);

export const anchorFileName = (midi: number): string => {
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}.mp3`;
};

export const anchorUrl = (midi: number): string => `/audio/piano/${anchorFileName(midi)}`;

/** Nearest bundled anchor for a pitch (ties resolve downward — stretching up stays brighter). */
export const nearestAnchor = (midi: number): number => {
    if (midi <= FIRST_ANCHOR_MIDI) {
        return FIRST_ANCHOR_MIDI;
    }
    if (midi >= LAST_ANCHOR_MIDI) {
        return LAST_ANCHOR_MIDI;
    }
    const offset = midi - FIRST_ANCHOR_MIDI;
    const below = FIRST_ANCHOR_MIDI + Math.floor(offset / ANCHOR_STEP) * ANCHOR_STEP;
    const above = below + ANCHOR_STEP;
    return midi - below <= above - midi ? below : above;
};

export const playbackRateFor = (midi: number, anchor: number): number => Math.pow(2, (midi - anchor) / 12);

/** Minimal slice of AudioContext the loader needs (mockable in tests). */
export interface SampleDecoder {
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export type PianoBuffers = Map<number, AudioBuffer>;

let cache: Promise<PianoBuffers> | null = null;

/**
 * Fetch + decode all anchors in parallel, once per app lifetime (~0.85 MB
 * over the wire; the service worker CacheFirst route makes replays and
 * offline sessions free). Failure clears the cache so a retry can succeed.
 */
export const loadPianoBuffers = (decoder: SampleDecoder, fetchImpl: typeof fetch = fetch): Promise<PianoBuffers> => {
    if (!cache) {
        cache = (async () => {
            const entries = await Promise.all(
                PIANO_ANCHORS.map(async (midi): Promise<[number, AudioBuffer]> => {
                    const res = await fetchImpl(anchorUrl(midi));
                    if (!res.ok) {
                        throw new Error(`Piano sample ${anchorFileName(midi)}: HTTP ${res.status}`);
                    }
                    const buffer = await decoder.decodeAudioData(await res.arrayBuffer());
                    return [midi, buffer];
                }),
            );
            return new Map(entries);
        })().catch((err: unknown) => {
            cache = null;
            throw err;
        });
    }
    return cache;
};

/** Test hook. */
export const resetPianoBufferCache = (): void => {
    cache = null;
};
