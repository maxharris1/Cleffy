import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import {
    analysisIsStale,
    analysisIsStaleAgainst,
    CURRENT_ENGINE_GENERATION,
    DEPLOYED_ENGINE_GENERATION,
    ERA_AWARE_ENGINE_GENERATION,
    fetchScoreAnalysisFull,
    fetchScoreAnalysisStatus,
    isProcessingStale,
    requestScoreAnalysis,
    saveBpmOverride,
} from '@/features/playback/scoreAnalysisService';
import { getDb } from '@/sync/db';

interface FakeSupabase {
    row: Record<string, unknown> | null;
    selectError: { message: string } | null;
    lastSelect: string | null;
    invokeResult: { data: unknown; error: null | { message: string; context?: Response } };
    lastInvoke: { name: string; body: unknown } | null;
}

const fake: FakeSupabase = {
    row: null,
    selectError: null,
    lastSelect: null,
    invokeResult: { data: { ok: true }, error: null },
    lastInvoke: null,
};

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
    getSupabase: () => ({
        from: () => ({
            select: (columns: string) => {
                fake.lastSelect = columns;
                return {
                    eq: () => ({
                        maybeSingle: async () => ({ data: fake.row, error: fake.selectError }),
                    }),
                };
            },
        }),
        functions: {
            invoke: async (name: string, options: { body: unknown }) => {
                fake.lastInvoke = { name, body: options.body };
                return fake.invokeResult;
            },
        },
    }),
}));

const DOC = 'doc-analysis-test';

const readyRow = {
    document_id: DOC,
    status: 'ready',
    error: null,
    progress: null,
    engine_version: 'audiveris-test',
    bpm_default: 96,
    score: JSON.parse(JSON.stringify(tinyScore)) as unknown,
    created_by: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
};

beforeEach(async () => {
    fake.row = null;
    fake.selectError = null;
    fake.lastSelect = null;
    fake.invokeResult = { data: { ok: true }, error: null };
    fake.lastInvoke = null;
    await getDb().scoreCache.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchScoreAnalysisStatus', () => {
    it('selects lifecycle columns only (never the jsonb) and maps the row', async () => {
        fake.row = { status: 'processing', error: null, progress: 3, updated_at: '2026-08-02T10:00:00Z' };
        const status = await fetchScoreAnalysisStatus(DOC);
        expect(fake.lastSelect).toBe('status, error, progress, updated_at');
        expect(status).toEqual({ status: 'processing', error: null, progress: 3, updatedAt: '2026-08-02T10:00:00Z' });
    });

    it('returns null when no analysis exists', async () => {
        expect(await fetchScoreAnalysisStatus(DOC)).toBeNull();
    });
});

describe('fetchScoreAnalysisFull', () => {
    it('validates the score, caches it, and preserves a bpm override', async () => {
        await getDb().scoreCache.put({
            docId: DOC,
            status: 'processing',
            error: null,
            score: null,
            engineVersion: null,
            bpmDefault: null,
            bpmOverride: 72,
            fetchedAt: '2026-07-01T00:00:00Z',
        });
        fake.row = readyRow;
        const cached = await fetchScoreAnalysisFull(DOC);
        expect(cached?.status).toBe('ready');
        expect(cached?.score).toEqual(tinyScore);
        expect(cached?.bpmOverride).toBe(72);
        expect((await getDb().scoreCache.get(DOC))?.status).toBe('ready');
    });

    it('nulls out a malformed score payload instead of crashing', async () => {
        fake.row = { ...readyRow, score: { garbage: true } };
        const cached = await fetchScoreAnalysisFull(DOC);
        expect(cached?.status).toBe('ready');
        expect(cached?.score).toBeNull();
    });
});

