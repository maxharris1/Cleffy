// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFlash } from '@/lib/useFlash';

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
