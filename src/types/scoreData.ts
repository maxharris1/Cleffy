import { z } from 'zod';

/**
 * ScoreData — the derived musical model of a chart, produced by the OMR
 * service (Audiveris → MusicXML + pixel geometry) and stored in
 * `score_analyses.score`. It is everything playback needs: note events split
 * by hand, and the measure/system geometry that anchors the moving playhead
 * to the rendered PDF.
 *
 * All geometry is normalized 0–1 against its page (the same contract as
 * annotations), so it is zoom/DPI/rotation invariant.
 *
 * KEEP IN LOCKSTEP with services/omr-service/src/scoreData.ts.
 */

export const SCORE_DATA_VERSION = 1;

/** Canonical tick resolution — every duration is normalized to 480 ticks per quarter note. */
export const TICKS_PER_QUARTER = 480;

/** Right hand (upper staff). */
export const HAND_RH = 0;
/** Left hand (lower staff). */
export const HAND_LH = 1;

const scoreNoteSchema = z.object({
    /** Start, in ticks. */
    t: z.number().int().nonnegative(),
    /** Duration, in ticks (ties already merged). */
    d: z.number().int().positive(),
    /** MIDI pitch 0–127. */
    p: z.number().int().min(0).max(127),
    /** Hand: 0 = right (upper staff), 1 = left (lower staff). */
    h: z.union([z.literal(0), z.literal(1)]),
    /** Velocity 0–1 (optional; playback defaults apply). */
    v: z.number().min(0).max(1).optional(),
});

const scoreMeasureSchema = z.object({
    /** Display number as printed (pickup measures are 0). */
    n: z.number().int(),
    /** Start, in ticks. */
    tick: z.number().int().nonnegative(),
    /** Length, in ticks (pickups keep their real, shorter length). */
    dTicks: z.number().int().positive(),
    /** Page index, or -1 when this measure has no geometry. */
    page: z.number().int().min(-1),
    /** Index into `systems`, or -1 when this measure has no geometry (playhead hides). */
    sys: z.number().int().min(-1),
    /** Horizontal span on the page, normalized 0–1. */
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
});

const scoreSystemSchema = z.object({
    page: z.number().int().nonnegative(),
    /** Vertical band of the system on its page, normalized 0–1. */
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
});

const scoreTimeSigSchema = z.object({
    tick: z.number().int().nonnegative(),
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

export const scoreDataSchema = z.object({
    version: z.number().int(),
    ticksPerQuarter: z.literal(TICKS_PER_QUARTER),
    defaultBpm: z.number().positive().nullable(),
    timeSignatures: z.array(scoreTimeSigSchema),
    totalTicks: z.number().int().positive(),
    notes: z.array(scoreNoteSchema),
    measures: z.array(scoreMeasureSchema),
    systems: z.array(scoreSystemSchema),
    /** Machine-readable degradation notes, e.g. 'repeats_ignored', 'single_staff_all_rh'. */
    warnings: z.array(z.string()),
});

export type ScoreNote = z.infer<typeof scoreNoteSchema>;
export type ScoreMeasure = z.infer<typeof scoreMeasureSchema>;
export type ScoreSystem = z.infer<typeof scoreSystemSchema>;
export type ScoreTimeSig = z.infer<typeof scoreTimeSigSchema>;
export type ScoreData = z.infer<typeof scoreDataSchema>;

/**
 * Parse ScoreData arriving from Postgres jsonb or the Dexie cache. Malformed
 * or future-versioned payloads degrade to a warn + null, never a crash
 * (wire.ts discipline). Notes and measures are defensively re-sorted — every
 * consumer binary-searches them.
 */
export const parseScoreData = (raw: unknown): ScoreData | null => {
    const parsed = scoreDataSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn('Ignoring malformed ScoreData', parsed.error.issues[0]?.message);
        return null;
    }
    if (parsed.data.version !== SCORE_DATA_VERSION) {
        console.warn(`Ignoring ScoreData with unsupported version ${parsed.data.version}`);
        return null;
    }
    return {
        ...parsed.data,
        notes: [...parsed.data.notes].sort((a, b) => a.t - b.t),
        measures: [...parsed.data.measures].sort((a, b) => a.tick - b.tick),
        timeSignatures: [...parsed.data.timeSignatures].sort((a, b) => a.tick - b.tick),
    };
};

/** True when the score has any left-hand material (drives the LH mute control). */
export const hasLeftHand = (score: ScoreData): boolean => score.notes.some((note) => note.h === HAND_LH);
