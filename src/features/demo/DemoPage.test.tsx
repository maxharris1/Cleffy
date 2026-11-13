import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoPage } from '@/features/demo/DemoPage';
import { DEMO_VISIT_SENT_KEY, resetDemoVisitForTests } from '@/features/demo/demoVisit';

const h = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('@/lib/webEvents', () => ({ track: h.track }));

// The score and the viewer never arrive: the visit is counted on arrival, not on load.
vi.mock('@/features/demo/loadDemoScore', () => ({
    DemoScoreUnavailableError: class extends Error {},
    loadDemoScore: () => new Promise<never>(() => undefined),
}));
vi.mock('@/features/demo/DemoViewer', () => ({ DemoViewer: () => null }));

const renderDemo = () =>
    render(
        <StrictMode>
            <MemoryRouter initialEntries={['/try?utm_campaign=launch_v1']}>
                <DemoPage />
            </MemoryRouter>
        </StrictMode>,
    );

beforeEach(() => {
    h.track.mockReset();
    window.sessionStorage.clear();
    resetDemoVisitForTests();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('DemoPage, the demo_visit event', () => {
    it('is sent once per tab, however often /try mounts', () => {
        renderDemo();
        cleanup();
        renderDemo();

        expect(h.track).toHaveBeenCalledTimes(1);
        expect(h.track).toHaveBeenCalledWith('demo_visit');
        expect(window.sessionStorage.getItem(DEMO_VISIT_SENT_KEY)).toBe('1');
    });

    it('is not sent again in a tab that already sent it (a reload)', () => {
        window.sessionStorage.setItem(DEMO_VISIT_SENT_KEY, '1');
        renderDemo();
        expect(h.track).not.toHaveBeenCalled();
    });

    it('is still sent once when sessionStorage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        renderDemo();
        cleanup();
        renderDemo();
        expect(h.track).toHaveBeenCalledTimes(1);
    });
});
