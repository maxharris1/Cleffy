import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { corpusDir } from './paths.js';

const sha256Schema = z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars');

const meterSchema = z.object({
    num: z.number().int().positive(),
    den: z.number().int().positive(),
});

const tempoRangeSchema = z.object({
    min: z.number().positive(),
    max: z.number().positive(),
});

const movementSchema = z.object({
    name: z.string().min(1),
    /** Filename inside the reference zip (e.g. `moonlight1.mid`). */
    midi: z.string().min(1),
    meter: meterSchema,
    /** Pickup length in quarter-notes. 0 when the first bar is complete. */
    pickupQuarters: z.number().nonnegative(),
    /** Engraved bars in the reference, including a numbered pickup as bar 0. */
    printedBars: z.number().int().positive(),
    /** Circle-of-fifths of the movement's home key. */
    expectedFifths: z.number().int().min(-7).max(7),
    expectedTempo: tempoRangeSchema,
    /**
     * Mutopia MIDI is written once through; repeats are not unfolded. Keep this
     * false unless a later source actually expands them.
     */
    repeatsUnfoldedInMidi: z.boolean(),
    /** How many bars a correct performance of the page should play. */
    performedBars: z.number().int().positive().optional(),
});

const pdfSchema = z.object({
    url: z.string().url(),
    /** Pin once the file is in hand; fetch verifies when present. */
    sha256: sha256Schema.optional(),
    pages: z.number().int().positive(),
});

const referenceSchema = z.object({
    source: z.literal('mutopia'),
    url: z.string().url(),
    sha256: sha256Schema,
    license: z.string().min(1),
});

export const corpusEntrySchema = z.object({
    slug: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case'),
    title: z.string().min(1),
    pdf: pdfSchema,
    reference: referenceSchema,
    movements: z.array(movementSchema).min(1),
    editionNotes: z.array(z.string()).default([]),
});

export type CorpusMeter = z.infer<typeof meterSchema>;
export type CorpusMovement = z.infer<typeof movementSchema>;
export type CorpusEntry = z.infer<typeof corpusEntrySchema>;

export const loadCorpusEntry = (slug: string): CorpusEntry => {
    const path = join(corpusDir(), `${slug}.json`);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(`Corpus entry not found or not JSON: ${path}`, { cause: err });
    }
    const parsed = corpusEntrySchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`Invalid corpus entry ${slug}: ${issue?.path.join('.')}: ${issue?.message}`);
    }
    if (parsed.data.slug !== slug) {
        throw new Error(`Corpus slug mismatch: file is '${parsed.data.slug}', asked for '${slug}'`);
    }
    return parsed.data;
};
