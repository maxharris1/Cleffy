import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as corpusStore from './corpus/store.js';
import type * as era from './era.js';
import { ENGINE_VERSION, runClaimedJob, runJob } from './job.js';
import type * as jobStore from './jobStore.js';
import type { ScoreData } from './scoreData.js';
import type { JobTimings } from './timings.js';
import type { Writeback } from './writeback.js';

const cacheLookup = vi.fn();
const completeJob = vi.fn();
const titleForDocument = vi.fn();
const corpusLookupByHash = vi.fn();
const corpusPut = vi.fn();

vi.mock('./jobStore.js', async (importOriginal) => {
    const actual = await importOriginal<typeof jobStore>();
    return {
        ...actual,
        cacheLookup: (...args: unknown[]) => cacheLookup(...args),
        cacheStore: async () => undefined,
        completeJob: (...args: unknown[]) => completeJob(...args),
        failJob: async () => null,
        heartbeatJob: async () => true,
        stillOwnsJob: async () => true,
        mintSignedUrl: async () => 'https://example.test/signed.pdf',
    };
});

vi.mock('./documentTitle.js', () => ({
    titleForDocument: (...args: unknown[]) => titleForDocument(...args),
}));

vi.mock('./era.js', async (importOriginal) => {
    const actual = await importOriginal<typeof era>();
    return { ...actual, eraForDocument: async () => 'baroque' };
});

vi.mock('./corpus/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof corpusStore>();
    return {
        ...actual,
        corpusLookupByHash: (...args: unknown[]) => corpusLookupByHash(...args),
        corpusLookupByLayout: async () => null,
        corpusPut: (...args: unknown[]) => corpusPut(...args),
        pdProvenance: async () => null,
    };
});

const MINIMAL_PDF = Buffer.from(
    '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const DOC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER = '11111111-1111-1111-1111-111111111111';
const TITLE = 'Inventions (Bach, Johann Sebastian)';

const omrScore = (): ScoreData =>
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

const claimed = (createdBy: string | null) => ({
    id: 7,
    document_id: DOC,
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    storage_path: `${DOC}/original.pdf`,
    page_count: 1,
    created_by: createdBy,
});

const writeback: Writeback = {
    processing: async () => undefined,
    ready: vi.fn(async () => undefined),
    failed: async () => undefined,
};

beforeEach(() => {
    cacheLookup.mockReset();
    completeJob.mockReset();
    titleForDocument.mockReset();
    corpusLookupByHash.mockReset();
    corpusPut.mockReset();
    cacheLookup.mockResolvedValue({ score: omrScore(), bpmDefault: 90 });
    completeJob.mockResolvedValue(true);
    corpusLookupByHash.mockResolvedValue(null);
    corpusPut.mockResolvedValue(true);
    vi.mocked(writeback.ready).mockClear();
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from(MINIMAL_PDF), { status: 200 }));
    vi.stubEnv('CLEFFY_CORPUS_LOOKUP', '1');
    vi.stubEnv('CLEFFY_SYMBOLIC_FIRST', '0');
    vi.stubEnv('CLEFFY_CORPUS_OWNER_USER_ID', OWNER);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('runClaimedJob — corpus adapters', () => {
    it('passes titleForDocument into the pipeline: an IMSLP import is written to the corpus under its title', async () => {
        titleForDocument.mockResolvedValue(TITLE);
        const { ok } = await runClaimedJob(claimed(null), 'worker', writeback);
        expect(ok).toBe(true);
        expect(titleForDocument).toHaveBeenCalledWith(DOC);
        expect(corpusLookupByHash).toHaveBeenCalledWith(expect.any(String), ENGINE_VERSION, 'baroque');
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({
            imslpPageTitle: TITLE,
            era: 'baroque',
            symbolicSource: 'omr',
        });
        const timings = completeJob.mock.calls[0]![4] as JobTimings;
        expect(timings.cacheHit).toBe(true);
        expect(timings.corpusHit).toBeUndefined();
    });

    it('a corpus-owner job is written even without a title; another user’s upload is not', async () => {
        titleForDocument.mockResolvedValue(null);
        await runClaimedJob(claimed(OWNER), 'worker', writeback);
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).not.toHaveProperty('imslpPageTitle');

        corpusPut.mockClear();
        await runClaimedJob(claimed('22222222-2222-2222-2222-222222222222'), 'worker', writeback);
        expect(corpusPut).not.toHaveBeenCalled();
    });

    it('a hash hit completes the job through omr_complete_job with corpusHit and never reads the cache', async () => {
        titleForDocument.mockResolvedValue(null);
        corpusLookupByHash.mockResolvedValue({
            pdfSha256: 'x',
            era: '',
            score: omrScore(),
            alignmentMap: null,
            source: { tier: 'omr', band: 'reject', reason: 'no_candidate', origin: 'omr' },
            candidateSha256: null,
        });
        const { ok } = await runClaimedJob(claimed(null), 'worker', writeback);
        expect(ok).toBe(true);
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
        expect(completeJob).toHaveBeenCalledWith(
            7,
            'worker',
            omrScore(),
            ENGINE_VERSION,
            expect.objectContaining({ corpusHit: 'hash' }),
        );
    });
});

describe('runJob — push mode', () => {
    it('forwards the /jobs imslpPageTitle so an IMSLP import is written to the corpus', async () => {
        await runJob(
            { documentId: DOC, pdfSignedUrl: 'https://example.test/signed.pdf', pageCount: 1, imslpPageTitle: TITLE },
            writeback,
        );
        expect(writeback.ready).toHaveBeenCalledTimes(1);
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({ imslpPageTitle: TITLE });
    });

    it('without a title (an upload) nothing is written', async () => {
        await runJob({ documentId: DOC, pdfSignedUrl: 'https://example.test/signed.pdf', pageCount: 1 }, writeback);
        expect(writeback.ready).toHaveBeenCalledTimes(1);
        expect(corpusPut).not.toHaveBeenCalled();
    });
});
