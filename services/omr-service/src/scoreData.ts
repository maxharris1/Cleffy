import { z } from 'zod';

/**
 * ScoreData contract — KEEP IN LOCKSTEP with src/types/scoreData.ts in the
 * app (the app validates everything it reads with its own copy; drift shows
 * up as scores silently failing to parse client-side).
 */

/** Writer version for newly built analyses. */
export const SCORE_DATA_VERSION = 2;
export const TICKS_PER_QUARTER = 480;

export const HAND_RH = 0;
export const HAND_LH = 1;

const scoreNoteSchema = z.object({
    t: z.number().int().nonnegative(),
    d: z.number().int().positive(),
    p: z.number().int().min(0).max(127),
    h: z.union([z.literal(0), z.literal(1)]),
    v: z.number().min(0).max(1).optional(),
});

/** An engraved chord column: x normalized on the page, t ticks from the measure start. */
const scoreSlotSchema = z.object({
    x: z.number().min(0).max(1),
    t: z.number().int().nonnegative(),
});

const scoreMeasureSchema = z.object({
    n: z.number().int(),
    tick: z.number().int().nonnegative(),
    dTicks: z.number().int().positive(),
    page: z.number().int().min(-1),
    sys: z.number().int().min(-1),
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    /** Chord columns from the engraving — lets the playhead sweep note-accurately. */
    sl: z.array(scoreSlotSchema).max(64).optional(),
});

const scoreStaffBandSchema = z.object({
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
});

const scoreSystemSchema = z.object({
    page: z.number().int().nonnegative(),
    y0: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    /** Per-staff bands in score order (0 = upper/RH, 1 = lower/LH). */
    staves: z.array(scoreStaffBandSchema).max(4).optional(),
});

const scoreTimeSigSchema = z.object({
    tick: z.number().int().nonnegative(),
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

const scoreKeySigSchema = z.object({
    tick: z.number().int().nonnegative(),
    fifths: z.number().int().min(-7).max(7),
});

const scoreClefSchema = z.object({
    tick: z.number().int().nonnegative(),
    staff: z.union([z.literal(0), z.literal(1)]),
    sign: z.enum(['G', 'F', 'C']),
    line: z.number().int().min(1).max(5).optional(),
});

export const scoreDataSchema = z.object({
    version: z.number().int(),
    ticksPerQuarter: z.literal(TICKS_PER_QUARTER),
    defaultBpm: z.number().positive().nullable(),
    timeSignatures: z.array(scoreTimeSigSchema).max(64),
    keySignatures: z.array(scoreKeySigSchema).max(64).optional(),
    clefs: z.array(scoreClefSchema).max(64).optional(),
    totalTicks: z.number().int().positive(),
    notes: z.array(scoreNoteSchema).max(50_000),
    measures: z.array(scoreMeasureSchema).max(2_000),
    systems: z.array(scoreSystemSchema).max(500),
    warnings: z.array(z.string().max(64)).max(32),
});

export type ScoreNote = z.infer<typeof scoreNoteSchema>;
export type ScoreMeasure = z.infer<typeof scoreMeasureSchema>;
export type ScoreSystem = z.infer<typeof scoreSystemSchema>;
export type ScoreTimeSig = z.infer<typeof scoreTimeSigSchema>;
export type ScoreKeySig = z.infer<typeof scoreKeySigSchema>;
export type ScoreClef = z.infer<typeof scoreClefSchema>;
export type ScoreData = z.infer<typeof scoreDataSchema>;
