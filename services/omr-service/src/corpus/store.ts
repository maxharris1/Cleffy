import { z } from 'zod';

import { scoreDataSchema, type ScoreData } from '../scoreData.js';
import { serviceClient } from '../supabaseClient.js';
import type { AlignmentMap } from '../symbolic/align.js';
import type { AnalysisLicence, AnalysisSource } from '../symbolic/jobResult.js';
import type { SymbolicFormat, WorkKey } from '../symbolic/types.js';

/**
 * `playalong_corpus` over the service-role RPCs — the corpus siblings of
 * `cacheLookup` / `cacheStore` in jobStore.ts. Every call is one row: the
 * hash and layout RPCs return the single winner or nothing, and every failure
 * (no client, RPC error, schema drift) reads as a miss so the job falls
 * through to today's symbolic / cache / Audiveris path.
 */

export type CorpusOrigin = 'mutopia' | 'openscore' | 'ia' | 'commons' | 'library' | 'omr';
export type CorpusSymbolicSource = 'mutopia' | 'openscore' | 'ia' | 'omr';
export type CorpusLicenceTag = AnalysisLicence;

/** `playalong_corpus.source`: the AnalysisSource the client badges from, plus provenance. */
export interface CorpusSource extends AnalysisSource {
    origin: CorpusOrigin;
    source_url?: string;
    licence_tag?: CorpusLicenceTag;
    editor_credit?: string;
    us_pd?: boolean;
    imslp_page_title?: string;
}

export interface CorpusHit {
    pdfSha256: string;
    era: string;
    score: ScoreData;
    alignmentMap: AlignmentMap | null;
    source: CorpusSource;
    candidateSha256: string | null;
}

export interface CorpusPutInput {
    pdfSha256: string;
    engineVersion: string;
    /** '' for symbolic rows; the document's era for OMR rows. */
    era: string;
    score: ScoreData;
    alignmentMap?: AlignmentMap;
    source: CorpusSource;
    workKey?: WorkKey;
    printedBars?: number;
    pageCount?: number;
    candidateSha256?: string;
    candidateUrl?: string;
    symbolicSource: CorpusSymbolicSource;
    symbolicFormat?: SymbolicFormat;
    imslpPageTitle?: string;
    licenceTag?: CorpusLicenceTag;
    editorCredit?: string;
    sourceUrl?: string;
}

const alignBoxSchema = z.object({
    page: z.number(),
    system: z.number(),
    x0: z.number(),
    x1: z.number(),
    y0: z.number(),
    y1: z.number(),
});

const alignmentMapSchema = z.object({
    pdfSha256: z.string(),
    candidateSha256: z.string(),
    pickup: z.boolean(),
    printedBars: z.number(),
    bySrcIndex: z.record(z.string(), alignBoxSchema),
    entries: z.array(
        z.object({
            printedBar: z.number(),
            performedBar: z.number(),
            page: z.number(),
            system: z.number(),
            box: alignBoxSchema,
        }),
    ),
});

const corpusSourceSchema = z.looseObject({
    tier: z.enum(['symbolic', 'omr']),
    band: z.enum(['accept', 'ambiguous', 'reject']),
    reason: z.enum([
        'accept',
        'ambiguous',
        'low_score',
        'meter',
        'bars',
        'arrangement',
        'performance_midi',
        'no_candidate',
        'parser_unusable',
        'alignment_failed',
    ]),
    origin: z.enum(['mutopia', 'openscore', 'ia', 'commons', 'library', 'omr']),
});

const corpusRowSchema = z.object({
    pdf_sha256: z.string(),
    era: z.string(),
    score: scoreDataSchema,
    alignment_map: alignmentMapSchema.nullable().optional(),
    source: corpusSourceSchema,
    candidate_sha256: z.string().nullable().optional(),
});

const asHit = (data: unknown): CorpusHit | null => {
    const raw = Array.isArray(data) ? data[0] : data;
    if (raw === undefined || raw === null) {
        return null;
    }
    const parsed = corpusRowSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn('[corpus] row schema failed', parsed.error.issues[0]?.message);
        return null;
    }
    const row = parsed.data;
    return {
        pdfSha256: row.pdf_sha256,
        era: row.era,
        score: row.score,
        alignmentMap: row.alignment_map ?? null,
        source: row.source as CorpusSource,
        candidateSha256: row.candidate_sha256 ?? null,
    };
};

export const corpusLookupByHash = async (
    pdfSha256: string,
    engineVersion: string,
    era: string,
): Promise<CorpusHit | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase.rpc('playalong_corpus_get_by_hash', {
        p_hash: pdfSha256,
        p_engine_version: engineVersion,
        p_era: era,
    });
    if (error) {
        console.warn('[corpus] get_by_hash failed:', error.message);
        return null;
    }
    return asHit(data);
};

