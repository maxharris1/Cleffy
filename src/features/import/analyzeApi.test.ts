import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { segmentPage } from '@/features/import/segmentation';
import { INK_BLUE, makeRaster, paintRect } from '@/test/rasterFixtures';

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            getSession: () => Promise.resolve({ data: { session: { access_token: 'test-token' } } }),
        },
    }),
}));

// jsdom canvases can't encode JPEGs — stub the encoders (their own logic is canvas glue).
vi.mock('@/features/import/pageRaster', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
        ...original,
        encodePageJpeg: vi.fn(async () => ({ mediaType: 'image/jpeg' as const, dataBase64: 'cGFnZQ==' })),
        encodeCropJpeg: vi.fn(async () => ({ mediaType: 'image/jpeg' as const, dataBase64: 'Y3JvcA==' })),
    };
});

import { makeCloudClassifyFn } from '@/features/import/analyzeApi';

const DOC = 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1';

const makeSeg = () => {
    const raster = makeRaster(512, 256);
    for (let d = 0; d < 3; d++) {
        paintRect(raster, 100 + d * 18, 30, 10, 14, INK_BLUE);
    }
    const seg = segmentPage(raster, 4);
    return { seg, raster };
};

const fetchMock = vi.fn();

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('makeCloudClassifyFn', () => {
    it('sends normalized bboxes, crops, and run groupings; returns parsed labels', async () => {
        const { seg, raster } = makeSeg();
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    ok: true,
                    page: 4,
                    clusters: seg.clusters.map((c) => ({
                        id: c.id,
                        kind: 'digit',
                        text: '3',
                        confidence: 'high',
                    })),
                    runs: [{ id: seg.clusters[0]?.runId ?? '', treatAsOneText: false }],
                }),
                { status: 200 },
            ),
        );

        const result = await makeCloudClassifyFn(DOC)(seg, raster);
        expect(result).not.toBeNull();
        expect(result?.clusters).toHaveLength(3);
        expect(result?.clusters[0]?.kind).toBe('digit');

        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(String(url)).toContain('/functions/v1/analyze-annotations');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.documentId).toBe(DOC);
        expect(body.page).toBe(4);
        expect(body.clusters).toHaveLength(3);
        const bbox = body.clusters[0].bbox as number[];
        expect(bbox.every((v) => v >= 0 && v <= 1)).toBe(true);
        expect(body.clusters[0].crop.dataBase64).toBe('Y3JvcA==');
        expect(body.runs).toHaveLength(1);
        expect(body.runs[0].clusterIds).toHaveLength(3);
        expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-token' });
    });

    it('degrades to null on HTTP errors (ai_unavailable / 429 / 403)', async () => {
        const { seg, raster } = makeSeg();
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ error: 'down', code: 'ai_unavailable' }), { status: 502 }),
        );
        expect(await makeCloudClassifyFn(DOC)(seg, raster)).toBeNull();
    });

    it('degrades to null on malformed response bodies', async () => {
        const { seg, raster } = makeSeg();
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, nonsense: 1 }), { status: 200 }));
        expect(await makeCloudClassifyFn(DOC)(seg, raster)).toBeNull();
    });

    it('degrades to null on network failure', async () => {
        const { seg, raster } = makeSeg();
        fetchMock.mockRejectedValue(new TypeError('network down'));
        expect(await makeCloudClassifyFn(DOC)(seg, raster)).toBeNull();
    });

    it('rethrows aborts so a cancelled scan stops immediately', async () => {
        const { seg, raster } = makeSeg();
        fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
        await expect(makeCloudClassifyFn(DOC)(seg, raster)).rejects.toThrow('aborted');
    });
});
