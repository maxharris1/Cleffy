import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { clampScroll, computeDocumentLayout, pageFitView } from '@/features/viewer/geometry';
import { PdfViewport, type PlaybackFeature } from '@/features/viewer/PdfViewport';
import { exitStandMode } from '@/features/viewer/stand/standMode';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({
    PageView: ({ pageIndex }: { pageIndex: number }) => <div data-testid="page" data-page={pageIndex} />,
}));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

/**
 * A tall phone: the page, fitted whole, sits in the middle with room above
 * and below — a view the ordinary scroll bounds (page 1 pinned to the top)
 * do not allow.
 */
const PHONE = { width: 390, height: 844 };
const LAYOUT = computeDocumentLayout(PAGE_SIZES, 1, false);
/** Measure 5 opens system 2, at the top of page 2. */
const PAGE_2_TICK = 8160;

const standView = (page: number) => pageFitView(LAYOUT, page, PHONE.width, PHONE.height)!;

beforeEach(() => {
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
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
    useViewerStore.getState().setTool('pen');
    useViewerStore.getState().setFingerDraws(false);
});

afterEach(() => {
    exitStandMode();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useViewerStore.getState().resetPlayback();
});

/**
 * Animation frames run by hand, at a clock the test moves (well after 0: the
 * gesture controller takes touches that soon after its never-active pen as palms).
 */
const manualFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let now = 10_000;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        nextId += 1;
        frames.set(nextId, callback);
        return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames.delete(id);
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return {
        /** Move the clock on by `ms`, then run every frame requested so far. */
        advance: (ms: number) => {
            now += ms;
            act(() => {
                const due = [...frames.values()];
                frames.clear();
                for (const callback of due) {
                    callback(now);
                }
            });
        },
    };
};

const MOTION = [
    { name: 'with motion', reduced: false },
    { name: 'under reduced motion', reduced: true },
] as const;

const setMotion = (reduced: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: reduced && query.includes('reduce'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }));

const viewer = (props: { noticeInset?: number; playback?: PlaybackFeature }) => (
    <>
        <StandModeButton />
        <PdfViewport docId="doc-stand-placement" readOnly onStoreReady={storeReady} {...props} />
    </>
);
let storeReady: (store: AnnotationStore) => void = () => undefined;

const renderViewer = async (props: { noticeInset?: number; playback?: PlaybackFeature } = {}) => {
    let store: AnnotationStore | null = null;
    storeReady = (s) => (store = s);
    const result = render(viewer(props));
    await waitFor(() => expect(store).not.toBeNull());
    await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
    return { rerender: (next: typeof props) => result.rerender(viewer(next)) };
};

const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
const view = () => useViewerStore.getState().view;
const shownPage = () => Number(screen.getByTestId('page').dataset.page);
const surface = () => document.querySelector<HTMLElement>('.ink-surface')!;

const pointer = (type: string, x: number, y: number, pointerType = 'touch') =>
    act(() => {
        surface().dispatchEvent(
            new PointerEvent(type, { pointerId: 1, pointerType, clientX: x, clientY: y, button: 0, bubbles: true }),
        );
    });
const tap = (x: number, pointerType = 'touch') => {
    pointer('pointerdown', x, PHONE.height / 2, pointerType);
    pointer('pointerup', x, PHONE.height / 2, pointerType);
};

/** Let every glide that could start run to its end. */
const settleAll = (frames: ReturnType<typeof manualFrames>) => {
    for (let i = 0; i < 40; i++) {
        frames.advance(16);
    }
    frames.advance(10_000);
    frames.advance(0);
};

