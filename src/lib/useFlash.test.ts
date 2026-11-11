import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleEllipsis, useFlash } from '@/lib/useFlash';

describe('useFlash', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a value for the window, then clears it', () => {
        const { result } = renderHook(() => useFlash<string>(1500));
        act(() => result.current[1]('a'));
        expect(result.current[0]).toBe('a');
        act(() => vi.advanceTimersByTime(1499));
        expect(result.current[0]).toBe('a');
        act(() => vi.advanceTimersByTime(1));
        expect(result.current[0]).toBeNull();
    });

    it('restarts the window on a second flash instead of clearing early', () => {
        const { result } = renderHook(() => useFlash<string>(1500));
        act(() => result.current[1]('a'));
        act(() => vi.advanceTimersByTime(1000));
        act(() => result.current[1]('b'));
        act(() => vi.advanceTimersByTime(1000));
        // The first flash's timer would have cleared it by now.
        expect(result.current[0]).toBe('b');
        act(() => vi.advanceTimersByTime(500));
        expect(result.current[0]).toBeNull();
    });

    it('cancels its timer on unmount', () => {
        const { result, unmount } = renderHook(() => useFlash<string>(1500));
        act(() => result.current[1]('a'));
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('middleEllipsis', () => {
    it('keeps both ends of a long URL', () => {
        const url = 'https://cleffy.io/join/7f3a9c2e4b1d48e6a0f5c3b2d1e0f9a8';
        const short = middleEllipsis(url, 36);
        expect(short).toHaveLength(36);
        expect(short.startsWith('https://cleffy.io/')).toBe(true);
        expect(short.endsWith(url.slice(-11))).toBe(true);
        expect(short).toContain('…');
    });

    it('leaves short text alone', () => {
        expect(middleEllipsis('https://cleffy.io/j/abc', 36)).toBe('https://cleffy.io/j/abc');
    });
});
