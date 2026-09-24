import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScoreData } from '../scoreData.js';
import { corpusLookupByHash, corpusLookupByLayout, corpusPut, type CorpusSource } from './store.js';

const rpc = vi.fn();

vi.mock('../supabaseClient.js', () => ({
    serviceClient: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));

const score = (): ScoreData =>
    ({
        version: 3,
        ticksPerQuarter: 480,
        defaultBpm: 90,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: 480,
        notes: [{ t: 0, d: 480, p: 60, h: 0 }],
        measures: [{ n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 }],
        systems: [{ page: 0, y0: 0, y1: 1 }],
        warnings: [],
    }) as ScoreData;

const source: CorpusSource = { tier: 'symbolic', band: 'accept', reason: 'accept', origin: 'mutopia' };

const row = (over: Record<string, unknown> = {}) => ({
    pdf_sha256: 'abc',
    era: '',
    score: score(),
    alignment_map: {
        pdfSha256: 'abc',
        candidateSha256: 'cand',
        pickup: false,
        printedBars: 1,
        bySrcIndex: { 0: { page: 0, system: 0, x0: 0, x1: 1, y0: 0, y1: 1 } },
        entries: [],
    },
    source,
    candidate_sha256: 'cand',
    ...over,
});

beforeEach(() => {
    rpc.mockReset();
});

describe('corpusLookupByHash', () => {
    it('calls playalong_corpus_get_by_hash and returns the parsed row', async () => {
        rpc.mockResolvedValue({ data: [row()], error: null });
        const hit = await corpusLookupByHash('abc', 'svc-34', 'romantic');
        expect(rpc).toHaveBeenCalledWith('playalong_corpus_get_by_hash', {
            p_hash: 'abc',
            p_engine_version: 'svc-34',
            p_era: 'romantic',
        });
        expect(hit?.pdfSha256).toBe('abc');
        expect(hit?.score).toEqual(score());
        expect(hit?.alignmentMap?.candidateSha256).toBe('cand');
        expect(hit?.source.origin).toBe('mutopia');
        expect(hit?.candidateSha256).toBe('cand');
    });

    it('is a miss on an empty result, an RPC error, or a row that fails the schema', async () => {
        rpc.mockResolvedValueOnce({ data: [], error: null });
        expect(await corpusLookupByHash('abc', 'svc-34', '')).toBeNull();
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
        expect(await corpusLookupByHash('abc', 'svc-34', '')).toBeNull();
        rpc.mockResolvedValueOnce({ data: [row({ score: { nope: true } })], error: null });
        expect(await corpusLookupByHash('abc', 'svc-34', '')).toBeNull();
        rpc.mockResolvedValueOnce({ data: [row({ source: { tier: 'omr' } })], error: null });
        expect(await corpusLookupByHash('abc', 'svc-34', '')).toBeNull();
    });

    it('tolerates a null alignment_map (OMR rows)', async () => {
        rpc.mockResolvedValue({ data: [row({ alignment_map: null, candidate_sha256: null })], error: null });
        const hit = await corpusLookupByHash('abc', 'svc-34', 'romantic');
        expect(hit?.alignmentMap).toBeNull();
        expect(hit?.candidateSha256).toBeNull();
    });
});

describe('corpusLookupByLayout', () => {
    it('passes the WorkKey, bars and pages; a missing movement index is null', async () => {
        rpc.mockResolvedValue({ data: [row()], error: null });
        const hit = await corpusLookupByLayout(
            'svc-34',
            { composerId: 'chopin', catalogType: 'Op', catalogN: 9 },
            60,
            4,
        );
        expect(rpc).toHaveBeenCalledWith('playalong_corpus_get_by_layout', {
            p_engine_version: 'svc-34',
            p_work_composer_id: 'chopin',
            p_work_catalog_type: 'Op',
            p_work_catalog_n: 9,
            p_work_movement_index: null,
            p_printed_bars: 60,
            p_page_count: 4,
        });
        expect(hit?.pdfSha256).toBe('abc');
    });

    it('never asks for an unknown WorkKey or empty layout', async () => {
        expect(
            await corpusLookupByLayout('svc-34', { composerId: 'unknown', catalogType: 'Op', catalogN: 0 }, 60, 4),
        ).toBeNull();
        expect(
            await corpusLookupByLayout('svc-34', { composerId: 'chopin', catalogType: 'Op', catalogN: 9 }, 0, 4),
        ).toBeNull();
        expect(rpc).not.toHaveBeenCalled();
    });
});

describe('corpusPut', () => {
    it('maps the input onto playalong_corpus_put and reports the RPC verdict', async () => {
        rpc.mockResolvedValue({ data: true, error: null });
        const ok = await corpusPut({
            pdfSha256: 'abc',
            engineVersion: 'svc-34',
            era: '',
            score: score(),
            source,
            workKey: { composerId: 'chopin', catalogType: 'Op', catalogN: 9, movementIndex: 2 },
            printedBars: 60,
            pageCount: 4,
            candidateSha256: 'cand',
            candidateUrl: 'https://mutopia.example/x.mid',
            symbolicSource: 'mutopia',
            symbolicFormat: 'mid',
            imslpPageTitle: 'Nocturnes, Op.9 (Chopin, Frédéric)',
        });
        expect(ok).toBe(true);
        expect(rpc).toHaveBeenCalledWith(
            'playalong_corpus_put',
            expect.objectContaining({
                p_pdf_sha256: 'abc',
                p_engine_version: 'svc-34',
                p_era: '',
                p_source: source,
                p_alignment_map: null,
                p_work_composer_id: 'chopin',
                p_work_catalog_type: 'Op',
                p_work_catalog_n: 9,
                p_work_movement_index: 2,
                p_printed_bars: 60,
                p_page_count: 4,
                p_candidate_sha256: 'cand',
                p_candidate_url: 'https://mutopia.example/x.mid',
                p_symbolic_source: 'mutopia',
                p_symbolic_format: 'mid',
                p_imslp_page_title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
                p_licence_tag: null,
            }),
        );
    });

    it('is false when the RPC declines or fails, and never sends an invalid ScoreData', async () => {
        rpc.mockResolvedValueOnce({ data: false, error: null });
        const base = { pdfSha256: 'abc', engineVersion: 'svc-34', era: '', source, symbolicSource: 'omr' as const };
        expect(await corpusPut({ ...base, score: score() })).toBe(false);
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
        expect(await corpusPut({ ...base, score: score() })).toBe(false);
        rpc.mockReset();
        expect(await corpusPut({ ...base, score: { nope: true } as unknown as ScoreData })).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
    });
});
