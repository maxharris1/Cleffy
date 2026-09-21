import { z } from 'zod';

import type { AnnotationRow } from '@/types/database';

/**
 * Wire contracts for the per-document realtime channel (plan §realtime).
 * Everything arriving off the network is validated here before it touches
 * the stores — a malformed or malicious payload degrades to a warn, never
 * a crash.
 */

/** Live in-progress ink: streamed point batches, never persisted. */
export const inkProgressSchema = z.object({
    strokeId: z.string().min(1),
    userId: z.string().min(1),
    page: z.number().int().nonnegative(),
    kind: z.enum(['stroke', 'highlight']),
    color: z.string().min(1),
    /** Base width / page width. */
    w: z.number().positive(),
    /** Flat [x,y,p,…] batch to APPEND to the stroke. */
    pts: z.array(z.number()),
    /** Present on the final batch. */
    done: z.literal(true).optional(),
    /** Present when the stroke was abandoned (pointercancel). */
    cancel: z.literal(true).optional(),
});

export type InkProgressMsg = z.infer<typeof inkProgressSchema>;

export const INK_PROGRESS_EVENT = 'ink:progress';

/**
 * documents-row change fanned out by the documents_broadcast trigger
 * (the PDF bytes were replaced, or the student-layer share flag flipped).
 */
const documentChangeSchema = z.object({
    table: z.literal('documents'),
    record: z.object({
        id: z.string().min(1),
        content_rev: z.number().int().nonnegative(),
        share_student_layer: z.boolean().optional(),
    }),
});

export const parseDocumentChange = (
    payload: unknown,
): { id: string; content_rev: number; share_student_layer?: boolean } | null => {
    const parsed = documentChangeSchema.safeParse(payload);
    return parsed.success ? parsed.data.record : null;
};

// Provenance flags (`src` smart-import, `sf` suggested fingering, `hw`
// converted handwriting) and prose style (`font`, `bold`, `italic`) MUST be
// declared here: zod strips unknown keys, so omitting one would silently
// diverge peer payloads from the writer's.
const annotationLayerSchema = z.enum(['teacher', 'student']).optional();

const strokePayloadSchema = z.object({
    pts: z.array(z.number()),
    w: z.number().positive(),
    sp: z.literal(1).optional(),
    src: z.literal(1).optional(),
    layer: annotationLayerSchema,
});

const textPayloadSchema = z.object({
    x: z.number(),
    y: z.number(),
    text: z.string(),
    size: z.number().positive(),
    src: z.literal(1).optional(),
    sf: z.literal(1).optional(),
    hw: z.literal(1).optional(),
    font: z.enum(['sans', 'serif']).optional(),
    bold: z.literal(1).optional(),
    italic: z.union([z.literal(0), z.literal(1)]).optional(),
    layer: annotationLayerSchema,
});

const hairpinPayloadSchema = z.object({
    type: z.literal('hairpin'),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    spread: z.number().positive(),
    open: z.enum(['start', 'end']),
    layer: annotationLayerSchema,
});

/** Envelope produced by realtime.broadcast_changes() for annotation writes. */
const annotationRowSchema = z.object({
    id: z.string().min(1),
    document_id: z.string().min(1),
    page: z.number().int().nonnegative(),
    kind: z.enum(['stroke', 'highlight', 'text', 'shape']),
    color: z.string(),
    payload: z.union([hairpinPayloadSchema, strokePayloadSchema, textPayloadSchema]),
    created_by: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    seq: z.number(),
});

export const dbChangeSchema = z.object({
    operation: z.enum(['INSERT', 'UPDATE', 'DELETE']),
    schema: z.string(),
    table: z.string(),
    record: annotationRowSchema,
    old_record: annotationRowSchema.nullable().optional(),
});

/** Parse a broadcast_changes payload; null (with a warning) on mismatch. */
export const parseDbChange = (payload: unknown): AnnotationRow | null => {
    const parsed = dbChangeSchema.safeParse(payload);
    if (!parsed.success) {
        console.warn('Ignoring malformed annotation broadcast', parsed.error.issues[0]?.message);
        return null;
    }
    return parsed.data.record;
};

export const parseInkProgress = (payload: unknown): InkProgressMsg | null => {
    const parsed = inkProgressSchema.safeParse(payload);
    if (!parsed.success) {
        console.warn('Ignoring malformed ink broadcast', parsed.error.issues[0]?.message);
        return null;
    }
    return parsed.data;
};

/** Trimmed score_analyses lifecycle fan-out (never includes score jsonb). */
export const SCORE_ANALYSIS_EVENT = 'score_analysis';

const scoreAnalysisBroadcastSchema = z.object({
    table: z.literal('score_analyses'),
    document_id: z.string().min(1),
    status: z.enum(['pending', 'processing', 'ready', 'failed']),
    error: z.string().nullable().optional(),
    progress: z.number().nullable().optional(),
    updated_at: z.string(),
});

export type ScoreAnalysisBroadcast = z.infer<typeof scoreAnalysisBroadcastSchema>;

export const parseScoreAnalysisBroadcast = (payload: unknown): ScoreAnalysisBroadcast | null => {
    const parsed = scoreAnalysisBroadcastSchema.safeParse(payload);
    if (!parsed.success) {
        console.warn('Ignoring malformed score_analysis broadcast', parsed.error.issues[0]?.message);
        return null;
    }
    return parsed.data;
};

/** Presence payload tracked per user. */
export const presenceSchema = z.object({
    userId: z.string().min(1),
    name: z.string().min(1).max(80),
    color: z.string(),
    page: z.number().int().nonnegative(),
    isAnonymous: z.boolean(),
});

export type PresencePeer = z.infer<typeof presenceSchema>;
