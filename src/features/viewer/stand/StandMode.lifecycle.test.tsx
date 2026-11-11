import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { exitStandMode, STAND_MENU_MS } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

interface PdfState {
    doc: unknown;
    pageSizes: { width: number; height: number }[];
    status: 'loading' | 'ready' | 'error';
    error: string | null;
}

/** What the PDF provider reports; a test moves it from loading to ready or failed. */
const pdf = vi.hoisted(() => ({ current: null as unknown as PdfState }));

vi.mock('@/features/viewer/pdf/pdfContext', () => ({ usePdf: () => pdf.current }));
vi.mock('@/features/viewer/pdf/PageView', () => ({
    PageView: ({ pageIndex }: { pageIndex: number }) => <div data-testid="page" data-page={pageIndex} />,
}));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

/** An iPhone: 390 × 844, and no Fullscreen API, so stand mode is the fixed overlay. */
const PHONE = { width: 390, height: 844 };

const LOADING: PdfState = { doc: null, pageSizes: [], status: 'loading', error: null };
const FAILED: PdfState = { doc: null, pageSizes: [], status: 'error', error: 'Network error' };
const READY: PdfState = { doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null };
/** Ready, but with no document: the viewer shows the same failure. */
const NO_DOC: PdfState = { doc: null, pageSizes: [], status: 'ready', error: null };

beforeEach(() => {
    pdf.current = LOADING;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => PHONE.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => PHONE.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...PHONE }),
    );
    // iPhone Safari: no Fullscreen API at all.
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    exitStandMode();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
});

const viewer = () => (
    <>
        <StandModeButton />
        <PdfViewport docId="doc-stand-lifecycle" readOnly onStoreReady={() => undefined} />
    </>
);

const renderViewer = async () => {
    let store: AnnotationStore | null = null;
    const result = render(
        <>
            <StandModeButton />
            <PdfViewport docId="doc-stand-lifecycle" readOnly onStoreReady={(s) => (store = s)} />
        </>,
    );
    await waitFor(() => expect(store).not.toBeNull());
    return { rerender: () => result.rerender(viewer()) };
};

const surface = () => document.querySelector<HTMLElement>('.ink-surface')!;
const exitButton = () => screen.queryByRole('button', { name: 'Exit' });

/** A finger tap at viewport px (x, y). */
const tap = (x: number, y = PHONE.height / 2) =>
    act(() => {
        for (const type of ['pointerdown', 'pointerup']) {
            surface().dispatchEvent(
                new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }),
            );
        }
    });

/** Stand mode is on, as the fixed overlay over the whole window, and the way out is on screen and stays. */
const expectExitStaysUp = () => {
    expect(useViewerStore.getState().standMode).toBe(true);
    expect(surface()).toHaveAttribute('data-stand-mode');
    expect(exitButton()).toBeInTheDocument();
    // No pager over nothing.
    expect(screen.queryByText(/^Page /)).not.toBeInTheDocument();
    // Long past the controls' timeout.
    act(() => vi.advanceTimersByTime(STAND_MENU_MS * 3));
    expect(exitButton()).toBeInTheDocument();
    // A tap in the middle (which hides the controls over a score) leaves it up too.
    tap(PHONE.width / 2);
    expect(exitButton()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(STAND_MENU_MS * 3));
    expect(exitButton()).toBeInTheDocument();
    // So do taps at either side, which have no page to turn.
    tap(10);
    tap(PHONE.width - 10);
    expect(exitButton()).toBeInTheDocument();
};

/** The Exit control (a touch target, not just a key) leaves stand mode. */
const exitByTouch = () => {
    fireEvent.click(exitButton()!);
    expect(useViewerStore.getState().standMode).toBe(false);
    expect(surface()).not.toHaveAttribute('data-stand-mode');
};

describe('stand mode always offers a way out', () => {
    it('while the score is still loading', async () => {
        await renderViewer();
        expect(screen.getByText('Loading score…')).toBeInTheDocument();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expectExitStaysUp();
        exitByTouch();
    });

    it('when loading fails after stand mode was entered', async () => {
        const { rerender } = await renderViewer();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        act(() => vi.advanceTimersByTime(STAND_MENU_MS * 3));
        pdf.current = FAILED;
        rerender();
        expect(screen.getByText(/Could not open this PDF/)).toBeInTheDocument();
        expectExitStaysUp();
        exitByTouch();
    });

    it('when the score could not be opened at all', async () => {
        pdf.current = FAILED;
        await renderViewer();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expectExitStaysUp();
        exitByTouch();
    });

    it('when the provider is ready but has no document', async () => {
        pdf.current = NO_DOC;
        await renderViewer();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        expectExitStaysUp();
        exitByTouch();
    });

    it('once the score loads, behaves as stand mode over a score: controls on a middle tap, page turns at the sides', async () => {
        const { rerender } = await renderViewer();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
        act(() => vi.advanceTimersByTime(STAND_MENU_MS * 3));
        pdf.current = READY;
        rerender();
        expect(screen.getAllByTestId('page')).toHaveLength(1);
        // The middle tap toggles the controls over a score.
        if (exitButton()) {
            tap(PHONE.width / 2);
        }
        expect(exitButton()).not.toBeInTheDocument();
        tap(PHONE.width / 2);
        expect(screen.getByText('Page 1 / 3')).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(STAND_MENU_MS + 100));
        expect(exitButton()).not.toBeInTheDocument();
        tap(PHONE.width - 10);
        expect(Number(screen.getByTestId('page').dataset.page)).toBe(1);
        tap(PHONE.width / 2);
        exitByTouch();
    });
});
