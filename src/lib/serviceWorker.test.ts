import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerServiceWorker } from '@/lib/serviceWorker';

const register = vi.fn(() => Promise.resolve({}));

const stubServiceWorker = (controller: object | null) => {
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { controller, register },
    });
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PROD', true);
    register.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('registerServiceWorker', () => {
    it('registers at once on a page the worker already controls', () => {
        stubServiceWorker({});
        registerServiceWorker();
        // jsdom's document has finished loading by the time a test runs.
        expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('holds a first visit back until the page has settled', async () => {
        stubServiceWorker(null);
        registerServiceWorker();
        expect(register).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(7000);
        expect(register).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2000);
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('waits for an idle moment where the browser offers one', async () => {
        const idle: Array<() => void> = [];
        vi.stubGlobal('requestIdleCallback', (callback: () => void) => idle.push(callback));
        stubServiceWorker(null);
        registerServiceWorker();

        await vi.advanceTimersByTimeAsync(9000);
        expect(register).not.toHaveBeenCalled();
        idle.forEach((callback) => callback());
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('does nothing outside a production build', () => {
        vi.stubEnv('PROD', false);
        stubServiceWorker({});
        registerServiceWorker();
        expect(register).not.toHaveBeenCalled();
    });

    it('does nothing in a browser without service workers', () => {
        expect(() => registerServiceWorker()).not.toThrow();
        expect(register).not.toHaveBeenCalled();
    });
});
