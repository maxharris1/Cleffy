import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDelayedFlag } from '@/lib/useDelayedFlag';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('useDelayedFlag', () => {
    it('turns true only once the flag has held for the delay', () => {
        const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 600), {
            initialProps: { flag: true },
        });
        expect(result.current).toBe(false);
        act(() => vi.advanceTimersByTime(599));
        expect(result.current).toBe(false);
        act(() => vi.advanceTimersByTime(1));
        expect(result.current).toBe(true);
        rerender({ flag: false });
        expect(result.current).toBe(false);
    });

    it('never turns true for a flag that drops before the delay', () => {
        const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 600), {
            initialProps: { flag: false },
        });
        rerender({ flag: true });
        act(() => vi.advanceTimersByTime(400));
        rerender({ flag: false });
        act(() => vi.advanceTimersByTime(1000));
        expect(result.current).toBe(false);
    });

    it('starts the delay over for each new stretch of true', () => {
        const { result, rerender } = renderHook(({ flag }) => useDelayedFlag(flag, 600), {
            initialProps: { flag: true },
        });
        act(() => vi.advanceTimersByTime(600));
        expect(result.current).toBe(true);
        rerender({ flag: false });
        rerender({ flag: true });
        expect(result.current).toBe(false);
        act(() => vi.advanceTimersByTime(300));
        expect(result.current).toBe(false);
        act(() => vi.advanceTimersByTime(300));
        expect(result.current).toBe(true);
    });
});
