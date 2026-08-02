import { z } from 'zod';

/**
 * ScoreData contract — KEEP IN LOCKSTEP with src/types/scoreData.ts in the
 * app (the app validates everything it reads with its own copy; drift shows
 * up as scores silently failing to parse client-side).
 */

export const SCORE_DATA_VERSION = 1;
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

const scoreMeasureSchema = z.object({
    n: z.number().int(),
    tick: z.number().int().nonnegative(),
    dTicks: z.number().int().positive(),
    page: z.number().int().min(-1),
    sys: z.number().int().min(-1),
    x0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
});

const scoreSystemSchema = z.object({
    page: z.number().int().nonnegative(),
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
    timeSignatures: z.array(scoreTimeSigSchema).max(64),
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
export type ScoreData = z.infer<typeof scoreDataSchema>;
