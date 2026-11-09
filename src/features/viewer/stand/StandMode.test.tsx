import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeDocumentLayout, focusedPageIndex, pageFitView } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { exitStandMode } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

// Pages are laid out, never drawn: the viewer's geometry is what is under test.
vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({
    PageView: ({ pageIndex }: { pageIndex: number }) => <div data-testid="page" data-page={pageIndex} />,
}));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => <div data-testid="annotation-toolbar" /> }));

const VIEWPORT = { width: 800, height: 600 };
const LAYOUT = computeDocumentLayout(PAGE_SIZES, 1, false);

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
    useViewerStore.getState().setTool('pen');
    useViewerStore.getState().setFingerDraws(false);
});

afterEach(() => {
    exitStandMode();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const renderViewer = async ({ readOnly = false } = {}) => {
    let store: AnnotationStore | null = null;
    render(
        <>
            <StandModeButton />
            <PdfViewport docId="doc-stand" readOnly={readOnly} onStoreReady={(s) => (store = s)} />
        </>,
    );
    await waitFor(() => expect(store).not.toBeNull());
    // Fitted to the width: page 1 at the top.
    await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
};

const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
const surface = () => document.querySelector<HTMLElement>('.ink-surface')!;
const shownPage = () => Number(screen.getByTestId('page').dataset.page);
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init });

/** A pointer on the score, at viewport px (x, y). */
const pointer = (type: string, pointerType: string, x: number, y = 300, pointerId = 1) =>
    act(() => {
        surface().dispatchEvent(
            new PointerEvent(type, { pointerId, pointerType, clientX: x, clientY: y, bubbles: true }),
        );
    });
const tap = (pointerType: string, x: number) => {
    pointer('pointerdown', pointerType, x);
    pointer('pointerup', pointerType, x);
};

