import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { exitStandMode } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';

const PAGE_SIZES = [
    { width: 420, height: 298 },
    { width: 420, height: 298 },
    { width: 420, height: 298 },
];

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

const VIEWPORT = { width: 430, height: 800 };

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => VIEWPORT.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEWPORT.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT }),
    );
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    exitStandMode();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('PdfViewport opening short landscape pages on a phone', () => {
    it('starts on page 1 and enters stand mode on page 1', async () => {
        render(
            <>
                <StandModeButton />
                <PdfViewport docId="doc-phone-open" readOnly />
            </>,
        );
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        expect(useViewerStore.getState().view.scrollY).toBeGreaterThan(0.5);

        expect(screen.getByText(/^p\. \d+ \/ 3$/)).toHaveTextContent('p. 1 / 3');
        expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();

        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expect(await screen.findByText(/^Page \d+ \/ 3$/)).toHaveTextContent('Page 1 / 3');
    });
});