describe('stand mode keeps the page where it placed it', () => {
    it('places a page the ordinary bounds would not allow (the premise)', async () => {
        manualFrames();
        await renderViewer();
        enter();
        await waitFor(() => expect(view()).toEqual(standView(0)));
        expect(clampScroll(view(), LAYOUT, PHONE.width, PHONE.height)).not.toEqual(standView(0));
    });

    for (const { name, reduced } of MOTION) {
        describe(name, () => {
            beforeEach(() => setMotion(reduced));

            it('through taps in the middle, finger and mouse', async () => {
                const frames = manualFrames();
                await renderViewer();
                enter();
                await waitFor(() => expect(view()).toEqual(standView(0)));
                tap(PHONE.width / 2);
                settleAll(frames);
                expect(view()).toEqual(standView(0));
                tap(PHONE.width / 2, 'mouse');
                settleAll(frames);
                expect(view()).toEqual(standView(0));
            });

            it('through taps at either end that have no page to turn to', async () => {
                const frames = manualFrames();
                await renderViewer();
                enter();
                await waitFor(() => expect(view()).toEqual(standView(0)));
                tap(10);
                settleAll(frames);
                expect(shownPage()).toBe(0);
                expect(view()).toEqual(standView(0));

                tap(PHONE.width - 10);
                tap(PHONE.width - 10);
                settleAll(frames);
                expect(shownPage()).toBe(2);
                expect(view()).toEqual(standView(2));
                tap(PHONE.width - 10);
                settleAll(frames);
                expect(shownPage()).toBe(2);
                expect(view()).toEqual(standView(2));
            });

            it('through a drag that turns nothing', async () => {
                const frames = manualFrames();
                await renderViewer();
                enter();
                await waitFor(() => expect(view()).toEqual(standView(0)));
                pointer('pointerdown', 200, 400);
                pointer('pointermove', 210, 300);
                pointer('pointerup', 210, 300);
                settleAll(frames);
                expect(view()).toEqual(standView(0));
            });

            it('through a notice coming and going', async () => {
                const frames = manualFrames();
                const { rerender } = await renderViewer();
                enter();
                await waitFor(() => expect(view()).toEqual(standView(0)));
                rerender({ noticeInset: 180 });
                settleAll(frames);
                expect(view()).toEqual(standView(0));
                rerender({ noticeInset: 0 });
                settleAll(frames);
                expect(view()).toEqual(standView(0));
                tap(PHONE.width / 2);
                settleAll(frames);
                expect(view()).toEqual(standView(0));
            });

            it('while play-along follows the music onto the next page', async () => {
                const frames = manualFrames();
                const tick = { current: 0 };
                await renderViewer({
                    playback: {
                        score: tinyScore,
                        getEngine: () => ({ getPositionTicks: () => tick.current }) as unknown as PlaybackEngine,
                    },
                });
                frames.advance(0);
                act(() => useViewerStore.getState().setPlaybackStatus('playing'));
                enter();
                await waitFor(() => expect(view()).toEqual(standView(0)));
                expect(useViewerStore.getState().followMode).toBe('on');

                // Through the measures of page 1, then across onto page 2.
                for (const t of [500, 4400, 6300, PAGE_2_TICK, 9700, 12500]) {
                    tick.current = t;
                    settleAll(frames);
                    expect(shownPage()).toBe(0);
                    expect(view()).toEqual(standView(0));
                }
                // A seek (which forces a follow) is no different.
                act(() => useViewerStore.getState().notePlayheadJump());
                settleAll(frames);
                expect(view()).toEqual(standView(0));
                // Nor is following resumed.
                act(() => useViewerStore.getState().setFollowMode('suspended'));
                act(() => useViewerStore.getState().setFollowMode('on'));
                settleAll(frames);
                expect(view()).toEqual(standView(0));
            });

            it('when a play-along follow glide was under way as stand mode began', async () => {
                const frames = manualFrames();
                const tick = { current: PAGE_2_TICK };
                await renderViewer({
                    playback: {
                        score: tinyScore,
                        getEngine: () => ({ getPositionTicks: () => tick.current }) as unknown as PlaybackEngine,
                    },
                });
                frames.advance(0);
                act(() => useViewerStore.getState().setPlaybackStatus('playing'));
                // Read elsewhere, then follow resumes: a glide toward page 2 starts.
                act(() => useViewerStore.getState().setView({ ...view(), scrollY: 0 }));
                act(() => useViewerStore.getState().setFollowMode('suspended'));
                act(() => useViewerStore.getState().setFollowMode('on'));
                frames.advance(0);
                frames.advance(16);
                enter();
                // It starts on the page being read, part way through the glide.
                const page = shownPage();
                await waitFor(() => expect(view()).toEqual(standView(page)));
                settleAll(frames);
                expect(shownPage()).toBe(page);
                expect(view()).toEqual(standView(page));
            });
        });
    }
});
