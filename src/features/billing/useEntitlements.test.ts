import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEntitlements } from '@/features/billing/useEntitlements';
import type { Entitlements } from '@/types/database';

const readCachedEntitlements = vi.fn();
const loadEntitlements = vi.fn();
const fetchLibraryBootstrap = vi.fn();

vi.mock('@/features/billing/entitlementsService', () => ({
    readCachedEntitlements: (...args: unknown[]) => readCachedEntitlements(...args),
    loadEntitlements: (...args: unknown[]) => loadEntitlements(...args),
}));

vi.mock('@/features/library/libraryBootstrap', () => ({
    fetchLibraryBootstrap: (...args: unknown[]) => fetchLibraryBootstrap(...args),
}));

const entitlements = (tier: Entitlements['tier']): Entitlements => ({
    user_id: 'teacher-1',
    tier,
    status: null,
    source: 'none',
    current_period_end: null,
    limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 0 },
});

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

/** Records the order in which the hook reached for its two sources. */
const order: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    readCachedEntitlements.mockImplementation(async () => {
        order.push('cache');
        return null;
    });
    loadEntitlements.mockImplementation(async () => {
        order.push('server');
        return entitlements('free');
    });
    fetchLibraryBootstrap.mockImplementation(async () => {
        order.push('bootstrap');
        return { entitlements: entitlements('teacher') };
    });
});

describe('useEntitlements', () => {
    it('dispatches the server request before waiting on the cache read', async () => {
        const { result } = renderHook(() => useEntitlements('teacher-1'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(order).toEqual(['server', 'cache']);
        expect(result.current.entitlements?.tier).toBe('free');
    });

    it('dispatches the bootstrap before the cache read when the library shell asks', async () => {
        const { result } = renderHook(() => useEntitlements('teacher-1', { viaLibraryBootstrap: true }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(order).toEqual(['bootstrap', 'cache']);
        expect(result.current.entitlements?.tier).toBe('teacher');
        expect(loadEntitlements).not.toHaveBeenCalled();
    });

    it('does not paint a cached plan over a fresh one that arrived first', async () => {
        const cacheRead = deferred<Entitlements>();
        readCachedEntitlements.mockReturnValue(cacheRead.promise);
        const { result } = renderHook(() => useEntitlements('teacher-1'));

        await waitFor(() => expect(result.current.entitlements?.tier).toBe('free'));
        cacheRead.resolve(entitlements('academy'));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.entitlements?.tier).toBe('free');
    });

    it('paints the cached plan while the server is still out, then the fresh one', async () => {
        const server = deferred<Entitlements>();
        loadEntitlements.mockReturnValue(server.promise);
        readCachedEntitlements.mockResolvedValue(entitlements('teacher'));
        const { result } = renderHook(() => useEntitlements('teacher-1'));

        await waitFor(() => expect(result.current.entitlements?.tier).toBe('teacher'));
        server.resolve(entitlements('free'));
        await waitFor(() => expect(result.current.entitlements?.tier).toBe('free'));
    });

    it('falls back to the lean RPC when the bootstrap fails', async () => {
        fetchLibraryBootstrap.mockRejectedValue(new Error('rpc missing'));
        const { result } = renderHook(() => useEntitlements('teacher-1', { viaLibraryBootstrap: true }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.entitlements?.tier).toBe('free');
        expect(loadEntitlements).toHaveBeenCalledWith('teacher-1');
    });
});