/** Another edition of the same work; null on miss, collision, or an unknown WorkKey. */
export const corpusLookupByLayout = async (
    engineVersion: string,
    workKey: WorkKey,
    printedBars: number,
    pageCount: number,
): Promise<CorpusHit | null> => {
    if (workKey.composerId === 'unknown' || workKey.catalogN <= 0 || printedBars <= 0 || pageCount <= 0) {
        return null;
    }
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase.rpc('playalong_corpus_get_by_layout', {
        p_engine_version: engineVersion,
        p_work_composer_id: workKey.composerId,
        p_work_catalog_type: workKey.catalogType,
        p_work_catalog_n: workKey.catalogN,
        p_work_movement_index: workKey.movementIndex ?? null,
        p_printed_bars: printedBars,
        p_page_count: pageCount,
    });
    if (error) {
        console.warn('[corpus] get_by_layout failed:', error.message);
        return null;
    }
    return asHit(data);
};

/**
 * The client badges from `score_analyses.timings.source` and reads camelCase
 * keys; a corpus row keeps its provenance under the snake_case column names it
 * was stored from. This is the one place the two shapes meet.
 */
export const analysisSourceFromCorpus = (source: CorpusSource): AnalysisSource => ({
    tier: source.tier,
    band: source.band,
    reason: source.reason,
    ...(source.format !== undefined ? { format: source.format } : {}),
    ...(source.sourceName !== undefined ? { sourceName: source.sourceName } : {}),
    ...(source.matchScore !== undefined ? { matchScore: source.matchScore } : {}),
    ...(source.licence_tag !== undefined ? { licence: source.licence_tag } : {}),
    ...(source.editor_credit !== undefined ? { editorCredit: source.editor_credit } : {}),
    ...(source.source_url !== undefined ? { sourceUrl: source.source_url } : {}),
});

/** Provenance the seed recorded for a PDF it fetched from a public mirror. */
export interface PdProvenance {
    licenceTag: CorpusLicenceTag;
    editorCredit: string | null;
    sourceUrl: string | null;
    usPd: boolean;
}

const LICENCE_TAGS: readonly CorpusLicenceTag[] = ['PD', 'CC0', 'CC-BY', 'CC-BY-SA'];

const pdProvenanceSchema = z.object({
    licence_tag: z.enum(LICENCE_TAGS),
    editor_credit: z.string().nullable().optional(),
    source_url: z.string().nullable().optional(),
    us_pd: z.boolean(),
});

/**
 * Licence / credit / source for a seeded PDF, keyed by its bytes. The seed
 * writes `pd_pdf_store`; the worker reads it so a corpus row and the player's
 * attribution carry the same provenance the licence filter decided on. Null for
 * anything the seed did not fetch (every user upload) and on any failure.
 */
export const pdProvenance = async (pdfSha256: string): Promise<PdProvenance | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    const { data, error } = await supabase
        .from('pd_pdf_store')
        .select('licence_tag,editor_credit,source_url,us_pd')
        .eq('pdf_sha256', pdfSha256)
        .maybeSingle();
    if (error) {
        console.warn('[corpus] pd_pdf_store read failed:', error.message);
        return null;
    }
    if (data === null) {
        return null;
    }
    const parsed = pdProvenanceSchema.safeParse(data);
    if (!parsed.success) {
        console.warn('[corpus] pd_pdf_store row schema failed', parsed.error.issues[0]?.message);
        return null;
    }
    return {
        licenceTag: parsed.data.licence_tag,
        editorCredit: parsed.data.editor_credit ?? null,
        sourceUrl: parsed.data.source_url ?? null,
        usPd: parsed.data.us_pd,
    };
};

/** Upsert one corpus row. Resolves false when the RPC declined (OMR over a symbolic row) or failed. */
export const corpusPut = async (input: CorpusPutInput): Promise<boolean> => {
    const supabase = serviceClient();
    if (!supabase) {
        return false;
    }
    const checked = scoreDataSchema.safeParse(input.score);
    if (!checked.success) {
        console.warn('[corpus] put: ScoreData schema failed', checked.error.issues[0]?.message);
        return false;
    }
    const { data, error } = await supabase.rpc('playalong_corpus_put', {
        p_pdf_sha256: input.pdfSha256,
        p_engine_version: input.engineVersion,
        p_era: input.era,
        p_score: checked.data,
        p_source: input.source,
        p_alignment_map: input.alignmentMap ?? null,
        p_work_composer_id: input.workKey?.composerId ?? null,
        p_work_catalog_type: input.workKey?.catalogType ?? null,
        p_work_catalog_n: input.workKey?.catalogN ?? null,
        p_work_movement_index: input.workKey?.movementIndex ?? null,
        p_printed_bars: input.printedBars ?? null,
        p_page_count: input.pageCount ?? null,
        p_layout_fp: null,
        p_candidate_sha256: input.candidateSha256 ?? null,
        p_candidate_url: input.candidateUrl ?? null,
        p_symbolic_source: input.symbolicSource,
        p_symbolic_format: input.symbolicFormat ?? null,
        p_imslp_page_title: input.imslpPageTitle ?? null,
        p_licence_tag: input.licenceTag ?? null,
        p_editor_credit: input.editorCredit ?? null,
        p_source_url: input.sourceUrl ?? null,
    });
    if (error) {
        console.warn('[corpus] put failed:', error.message);
        return false;
    }
    return data === true;
};