describe('stand mode', () => {
    it('hides the viewer chrome and shows one whole page, centred', async () => {
        await renderViewer();
        expect(screen.getByTestId('annotation-toolbar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
        expect(screen.getByText('p. 1 / 3')).toBeInTheDocument();

        enter();
        expect(useViewerStore.getState().standMode).toBe(true);
        expect(screen.queryByTestId('annotation-toolbar')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
        expect(screen.queryByText('p. 1 / 3')).not.toBeInTheDocument();
        // The fallback overlay: fixed over the whole window, 100dvh tall.
        expect(surface()).toHaveAttribute('data-stand-mode');
        expect(surface()).toHaveClass(
            'data-stand-mode:fixed',
            'data-stand-mode:inset-x-0',
            'data-stand-mode:top-0',
            'data-stand-mode:h-dvh',
        );
        await waitFor(() =>
            expect(useViewerStore.getState().view).toEqual(pageFitView(LAYOUT, 0, VIEWPORT.width, VIEWPORT.height)),
        );
        expect(screen.getAllByTestId('page')).toHaveLength(1);
    });

    it('turns pages with the pedal keys, without wrapping at either end', async () => {
        await renderViewer();
        enter();
        expect(shownPage()).toBe(0);
        key('ArrowLeft');
        key('PageUp');
        expect(shownPage()).toBe(0);
        key('ArrowRight');
        expect(shownPage()).toBe(1);
        key(' ');
        expect(shownPage()).toBe(2);
        key('PageDown');
        key('ArrowRight');
        expect(shownPage()).toBe(2);
        key(' ', { shiftKey: true });
        expect(shownPage()).toBe(1);
        key('PageUp');
        expect(shownPage()).toBe(0);
        await waitFor(() =>
            expect(useViewerStore.getState().view).toEqual(pageFitView(LAYOUT, 0, VIEWPORT.width, VIEWPORT.height)),
        );
    });

    it('turns on a tap at either side and brings the controls up in the middle', async () => {
        await renderViewer();
        enter();
        // Up for a moment on entering, so the way out is on screen.
        expect(screen.getByRole('toolbar', { name: 'Full screen controls' })).toBeInTheDocument();
        tap('touch', 400);
        expect(screen.queryByRole('toolbar', { name: 'Full screen controls' })).not.toBeInTheDocument();

        tap('touch', VIEWPORT.width * 0.8);
        expect(shownPage()).toBe(1);
        tap('mouse', VIEWPORT.width * 0.9);
        expect(shownPage()).toBe(2);
        tap('touch', VIEWPORT.width * 0.1);
        expect(shownPage()).toBe(1);
        expect(screen.queryByRole('toolbar', { name: 'Full screen controls' })).not.toBeInTheDocument();

        tap('touch', 400);
        expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
        expect(screen.getByText('Page 3 / 3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(shownPage()).toBe(1);
    });

    it('takes the controls away after about three seconds', async () => {
        await renderViewer();
        vi.useFakeTimers();
        enter();
        expect(screen.getByRole('toolbar', { name: 'Full screen controls' })).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(2900));
        expect(screen.getByRole('toolbar', { name: 'Full screen controls' })).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(200));
        expect(screen.queryByRole('toolbar', { name: 'Full screen controls' })).not.toBeInTheDocument();
    });

    it('turns on a finger tap even with finger drawing on: on the stand a finger turns pages', async () => {
        useViewerStore.getState().setFingerDraws(true);
        await renderViewer();
        enter();
        tap('touch', VIEWPORT.width * 0.8);
        expect(shownPage()).toBe(1);
    });

    it('never turns while the pen is marking the score', async () => {
        await renderViewer();
        enter();
        // An Apple Pencil comes down on the page with the pen tool: a stroke.
        pointer('pointerdown', 'pen', 500, 300, 7);
        pointer('pointermove', 'pen', 520, 310, 7);
        key('ArrowRight');
        key(' ');
        key('PageDown');
        expect(shownPage()).toBe(0);
        // A pen tap on the right of the page is a mark, not a turn. (The
        // page, fitted whole, spans x 180-619 here.)
        pointer('pointerup', 'pen', 520, 310, 7);
        tap('pen', 600);
        expect(shownPage()).toBe(0);
        // The pen lifted: the pedal works again.
        key('ArrowRight');
        expect(shownPage()).toBe(1);
    });

    it('leaves on Escape and on the Exit control', async () => {
        await renderViewer();
        enter();
        key('Escape');
        expect(useViewerStore.getState().standMode).toBe(false);
        expect(screen.getByTestId('annotation-toolbar')).toBeInTheDocument();
        expect(surface()).not.toHaveAttribute('data-stand-mode');

        enter();
        fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
        expect(useViewerStore.getState().standMode).toBe(false);
    });

    it('comes back to the page it was showing', async () => {
        await renderViewer();
        enter();
        key('ArrowRight');
        key('ArrowRight');
        key('Escape');
        await waitFor(() =>
            expect(focusedPageIndex(useViewerStore.getState().view, VIEWPORT.height, LAYOUT.layouts)).toBe(2),
        );
    });

    it('comes back to exactly where the reader was when the page never changed', async () => {
        await renderViewer();
        // Zoomed in and panned a little down page 2.
        key('ArrowRight');
        const before = { ...useViewerStore.getState().view };
        enter();
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(before.scale));
        expect(shownPage()).toBe(1);
        key('Escape');
        await waitFor(() => expect(useViewerStore.getState().view).toEqual(before));
    });

    it('starts on the page being read', async () => {
        await renderViewer();
        key('ArrowRight');
        enter();
        expect(shownPage()).toBe(1);
    });

    it('takes the pedal even though the header button that entered it still had focus', async () => {
        await renderViewer();
        const button = screen.getByRole('button', { name: 'Full screen' });
        button.focus();
        fireEvent.click(button);
        expect(document.activeElement).not.toBe(button);
        fireEvent.keyDown(button, { key: 'ArrowRight' });
        expect(shownPage()).toBe(1);
    });

    it('holds a screen wake lock while on and lets it go on leaving', async () => {
        const release = vi.fn(() => Promise.resolve());
        const request = vi.fn(() => Promise.resolve({ released: false, release }));
        vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { wakeLock: { request } }));
        await renderViewer();
        enter();
        expect(request).toHaveBeenCalledWith('screen');
        await act(async () => {
            await Promise.resolve();
        });
        key('Escape');
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('works the same for a view-only member (a student on a teacher’s score)', async () => {
        await renderViewer({ readOnly: true });
        enter();
        expect(useViewerStore.getState().standMode).toBe(true);
        tap('pen', 600);
        expect(shownPage()).toBe(1);
        key('ArrowRight');
        expect(shownPage()).toBe(2);
        key('Escape');
        expect(useViewerStore.getState().standMode).toBe(false);
    });

    it('ends when the viewer goes away', async () => {
        await renderViewer();
        enter();
        cleanup();
        expect(useViewerStore.getState().standMode).toBe(false);
    });
});
