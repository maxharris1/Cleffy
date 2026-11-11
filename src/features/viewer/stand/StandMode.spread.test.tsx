import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDocumentLayout, focusedPageIndex, pageFitView, pageRow } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { exitStandMode } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';

const PAGE = { width: 612, height: 792 };
const PAGE_SIZES = [PAGE, PAGE, PAGE, PAGE, PAGE];

// Pages are laid out, never drawn: the viewer's geometry is what is under test.
vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({
    PageView: ({ pageIndex }: { pageIndex: number }) => <div data-testid="page" data-page={pageIndex} />,
}));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => <div data-testid="annotation-toolbar" /> }));

/** iPad landscape: wide enough for two pages side by side. */
const WIDE = { width: 1366, height: 1024 };
/** A phone held upright: the main viewer shows one page here whatever is selected. */
const PHONE = { width: 390, height: 844 };
let viewport = WIDE;
const resizeCallbacks: (() => void)[] = [];

beforeEach(() => {
    viewport = WIDE;
    resizeCallbacks.length = 0;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback: () => void) {
                resizeCallbacks.push(callback);
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
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
    useViewerStore.getState().setTool('pen');
    useViewerStore.getState().setPageColumns(2);
    useViewerStore.getState().setSpreadCover(false);
});

afterEach(() => {
    exitStandMode();
    cleanup();
    useViewerStore.getState().setPageColumns(1);
    useViewerStore.getState().setSpreadCover(false);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const renderViewer = async () => {
    let store: AnnotationStore | null = null;
    render(
        <>
            <StandModeButton />
            <PdfViewport docId="doc-stand-spread" onStoreReady={(s) => (store = s)} />
        </>,
    );
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
};

const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
const surface = () => document.querySelector<HTMLElement>('.ink-surface')!;
const shownPages = () => screen.getAllByTestId('page').map((p) => Number(p.dataset.page));
const key = (k: string) => fireEvent.keyDown(document.body, { key: k });
const tap = (x: number) =>
    act(() => {
        for (const type of ['pointerdown', 'pointerup']) {
            surface().dispatchEvent(
                new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: 400, bubbles: true }),
            );
        }
    });
const resizeTo = (size: { width: number; height: number }) =>
    act(() => {
        viewport = size;
        for (const callback of resizeCallbacks) {
            callback();
        }
    });

describe('stand mode with two pages side by side', () => {
    it('shows the spread selected in the main viewer, whole and centred', async () => {
        await renderViewer();
        enter();
        expect(shownPages()).toEqual([0, 1]);
        expect(screen.getByText('Pages 1–2 / 5')).toBeInTheDocument();
        const layout = computeDocumentLayout(PAGE_SIZES, 2, false);
        await waitFor(() =>
            expect(useViewerStore.getState().view).toEqual(pageFitView(layout, 0, WIDE.width, WIDE.height, 2)),
        );
    });

    it('stays one page at a time when one page is selected', async () => {
        useViewerStore.getState().setPageColumns(1);
        await renderViewer();
        enter();
        expect(shownPages()).toEqual([0]);
        key('ArrowRight');
        expect(shownPages()).toEqual([1]);
    });

    it('turns a whole spread on each key, tap and control, never past either end', async () => {
        await renderViewer();
        enter();
        key('ArrowLeft');
        expect(shownPages()).toEqual([0, 1]);
        key('ArrowRight');
        expect(shownPages()).toEqual([2, 3]);
        tap(WIDE.width * 0.9);
        // An odd last page sits alone.
        expect(shownPages()).toEqual([4]);
        key(' ');
        tap(WIDE.width * 0.9);
        expect(shownPages()).toEqual([4]);
        tap(WIDE.width * 0.1);
        expect(shownPages()).toEqual([2, 3]);

        // The controls are still up from entering.
        expect(screen.getByText('Pages 3–4 / 5')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(shownPages()).toEqual([0, 1]);
        expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByText('Page 5 / 5')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    });

    it('pairs 1 | 2-3 | 4-5 behind a cover', async () => {
        useViewerStore.getState().setSpreadCover(true);
        await renderViewer();
        enter();
        expect(shownPages()).toEqual([0]);
        key('ArrowRight');
        expect(shownPages()).toEqual([1, 2]);
        key('PageDown');
        expect(shownPages()).toEqual([3, 4]);
        key('ArrowRight');
        expect(shownPages()).toEqual([3, 4]);
        key('PageUp');
        expect(shownPages()).toEqual([1, 2]);
        key('ArrowLeft');
        expect(shownPages()).toEqual([0]);
        // The cover keeps its place on the right, at the spreads' zoom.
        const layout = computeDocumentLayout(PAGE_SIZES, 2, true);
        await waitFor(() =>
            expect(useViewerStore.getState().view).toEqual(pageFitView(layout, 0, WIDE.width, WIDE.height, 2)),
        );
    });

    it('starts on the spread being read', async () => {
        await renderViewer();
        key('ArrowRight');
        enter();
        expect(shownPages()).toEqual([2, 3]);
    });

    it('comes back to the spread it was showing', async () => {
        await renderViewer();
        enter();
        key('ArrowRight');
        key('Escape');
        const layout = computeDocumentLayout(PAGE_SIZES, 2, false);
        await waitFor(() => {
            const page = focusedPageIndex(useViewerStore.getState().view, WIDE.height, layout.layouts);
            expect(pageRow(layout.layouts, page).first).toBe(2);
        });
    });

    it('comes back to exactly where the reader was when the spread never changed', async () => {
        await renderViewer();
        key('ArrowRight');
        const before = { ...useViewerStore.getState().view };
        enter();
        await waitFor(() => expect(useViewerStore.getState().view).not.toEqual(before));
        key('ArrowRight');
        key('ArrowLeft');
        key('Escape');
        await waitFor(() => expect(useViewerStore.getState().view).toEqual(before));
    });

    it('keeps the reader’s page through a rotation, turning whole spreads again once they fit', async () => {
        useViewerStore.getState().setSpreadCover(true);
        await renderViewer();
        enter();
        key('ArrowRight');
        expect(shownPages()).toEqual([1, 2]);

        // Upright on a phone the main viewer shows one page: so does the stand.
        resizeTo(PHONE);
        expect(shownPages()).toEqual([1]);
        await waitFor(() =>
            expect(useViewerStore.getState().view).toEqual(
                pageFitView(computeDocumentLayout(PAGE_SIZES, 1, true), 1, PHONE.width, PHONE.height),
            ),
        );
        key('ArrowRight');
        expect(shownPages()).toEqual([2]);

        // Back to landscape: page 3 is the right half of 2-3, and the next
        // turn goes on to 4-5 rather than stranding half a spread.
        resizeTo(WIDE);
        expect(shownPages()).toEqual([1, 2]);
        key('ArrowRight');
        expect(shownPages()).toEqual([3, 4]);
        expect(useViewerStore.getState().pageColumns).toBe(2);
    });
});
