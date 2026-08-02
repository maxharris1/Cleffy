import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { useScoreAnalysis } from '@/features/playback/useScoreAnalysis';
import { getDb } from '@/sync/db';

interface FakeState {
    row: Record<string, unknown> | null;
    fail: boolean;
    invoke: { data: unknown; error: null | { message: string; context?: Response } };
}

const fake: FakeState = { row: null, fail: false, invoke: { data: { ok: true }, error: null } };

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
    getSupabase: () => ({
        from: () => ({
            select: () => ({
                eq: () => ({
                    maybeSingle: async () => {
                        if (fake.fail) {
                            return { data: null, error: { message: 'offline' } };
                        }
                        return { data: fake.row, error: null };
                    },
                }),
            }),
        }),
        functions: {
            invoke: async () => fake.invoke,
        },
    }),
}));

const DOC = 'doc-hook-test';
const now = () => new Date().toISOString();

beforeEach(async () => {
    fake.row = null;
    fake.fail = false;
    fake.invoke = { data: { ok: true }, error: null };
    await getDb().scoreCache.clear();
});

describe('useScoreAnalysis', () => {
    it('is unavailable when disabled (local docs)', () => {
        const { result } = renderHook(() => useScoreAnalysis(DOC, false));
        expect(result.current.state).toEqual({ kind: 'unavailable' });
    });

    it('reports none when no analysis row exists', async () => {
        const { result } = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(result.current.state.kind).toBe('none'));
    });

    it('delivers validated ScoreData when the row is ready', async () => {
        fake.row = {
            document_id: DOC,
            status: 'ready',
            error: null,
            progress: null,
            engine_version: 'audiveris-test',
            bpm_default: 96,
            score: JSON.parse(JSON.stringify(tinyScore)) as unknown,
            created_by: null,
            created_at: now(),
            updated_at: now(),
        };
        const { result } = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(result.current.state.kind).toBe('ready'));
        const state = result.current.state;
        if (state.kind !== 'ready') {
            throw new Error('expected ready');
        }
        expect(state.score.measures).toHaveLength(9);
        expect(state.bpmDefault).toBe(96);
    });

    it('surfaces processing progress and stale jobs', async () => {
        fake.row = { status: 'processing', error: null, progress: 4, updated_at: now() };
        const { result, unmount } = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(result.current.state).toEqual({ kind: 'processing', progress: 4 }));
        unmount();

        fake.row = {
            status: 'processing',
            error: null,
            progress: 4,
            updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        };
        const second = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(second.result.current.state).toEqual({ kind: 'failed', code: 'stale' }));
    });

    it('falls back to the Dexie cache when the network is down', async () => {
        await getDb().scoreCache.put({
            docId: DOC,
            status: 'ready',
            error: null,
            score: tinyScore,
            engineVersion: 'audiveris-test',
            bpmDefault: 90,
            bpmOverride: 60,
            fetchedAt: now(),
        });
        fake.fail = true;
        const { result } = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(result.current.state.kind).toBe('ready'));
        const state = result.current.state;
        if (state.kind !== 'ready') {
            throw new Error('expected ready');
        }
        expect(state.bpmOverride).toBe(60);
    });

    it('generate() goes pending, and failure codes surface', async () => {
        fake.invoke = {
            data: null,
            error: {
                message: '400',
                context: new Response(JSON.stringify({ ok: false, code: 'too_large' }), { status: 400 }),
            },
        };
        const { result } = renderHook(() => useScoreAnalysis(DOC, true));
        await waitFor(() => expect(result.current.state.kind).toBe('none'));
        await result.current.generate();
        await waitFor(() => expect(result.current.state).toEqual({ kind: 'failed', code: 'too_large' }));
    });
});
