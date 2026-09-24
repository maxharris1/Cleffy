import { pdfLayoutFromBytes } from './pdfLayout.js';
import { workKeyFromPdfLayout } from './pdfText.js';
import type { WorkKey } from './types.js';
import { workKeyFromText } from './workKey.js';

/**
 * Ranked WorkKey sources (try order; first hit wins for the job):
 *
 * 1. IMSLP page title
 * 2. PDF text layer
 * 3. filename
 * 4. vision (Gemini) — proposes a WorkKey only; never ingest
 *
 * This module implements ranks 1–3. Rank 4 is `createVisionWorkKeyProvider`
 * in `visionId.ts`. `pickWorkKey` sorts by this rank, so a 0.99 vision hit
 * cannot beat IMSLP or PDF text.
 */
export type WorkKeySource = 'imslp' | 'pdf_text' | 'filename' | 'vision';

export const WORK_KEY_SOURCE_RANK: Record<WorkKeySource, 1 | 2 | 3 | 4> = {
    imslp: 1,
    pdf_text: 2,
    filename: 3,
    vision: 4,
};

export interface WorkKeyHit {
    workKey: WorkKey;
    source: WorkKeySource;
    confidence: number;
    title?: string;
    composer?: string;
    catalog?: string;
    model?: string;
}

export interface IdentifyWorkInput {
    pdfBytes: Buffer;
    /** IMSLP work-page title (visionId `imslpTitle`). */
    imslpTitle?: string;
    /** Alias used by the OMR job. Same field as `imslpTitle`. */
    imslpPageTitle?: string;
    pdfText?: string;
    filename?: string;
    /**
     * When the caller already ran `pdfSignalsFromPdf`, pass its workKey so
     * this provider does not open the PDF a second time.
     */
    pdfTextWorkKey?: WorkKey | null;
}

/**
 * Pluggable work identification for symbolic-first discovery.
 *
 * Input: PDF bytes plus optional IMSLP title / PDF text / filename.
 * Output: WorkKey hits in rank order (1 IMSLP → 2 PDF text → 3 filename → 4 vision).
 *
 * Vision implements this same interface (`source: 'vision'`). It only
 * proposes a WorkKey for discover; it never ingests. Do not add an LLM
 * path in this module.
 */
export interface WorkKeyProvider {
    identify(input: IdentifyWorkInput): Promise<WorkKeyHit[]>;
}

const usable = (key: WorkKey | null | undefined): WorkKey | null => {
    if (!key || key.composerId === 'unknown') {
        return null;
    }
    return key;
};

const byRank = (a: WorkKeyHit, b: WorkKeyHit): number => {
    const rank = WORK_KEY_SOURCE_RANK[a.source] - WORK_KEY_SOURCE_RANK[b.source];
    if (rank !== 0) {
        return rank;
    }
    return b.confidence - a.confidence;
};

/**
 * Ranks 1–3. Vision is rank 4 and is not called here.
 * Signature matches `workKeyFromMetadata` on `mh/symbolic-vision-id-5825`.
 */
export const workKeyFromMetadata = (input: {
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
}): WorkKeyHit | null => {
    const hits = metadataHits(input);
    return hits[0] ?? null;
};

const metadataHits = (input: { imslpTitle?: string; pdfText?: string; filename?: string }): WorkKeyHit[] => {
    const hits: WorkKeyHit[] = [];
    const imslp = input.imslpTitle?.trim();
    if (imslp) {
        const key = usable(workKeyFromText(imslp));
        if (key) {
            hits.push({ workKey: key, source: 'imslp', title: imslp, confidence: 1 });
        }
    }
    const pdfText = input.pdfText?.trim();
    if (pdfText) {
        const key = usable(workKeyFromText(pdfText));
        if (key) {
            hits.push({ workKey: key, source: 'pdf_text', confidence: 1 });
        }
    }
    const filename = input.filename?.trim();
    if (filename) {
        const key = usable(workKeyFromText(filename));
        if (key) {
            hits.push({ workKey: key, source: 'filename', confidence: 0.4 });
        }
    }
    return hits.sort(byRank);
};

/**
 * Ranks 1–3 for the job. Rank 4 (vision) is a separate WorkKeyProvider;
 * composing providers must keep this order and must not ingest on vision.
 */
export const pdfTextWorkKeyProvider: WorkKeyProvider = {
    identify: async (input) => {
        const imslpTitle = input.imslpTitle ?? input.imslpPageTitle;
        const hits = metadataHits({
            ...(imslpTitle !== undefined ? { imslpTitle } : {}),
            ...(input.pdfText !== undefined ? { pdfText: input.pdfText } : {}),
            ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        const hasPdfText = hits.some((h) => h.source === 'pdf_text');
        if (!hasPdfText) {
            let fromPdf = usable(input.pdfTextWorkKey);
            if (fromPdf === null && input.pdfTextWorkKey === undefined && input.pdfText === undefined) {
                const layout = await pdfLayoutFromBytes(new Uint8Array(input.pdfBytes));
                fromPdf = usable(workKeyFromPdfLayout(layout));
            }
            if (fromPdf) {
                hits.push({ workKey: fromPdf, source: 'pdf_text', confidence: 1 });
            }
        }
        return hits.sort(byRank);
    },
};

export const pickWorkKey = (hits: readonly WorkKeyHit[], fallback: WorkKey): WorkKey =>
    [...hits].sort(byRank)[0]?.workKey ?? fallback;
