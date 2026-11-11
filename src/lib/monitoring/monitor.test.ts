import { describe, expect, it, vi } from 'vitest';

import { createMonitor, NOOP_MONITOR, type MonitorClient } from '@/lib/monitoring/monitor';

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const fakeClient = () => ({
    captureException: vi.fn<MonitorClient['captureException']>(),
    setUserId: vi.fn<MonitorClient['setUserId']>(),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createMonitor', () => {
    it('queues reports made before the SDK loads and replays them in order', async () => {
        const gate = deferred<MonitorClient>();
        const client = fakeClient();
        const monitor = createMonitor({ load: () => gate.promise });

        monitor.start();
        const first = new Error('first');
        monitor.report(first, { tags: { source: 'test' } });
        monitor.setUserId('user-1');
        expect(client.captureException).not.toHaveBeenCalled();

        gate.resolve(client);
        await flush();
        expect(client.captureException).toHaveBeenCalledWith(first, { tags: { source: 'test' } });
        expect(client.setUserId).toHaveBeenCalledWith('user-1');

        const second = new Error('second');
        monitor.report(second);
        expect(client.captureException).toHaveBeenLastCalledWith(second, undefined);
    });

    it('loads the SDK once however often start is called', () => {
        const load = vi.fn(() => new Promise<MonitorClient>(() => undefined));
        const monitor = createMonitor({ load });
        monitor.start();
        monitor.start();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('catches window errors and rejections while loading, then hands over to the SDK', async () => {
        const gate = deferred<MonitorClient>();
        const client = fakeClient();
        const target = new EventTarget();
        const monitor = createMonitor({ load: () => gate.promise, target: target as unknown as Window });
        monitor.start();

        const boom = new Error('boom');
        target.dispatchEvent(Object.assign(new Event('error'), { error: boom }));
        target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'nope' }));

        gate.resolve(client);
        await flush();
        expect(client.captureException).toHaveBeenCalledWith(boom, { tags: { source: 'window.error' } });
        expect(client.captureException).toHaveBeenCalledWith('nope', { tags: { source: 'unhandledrejection' } });

        // Sentry's own global handlers own these from here on: no double report.
        client.captureException.mockClear();
        target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('later') }));
        expect(client.captureException).not.toHaveBeenCalled();
    });

    it('bounds the queue, keeping the newest reports', async () => {
        const gate = deferred<MonitorClient>();
        const client = fakeClient();
        const monitor = createMonitor({ load: () => gate.promise, maxQueued: 2 });
        monitor.start();
        monitor.report('a');
        monitor.report('b');
        monitor.report('c');
        gate.resolve(client);
        await flush();
        expect(client.captureException.mock.calls.map(([error]) => error)).toEqual(['b', 'c']);
    });

    it('goes quietly off when the SDK cannot be loaded', async () => {
        const monitor = createMonitor({ load: () => Promise.reject(new Error('blocked by an ad blocker')) });
        monitor.start();
        await flush();
        expect(() => monitor.report(new Error('after'))).not.toThrow();
    });
});

describe('NOOP_MONITOR', () => {
    it('is disabled and inert', () => {
        expect(NOOP_MONITOR.enabled).toBe(false);
        expect(() => {
            NOOP_MONITOR.start();
            NOOP_MONITOR.report(new Error('x'));
            NOOP_MONITOR.setUserId('u');
        }).not.toThrow();
    });
});

describe('the app monitor without a DSN', () => {
    it('is compiled to the no-op', async () => {
        // The test build, like any build without VITE_SENTRY_DSN, defines it as ''.
        expect(__SENTRY_DSN__).toBe('');
        const { monitoringEnabled, reportError } = await import('@/lib/monitoring');
        expect(monitoringEnabled()).toBe(false);
        expect(() => reportError(new Error('x'))).not.toThrow();
    });
});
