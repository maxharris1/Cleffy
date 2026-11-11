import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The setup file stubs this module for every other test.
vi.unmock('@/lib/idlePrefetch');

const load = async () => {
    vi.resetModules();
    return import('@/lib/idlePrefetch');
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('prefetchWhenIdle', () => {
    it('loads once the page is idle, and only once per key', async () => {
        const { prefetchWhenIdle } = await load();
        const chunk = vi.fn(() => Promise.resolve());

        prefetchWhenIdle('viewer', chunk);
        prefetchWhenIdle('viewer', chunk);
        expect(chunk).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();
        expect(chunk).toHaveBeenCalledTimes(1);
    });

    it('waits for requestIdleCallback where the browser has it', async () => {
        const idle: Array<() => void> = [];
        vi.stubGlobal('requestIdleCallback', (callback: () => void) => idle.push(callback));
        const { prefetchWhenIdle } = await load();
        const chunk = vi.fn(() => Promise.resolve());

        prefetchWhenIdle('viewer', chunk);
        await vi.runAllTimersAsync();
        expect(chunk).not.toHaveBeenCalled();

        idle.forEach((callback) => callback());
        expect(chunk).toHaveBeenCalledTimes(1);
    });

    it('fetches nothing when the browser asks to save data', async () => {
        vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
        const { prefetchWhenIdle } = await load();
        const chunk = vi.fn(() => Promise.resolve());

        prefetchWhenIdle('viewer', chunk);
        await vi.runAllTimersAsync();
        expect(chunk).not.toHaveBeenCalled();
    });

    it('swallows a failed load: the navigation retries it and reports there', async () => {
        const { prefetchWhenIdle } = await load();
        const chunk = vi.fn(() => Promise.reject(new Error('offline')));

        prefetchWhenIdle('viewer', chunk);
        await vi.runAllTimersAsync();
        expect(chunk).toHaveBeenCalledTimes(1);
    });
});
