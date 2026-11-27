import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomDock } from '@/features/viewer/bottomDock';
import { computeDocumentLayout } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';

const PAGE_SIZES = [{ width: 612, height: 792 }];

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

const VIEWPORT = { width: 390, height: 700 };
const DOCK_PX = 200;
/** The zoom row's 0.5rem lift above the dock, its 44 px keys and a 4 px gap. */
const CONTROLS_STRIP_PX = 56;

const Dock = () => <div ref={useBottomDock()} data-dock />;

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
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-dock')
            ? DOMRect.fromRect({ x: 0, y: VIEWPORT.height - DOCK_PX, width: VIEWPORT.width, height: DOCK_PX })
            : DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT });
    });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const pageBottomOnScreen = () => {
    const { scale, scrollY } = useViewerStore.getState().view;
    const page = computeDocumentLayout(PAGE_SIZES, 1, false).layouts[0]!;
    return (page.top + page.height) * scale - scrollY;
};

const scrollToEnd = (surface: Element) => {
    for (let i = 0; i < 5; i++) {
        act(() => {
            fireEvent.wheel(surface, { deltaY: 600 });
        });
    }
};

describe('PdfViewport on a phone with a bottom dock (the signed-out ink notice) over the score', () => {
    it('scrolls the end of the page above the zoom row the dock raises', async () => {
        const { container } = render(
            <>
                <PdfViewport docId="doc-dock" readOnly />
                <Dock />
            </>,
        );
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        scrollToEnd(container.querySelector('.ink-surface')!);

        expect(pageBottomOnScreen()).toBeLessThanOrEqual(VIEWPORT.height - DOCK_PX - CONTROLS_STRIP_PX);
    });

    it('frees that room once the dock goes', async () => {
        const { container, rerender } = render(
            <>
                <PdfViewport docId="doc-dock" readOnly />
                <Dock />
            </>,
        );
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        rerender(
            <>
                <PdfViewport docId="doc-dock" readOnly />
            </>,
        );

        scrollToEnd(container.querySelector('.ink-surface')!);

        expect(pageBottomOnScreen()).toBeGreaterThan(VIEWPORT.height - DOCK_PX - CONTROLS_STRIP_PX);
    });
});
