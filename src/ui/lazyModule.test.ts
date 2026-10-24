import { describe, expect, it, vi } from 'vitest';

import { lazyModule } from '@/ui/lazyModule';

describe('lazyModule', () => {
    it('imports once, and is readable synchronously once loaded', async () => {
        const module = { value: 1 };
        const importModule = vi.fn(() => Promise.resolve(module));
        const lazy = lazyModule(importModule);
        expect(lazy.get()).toBeNull();
        expect(importModule).not.toHaveBeenCalled();

        const first = lazy.load();
        const second = lazy.load();
        expect(await first).toBe(module);
        expect(await second).toBe(module);
        expect(importModule).toHaveBeenCalledTimes(1);
        expect(lazy.get()).toBe(module);
    });

    it('tells subscribers when the module arrives', async () => {
        const lazy = lazyModule(() => Promise.resolve('loaded'));
        const listener = vi.fn();
        const unsubscribe = lazy.subscribe(listener);
        const other = vi.fn();
        lazy.subscribe(other)();
        await lazy.load();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('tries a failed import again on the next load', async () => {
        const importModule = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
            .mockResolvedValueOnce('loaded');
        const lazy = lazyModule(importModule);
        await expect(lazy.load()).rejects.toThrow('Failed to fetch');
        expect(lazy.get()).toBeNull();
        expect(await lazy.load()).toBe('loaded');
        expect(importModule).toHaveBeenCalledTimes(2);
    });

    it('drops a failed prefetch, and skips one once loaded', async () => {
        const importModule = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue('loaded');
        const lazy = lazyModule(importModule);
        lazy.prefetch();
        expect(importModule).toHaveBeenCalledTimes(1);
        // Dropped, not an unhandled rejection; the next prefetch tries again.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(lazy.get()).toBeNull();
        lazy.prefetch();
        await vi.waitFor(() => expect(lazy.get()).toBe('loaded'));
        lazy.prefetch();
        expect(importModule).toHaveBeenCalledTimes(2);
    });
});
