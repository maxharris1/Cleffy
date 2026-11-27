import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDocumentLayout } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

const VIEWPORT = { width: 390, height: 664 };
const SAFE_BOTTOM_PX = 34;
/** The pager's 0.5rem lift above the safe area, its 46 px keys and a 2 px gap. */
const PAGER_STRIP_PX = 56;

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
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.className.includes('h-[var(--safe-bottom)]') ? SAFE_BOTTOM_PX : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT }),
    );
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('PdfViewport on a phone with a bottom safe area and no toolbar', () => {
    it('scrolls the end of the last page above the pager, which sits on the safe area', async () => {
        render(<PdfViewport docId="doc-safe-area" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        const next = screen.getByRole('button', { name: 'Next page' });
        for (let turns = 0; turns < 10 && !next.hasAttribute('disabled'); turns++) {
            act(() => fireEvent.click(next));
        }
        expect(next).toBeDisabled();
        expect(screen.getByText(/^p\. \d+ \/ 3$/)).toHaveTextContent('p. 3 / 3');

        const { scale, scrollY } = useViewerStore.getState().view;
        const last = computeDocumentLayout(PAGE_SIZES, 1, false).layouts[2]!;
        const lastPageBottom = (last.top + last.height) * scale - scrollY;
        expect(lastPageBottom).toBeLessThanOrEqual(VIEWPORT.height - SAFE_BOTTOM_PX - PAGER_STRIP_PX);
    });
});
