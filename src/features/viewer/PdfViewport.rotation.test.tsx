import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDocumentLayout, SM_BREAKPOINT } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';

const PAGE_SIZES = Array.from({ length: 6 }, () => ({ width: 792, height: 612 }));

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

const viewport = { width: 390, height: 620 };
const resizeCallbacks: ResizeObserverCallback[] = [];

const resizeTo = (width: number, height: number) => {
    viewport.width = width;
    viewport.height = height;
    act(() => {
        for (const cb of resizeCallbacks) {
            cb([], {} as ResizeObserver);
        }
    });
};

const expectPageInScoreArea = (index: number) => {
    const { view } = useViewerStore.getState();
    const page = computeDocumentLayout(PAGE_SIZES, viewport.width < SM_BREAKPOINT ? 1 : 2, false).layouts[index]!;
    const top = page.top * view.scale - view.scrollY;
    const bottom = (page.top + page.height) * view.scale - view.scrollY;
    expect(bottom).toBeGreaterThan(0);
    expect(top).toBeLessThan(viewport.height);
};

beforeEach(() => {
    viewport.width = 390;
    viewport.height = 620;
    resizeCallbacks.length = 0;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(cb: ResizeObserverCallback) {
                resizeCallbacks.push(cb);
            }
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewport.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...viewport }),
    );
    useViewerStore.setState({ pageColumns: 2, spreadCover: false });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('PdfViewport rotating a phone into two pages', () => {
    it('keeps the page being read in the score area', async () => {
        render(<PdfViewport docId="doc-rotate-two-pages" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => expect(screen.getByText(/^p\. \d+ \/ 6$/)).toHaveTextContent('p. 2 / 6'));

        resizeTo(844, 320);

        await waitFor(() => expectPageInScoreArea(1));
    });

    it('keeps the page being read in the score area rotating back to one page', async () => {
        viewport.width = 844;
        viewport.height = 320;
        render(<PdfViewport docId="doc-rotate-one-page" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => expectPageInScoreArea(4));

        resizeTo(390, 620);

        await waitFor(() => expectPageInScoreArea(4));
    });
});
