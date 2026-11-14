import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureAttribution = vi.hoisted(() => vi.fn());
const registerServiceWorker = vi.hoisted(() => vi.fn());

vi.mock('@/lib/attribution', () => ({ captureAttribution }));
vi.mock('@/lib/serviceWorker', () => ({ registerServiceWorker }));
vi.mock('@/lib/webEvents', () => ({ installWebEvents: vi.fn() }));
vi.mock('@/lib/monitoring', () => ({
    monitoringEnabled: () => false,
    monitoringUserIdOf: () => null,
    setMonitoringUser: vi.fn(),
    startMonitoring: vi.fn(),
}));
vi.mock('@/app/App', () => ({ App: () => null }));
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: vi.fn() }) } }));

describe('boot on a share link', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '<div id="root"></div>';
    });

    afterEach(() => {
        window.history.replaceState(null, '', '/');
        vi.clearAllMocks();
    });

    it.each(['/s', '/join/abcdefghijklmnopqrstuv'])(
        'captures no campaign tags and registers no service worker on %s',
        async (path) => {
            window.history.replaceState(null, '', path);
            await import('@/main');
            expect(captureAttribution).not.toHaveBeenCalled();
            expect(registerServiceWorker).not.toHaveBeenCalled();
        },
    );

    it('does both everywhere else', async () => {
        window.history.replaceState(null, '', '/library');
        await import('@/main');
        expect(captureAttribution).toHaveBeenCalledTimes(1);
        expect(registerServiceWorker).toHaveBeenCalledTimes(1);
    });
});