describe('requestScoreAnalysis', () => {
    it('posts the document id and reports success', async () => {
        expect(await requestScoreAnalysis(DOC)).toEqual({ ok: true });
        expect(fake.lastInvoke).toEqual({ name: 'score-analyze', body: { documentId: DOC } });
    });

    it('extracts the machine code from a non-2xx function response', async () => {
        fake.invokeResult = {
            data: null,
            error: {
                message: 'Edge returned 409',
                context: new Response(JSON.stringify({ ok: false, code: 'already_running' }), { status: 409 }),
            },
        };
        expect(await requestScoreAnalysis(DOC)).toEqual({ ok: false, code: 'already_running' });
    });

    it('falls back to service_unreachable without a parseable body', async () => {
        fake.invokeResult = { data: null, error: { message: 'network down' } };
        expect(await requestScoreAnalysis(DOC)).toEqual({ ok: false, code: 'service_unreachable' });
    });
});

/**
 * The regenerate offer must never be a paid no-op: it may only appear when the
 * DEPLOYED worker would produce something newer than the row it is shown on.
 * The client's own generation regularly runs ahead of the deploy (the OMR
 * image ships from main only), and that gap must stay invisible to readers.
 */
describe('analysisIsStale', () => {
    it('does not offer a re-run the deployed worker would answer with the same row', () => {
        expect(analysisIsStale(`audiveris-5.6.1+svc-${DEPLOYED_ENGINE_GENERATION}`)).toBe(false);
    });

    it('caps the offer at the deployed generation, not the client one', () => {
        // A row the client could read better than the worker can rewrite: the
        // click would burn a metered omr_runs credit and change nothing.
        for (let generation = DEPLOYED_ENGINE_GENERATION; generation <= CURRENT_ENGINE_GENERATION; generation++) {
            expect(analysisIsStale(`audiveris-5.6.1+svc-${generation}`)).toBe(false);
        }
    });

    it('offers a re-run when the deployed worker can actually better the row', () => {
        expect(analysisIsStale(`audiveris-5.6.1+svc-${DEPLOYED_ENGINE_GENERATION - 1}`)).toBe(true);
    });

    it('treats an unstamped analysis as the oldest data there is', () => {
        expect(analysisIsStale(null)).toBe(true);
        expect(analysisIsStale('audiveris-5.6.1')).toBe(true);
    });

    it('never claims a deploy the client does not understand', () => {
        // The cap only means "worker lags client". If this fails, the constant
        // was bumped ahead of CURRENT_ENGINE_GENERATION and readers would be
        // offered re-runs whose payloads this bundle may reject wholesale.
        expect(DEPLOYED_ENGINE_GENERATION).toBeLessThanOrEqual(CURRENT_ENGINE_GENERATION);
    });

    it('does not offer an era re-run while the deployed worker is not era-aware', () => {
        expect(
            analysisIsStale('audiveris-5.6.1+svc-6', {
                era: 'baroque',
                title: 'Ballade (Chopin, Frédéric)',
            }),
        ).toBe(false);
    });

    it('offers a re-run when the title era no longer matches the stamp, once the worker is era-aware', () => {
        expect(
            analysisIsStaleAgainst('audiveris-5.11.0+svc-11', ERA_AWARE_ENGINE_GENERATION, {
                era: 'baroque',
                title: 'Ballade (Chopin, Frédéric)',
            }),
        ).toBe(true);
        expect(
            analysisIsStaleAgainst('audiveris-5.11.0+svc-11', ERA_AWARE_ENGINE_GENERATION, {
                era: 'baroque',
                title: 'Inventions (Bach, Johann Sebastian)',
            }),
        ).toBe(false);
    });

    it('does not treat a missing era stamp as stale once the generation is current', () => {
        expect(
            analysisIsStaleAgainst('audiveris-5.11.0+svc-11', ERA_AWARE_ENGINE_GENERATION, {
                title: 'Ballade (Chopin, Frédéric)',
            }),
        ).toBe(false);
    });
});

describe('helpers', () => {
    it('isProcessingStale flags rows older than 20 minutes', () => {
        expect(isProcessingStale(new Date(Date.now() - 21 * 60_000).toISOString())).toBe(true);
        expect(isProcessingStale(new Date(Date.now() - 60_000).toISOString())).toBe(false);
    });

    it('saveBpmOverride persists onto an existing cache row', async () => {
        fake.row = readyRow;
        await fetchScoreAnalysisFull(DOC);
        await saveBpmOverride(DOC, 84);
        expect((await getDb().scoreCache.get(DOC))?.bpmOverride).toBe(84);
    });
});
