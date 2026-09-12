import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

const midiBasenameSchema = z
    .string()
    .regex(/^[A-Za-z0-9._-]+\.mid$/i, 'midi must be a basename ending in .mid (no path separators)');

const slugSchema = z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case');

const movementSchema = z.object({
    name: z.string().min(1),
    /** Basename inside the reference zip or fixture dir (e.g. `moonlight1.mid`). */
    midi: midiBasenameSchema,
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
    /**
     * Fermatas printed in the movement. Read off the engraving, never inferred
     * from MIDI wall-clock: Mutopia MIDI is notation-quantized and holds no
     * fermata. The play-along gate is one-sided against it — a hold the page
     * does not print is a wonky pause, a fermata OMR missed still plays the
     * printed grid.
     */
    expectedHolds: z.number().int().nonnegative().default(0),
    /**
     * Notes a CORRECT performance adds that the reference MIDI does not contain,
     * because LilyPond's MIDI ignores engraved ornament signs while Cleffy
     * realizes them (`src/ornaments.ts`). Without this the gate would punish the
     * parser for being right.
     *
     * Derived from the signs printed in the edition, never from the parser's
     * output: a `\prall` (MusicXML inverted-mordent) or `\mordent` on a note long
     * enough to host the figure becomes three notes via `realizeMordent`, so +2
     * each; a `\turn` becomes four or five via `realizeTurn`, so +4 at the upper
     * bound. A pin carrying `\trill` has to state its own bound — a trill fills
     * the principal's whole span, so the count depends on the note value.
     */
    expectedExtraNotes: z.number().int().nonnegative().default(0),
});

const pdfSchema = z.object({
    url: z.string().url(),
    /** Required before `--from pdf`; fetch refuses an unpinned file. */
    sha256: sha256Schema.optional(),
    pages: z.number().int().positive(),
});

const mutopiaReferenceSchema = z.object({
    source: z.literal('mutopia'),
    url: z.string().url(),
    sha256: sha256Schema,
    license: z.string().min(1),
});

const fixtureReferenceSchema = z.object({
    source: z.literal('fixture'),
    license: z.string().min(1),
});

const referenceSchema = z.discriminatedUnion('source', [mutopiaReferenceSchema, fixtureReferenceSchema]);

export const corpusEntrySchema = z.object({
    slug: slugSchema,
    title: z.string().min(1),
    pdf: pdfSchema,
    reference: referenceSchema,
    movements: z.array(movementSchema).min(1),
    editionNotes: z.array(z.string()).default([]),
});

export type CorpusMeter = z.infer<typeof meterSchema>;
export type CorpusMovement = z.infer<typeof movementSchema>;
export type CorpusEntry = z.infer<typeof corpusEntrySchema>;

export const assertSlug = (slug: string): string => {
    const parsed = slugSchema.safeParse(slug);
    if (!parsed.success) {
        throw new Error(`Invalid corpus slug '${slug}': ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
};

export const loadCorpusEntry = (slug: string): CorpusEntry => {
    const safe = assertSlug(slug);
    const path = join(corpusDir(), `${safe}.json`);
    if (basename(path) !== `${safe}.json`) {
        throw new Error(`Corpus slug escaped the corpus directory: ${slug}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(`Corpus entry not found or not JSON: ${path}`, { cause: err });
    }
    const parsed = corpusEntrySchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`Invalid corpus entry ${safe}: ${issue?.path.join('.')}: ${issue?.message}`);
    }
    if (parsed.data.slug !== safe) {
        throw new Error(`Corpus slug mismatch: file is '${parsed.data.slug}', asked for '${safe}'`);
    }
    return parsed.data;
};
