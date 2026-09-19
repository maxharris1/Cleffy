import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            getSession: () => Promise.resolve({ data: { session: { access_token: 'test-token' } } }),
        },
    }),
    requireSupabaseConfig: () => ({ url: 'https://test.supabase.co', anonKey: 'test-anon-key' }),
}));

import { groupFromHands, HANDS } from '@/features/viewer/ink/handwriting/recognizer/fixtures';
import { makeTranscribeInkFn } from '@/features/viewer/ink/handwriting/transcribeApi';

const DOC = 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1';
const IMAGE = { mediaType: 'image/jpeg' as const, dataBase64: 'aW5r' };
const line = () => groupFromHands([HANDS.m!, HANDS.spiral!]);

describe('makeTranscribeInkFn', () => {
    it('posts the rendered ink crop with the document and page, and returns the text', async () => {
        const render = vi.fn(async () => IMAGE);
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, page: 0, text: 'use wrist' })));
        const transcribe = makeTranscribeInkFn(DOC, { render, fetchImpl, isOnline: () => true });

        expect(await transcribe(line())).toBe('use wrist');
        expect(render).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://test.supabase.co/functions/v1/transcribe-ink');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
        expect(JSON.parse(init.body as string)).toEqual({ documentId: DOC, page: 0, image: IMAGE });
    });

    it('offline: never renders or calls the network — the ink stays', async () => {
        const render = vi.fn(async () => IMAGE);
        const fetchImpl = vi.fn();
        const transcribe = makeTranscribeInkFn(DOC, { render, fetchImpl, isOnline: () => false });
        expect(await transcribe(line())).toBeNull();
        expect(render).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('resolves null when the model abstained, the call failed, or the body is malformed', async () => {
        const render = vi.fn(async () => IMAGE);
        const cases = [
            new Response(JSON.stringify({ ok: true, page: 0, text: null })),
            new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 }),
            new Response(JSON.stringify({ error: 'Transcription unavailable', code: 'ai_unavailable' }), {
                status: 502,
            }),
            new Response(JSON.stringify({ ok: true, page: 0 })),
        ];
        for (const response of cases) {
            const transcribe = makeTranscribeInkFn(DOC, {
                render,
                fetchImpl: vi.fn(async () => response),
                isOnline: () => true,
            });
            expect(await transcribe(line())).toBeNull();
        }
    });

    it('resolves null (not a throw) when rendering or fetching blows up', async () => {
        const boom = makeTranscribeInkFn(DOC, {
            render: vi.fn(async () => {
                throw new Error('no canvas');
            }),
            fetchImpl: vi.fn(),
            isOnline: () => true,
        });
        expect(await boom(line())).toBeNull();
        const offlineMidway = makeTranscribeInkFn(DOC, {
            render: vi.fn(async () => IMAGE),
            fetchImpl: vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            }),
            isOnline: () => true,
        });
        expect(await offlineMidway(line())).toBeNull();
    });
});
