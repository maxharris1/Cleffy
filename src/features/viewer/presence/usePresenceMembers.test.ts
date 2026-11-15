import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PresencePeer } from '@/sync/wire';

const listDocumentMembers = vi.hoisted(() => vi.fn());
vi.mock('@/features/share/shareService', () => ({ listDocumentMembers }));

import { MEMBER_REFETCH_MIN_MS, usePresenceMembers } from './usePresenceMembers';

const peer = (userId: string, via?: 'link'): PresencePeer => ({
    userId,
    name: userId,
    color: '#000',
    page: 0,
    isAnonymous: false,
    ...(via ? { via } : {}),
});
const rows = (...ids: string[]) => ids.map((user_id) => ({ user_id }));

beforeEach(() => {
    vi.useFakeTimers();
    listDocumentMembers.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('usePresenceMembers', () => {
    it('gives viewers no list and asks nothing', async () => {
        const { result } = renderHook(() => usePresenceMembers('d', 'viewer', [peer('a')], true));
        await act(() => vi.advanceTimersByTimeAsync(MEMBER_REFETCH_MIN_MS * 2));
        expect(result.current).toBeNull();
        expect(listDocumentMembers).not.toHaveBeenCalled();
    });

    it('asks nothing with the flag off', async () => {
        renderHook(() => usePresenceMembers('d', 'owner', [peer('a')], false));
        await act(() => vi.advanceTimersByTimeAsync(MEMBER_REFETCH_MIN_MS * 2));
        expect(listDocumentMembers).not.toHaveBeenCalled();
    });

    it('loads the list for an owner, refetches once for a newcomer, throttled, and never for a link viewer', async () => {
        listDocumentMembers.mockResolvedValueOnce(rows('me', 'a')).mockResolvedValue(rows('me', 'a', 'b'));
        const { result, rerender } = renderHook(({ peers }) => usePresenceMembers('d', 'owner', peers, true), {
            initialProps: { peers: [peer('me'), peer('a')] },
        });
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect([...(result.current ?? [])].sort()).toEqual(['a', 'me']);

        rerender({ peers: [peer('me'), peer('a'), peer('v', 'link')] });
        await act(() => vi.advanceTimersByTimeAsync(MEMBER_REFETCH_MIN_MS * 2));
        expect(listDocumentMembers).toHaveBeenCalledTimes(1);

        rerender({ peers: [peer('me'), peer('a'), peer('b')] });
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(listDocumentMembers).toHaveBeenCalledTimes(2);
        expect(result.current?.has('b')).toBe(true);

        rerender({ peers: [peer('me'), peer('stranger')] });
        await act(() => vi.advanceTimersByTimeAsync(MEMBER_REFETCH_MIN_MS - 1));
        expect(listDocumentMembers).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(listDocumentMembers).toHaveBeenCalledTimes(3);
        await act(() => vi.advanceTimersByTimeAsync(MEMBER_REFETCH_MIN_MS * 4));
        expect(listDocumentMembers).toHaveBeenCalledTimes(3);
    });
});
