import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { playheadRect } from '@/features/playback/PlayheadController';
import { MIN_SCALE, PAGE_GAP, clampScroll, computeDocumentLayout } from '@/features/viewer/geometry';
import { PdfViewport, type PlaybackFeature } from '@/features/viewer/PdfViewport';
import { SyncHeldNotice, SyncRejectedNotice } from '@/features/viewer/SyncRejectedNotice';
import { ViewerNotice, ViewerNoticeRegion } from '@/features/viewer/ViewerNotice';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

// Pages are laid out, never drawn: the viewer's geometry is what is under test.
vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

/** jsdom lays nothing out: the viewport reports this size, and the notice stack these heights. */
let viewport = { width: 800, height: 600 };
/** Rendered heights (px) of one notice card and the gap between cards, phone size. */
const NOTICE_PX = 52;
const NOTICE_GAP_PX = 6;
/** The region's top on phones (top-14). */
const REGION_TOP_PX = 56;

const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            private readonly callback: () => void;
            constructor(callback: () => void) {
                this.callback = callback;
                resizeCallbacks.add(callback);
            }
            observe() {}
            unobserve() {}
            disconnect() {
                resizeCallbacks.delete(this.callback);
            }
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewport.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-viewer-notices')) {
            const cards = this.children.length;
            const height = cards === 0 ? 0 : cards * NOTICE_PX + (cards - 1) * NOTICE_GAP_PX;
            return DOMRect.fromRect({ x: 0, y: REGION_TOP_PX, width: viewport.width, height });
        }
        return DOMRect.fromRect({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useViewerStore.getState().resetPlayback();
    viewport = { width: 800, height: 600 };
});

describe('PdfViewport keyboard shortcuts under a confirmation', () => {
    /** The viewer, with a ConfirmDialog (an alertdialog) the test can open over it. */
    const ViewerWithConfirm = ({ onStore }: { onStore: (store: AnnotationStore) => void }) => {
        const [confirming, setConfirming] = useState(false);
        return (
            <>
                <button type="button" onClick={() => setConfirming(true)}>
                    Ask
                </button>
                <PdfViewport docId="doc-keys" onStoreReady={onStore} />
                {confirming ? (
                    <ConfirmDialog
                        title="Delete this page?"
                        body="It cannot be undone."
                        confirmLabel="Delete"
                        onConfirm={() => setConfirming(false)}
                        onCancel={() => setConfirming(false)}
                    />
                ) : null}
            </>
        );
    };

    const renderViewer = async () => {
        let store: AnnotationStore | null = null;
        render(<ViewerWithConfirm onStore={(s) => (store = s)} />);
        await waitFor(() => expect(store).not.toBeNull());
        const undoLast = vi.spyOn(store as unknown as AnnotationStore, 'undoLast');
        const redoLast = vi.spyOn(store as unknown as AnnotationStore, 'redoLast');
        return { undoLast, redoLast };
    };

    const scrollY = () => useViewerStore.getState().view.scrollY;

    it('turns pages and undoes with no dialog open (the control case)', async () => {
        const { undoLast } = await renderViewer();
        const start = scrollY();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        const afterArrow = scrollY();
        expect(afterArrow).toBeGreaterThan(start);
        fireEvent.keyDown(document.body, { key: ' ' });
        expect(scrollY()).toBeGreaterThan(afterArrow);
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(undoLast).toHaveBeenCalledTimes(1);
    });

    it('ignores ArrowRight, Space and Ctrl+Z while an alertdialog is open, wherever the key lands', async () => {
        const { undoLast, redoLast } = await renderViewer();
        fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
        const confirm = await screen.findByRole('alertdialog', { name: 'Delete this page?' });
        const start = scrollY();

        // In the confirm (where its focus trap keeps the keyboard) and outside
        // it (a key Base UI's trap did not catch, a pedal's synthetic event).
        for (const target of [confirm, document.body]) {
            fireEvent.keyDown(target, { key: 'ArrowRight' });
            fireEvent.keyDown(target, { key: ' ' });
            fireEvent.keyDown(target, { key: 'PageDown' });
            fireEvent.keyDown(target, { key: 'z', ctrlKey: true });
            fireEvent.keyDown(target, { key: 'z', metaKey: true });
            fireEvent.keyDown(target, { key: 'z', ctrlKey: true, shiftKey: true });
        }
        expect(scrollY()).toBe(start);
        expect(undoLast).not.toHaveBeenCalled();
        expect(redoLast).not.toHaveBeenCalled();

        // Answered, the viewer's keys work again.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(scrollY()).toBeGreaterThan(start);
    });

    it('keeps the keys off when a confirm opened over another dialog closes and the dialog stays', async () => {
        const ViewerWithNestedConfirm = ({ onStore }: { onStore: (store: AnnotationStore) => void }) => {
            const [dialog, setDialog] = useState(false);
            const [confirming, setConfirming] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setDialog(true)}>
                        Settings
                    </button>
                    <PdfViewport docId="doc-keys-nested" onStoreReady={onStore} />
                    {dialog ? (
                        <Dialog label="Score settings" onClose={() => setDialog(false)}>
                            <button type="button" onClick={() => setConfirming(true)}>
                                Remove score
                            </button>
                        </Dialog>
                    ) : null}
                    {confirming ? (
                        <ConfirmDialog
                            title="Remove this score?"
                            body="It cannot be undone."
                            confirmLabel="Remove"
                            onConfirm={() => setConfirming(false)}
                            onCancel={() => setConfirming(false)}
                        />
                    ) : null}
                </>
            );
        };
        let store: AnnotationStore | null = null;
        render(<ViewerWithNestedConfirm onStore={(s) => (store = s)} />);
        await waitFor(() => expect(store).not.toBeNull());
        const undoLast = vi.spyOn(store as unknown as AnnotationStore, 'undoLast');

        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        await screen.findByRole('dialog', { name: 'Score settings' });
        fireEvent.click(screen.getByRole('button', { name: 'Remove score' }));
        await screen.findByRole('alertdialog', { name: 'Remove this score?' });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        expect(screen.getByRole('dialog', { name: 'Score settings' })).toBeInTheDocument();

        // The confirm is gone but its parent is still open: the keys still stand down.
        const start = scrollY();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        fireEvent.keyDown(document.body, { key: ' ' });
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(scrollY()).toBe(start);
        expect(undoLast).not.toHaveBeenCalled();
    });

    it('stands the keys down on the very first open of a lazy dialog, before its chunk has loaded', async () => {
        // Fresh modules: the dialog panel's chunk has not been loaded by an
        // earlier test, so this open is a first one, as on a fresh page.
        vi.resetModules();
        const [
            { PdfViewport: ColdViewport },
            { ConfirmDialog: ColdConfirm },
            { dialogPanelModule },
            { useViewerStore: coldStore },
        ] = await Promise.all([
            import('@/features/viewer/PdfViewport'),
            import('@/ui/ConfirmDialog'),
            import('@/ui/lazyPrimitives'),
            import('@/state/store'),
        ]);
        coldStore.getState().resetView({ scale: 1, scrollY: 0, scrollX: 0 });
        expect(dialogPanelModule.get()).toBeNull();

        const ColdViewerWithConfirm = ({ onStore }: { onStore: (store: AnnotationStore) => void }) => {
            const [confirming, setConfirming] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setConfirming(true)}>
                        Ask
                    </button>
                    <ColdViewport docId="doc-keys-lazy" onStoreReady={onStore} />
                    {confirming ? (
                        <ColdConfirm
                            title="Delete this page?"
                            body="It cannot be undone."
                            confirmLabel="Delete"
                            onConfirm={() => setConfirming(false)}
                            onCancel={() => setConfirming(false)}
                        />
                    ) : null}
                </>
            );
        };
        let store: AnnotationStore | null = null;
        render(<ColdViewerWithConfirm onStore={(s) => (store = s)} />);
        await waitFor(() => expect(store).not.toBeNull());
        const undoLast = vi.spyOn(store as unknown as AnnotationStore, 'undoLast');
        const coldScrollY = () => coldStore.getState().view.scrollY;

        fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
        // Opened, but its panel is still on its way: nothing on screen yet...
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        // ...and a page-turner pedal or a shortcut pressed now does nothing.
        const start = coldScrollY();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        fireEvent.keyDown(document.body, { key: ' ' });
        fireEvent.keyDown(document.body, { key: 'PageDown' });
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(coldScrollY()).toBe(start);
        expect(undoLast).not.toHaveBeenCalled();

        // The panel arrives, and the keys stay down until it is answered.
        const confirm = await screen.findByRole('alertdialog', { name: 'Delete this page?' });
        fireEvent.keyDown(confirm, { key: 'ArrowRight' });
        expect(coldScrollY()).toBe(start);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(coldScrollY()).toBeGreaterThan(start);
    });
});

describe('PdfViewport follow under the notice stack', () => {
    const PHONE = { width: 390, height: 664 };
    /** Measure 5 opens system 2, at the top of page 2. */
    const SYSTEM_2_TICK = 8160;

    /** The viewer page's arrangement: the notice region and the viewport in one container. */
    const ViewerWithNotices = ({ tick }: { tick: { current: number } }) => {
        const [inset, setInset] = useState(0);
        return (
            <div>
                <ViewerNoticeRegion onInsetChange={setInset}>
                    <ViewerNotice>
                        <p>Your access to this score changed.</p>
                    </ViewerNotice>
                    <SyncRejectedNotice count={2} onDismiss={() => undefined} />
                    <SyncHeldNotice count={3} />
                </ViewerNoticeRegion>
                <PdfViewport
                    docId="doc-follow"
                    readOnly
                    noticeInset={inset}
                    playback={{
                        score: tinyScore,
                        getEngine: () => ({ getPositionTicks: () => tick.current }) as unknown as PlaybackEngine,
                    }}
                />
            </div>
        );
    };

    it('keeps the followed system fully visible below several notices at a phone viewport', async () => {
        viewport = PHONE;
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', () => {});
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const flushFrames = () => {
            act(() => {
                for (const callback of frames.splice(0, frames.length)) {
                    callback(now);
                }
            });
        };

        const tick = { current: 0 };
        render(<ViewerWithNotices tick={tick} />);
        // Three cards: the stack reaches 56 + 3×52 + 2×6 = 224px down a 664px phone.
        const stackBottom = REGION_TOP_PX + 3 * NOTICE_PX + 2 * NOTICE_GAP_PX;
        expect(screen.getAllByRole('status')).toHaveLength(3);

        // The opening view already starts page 1 below the stack.
        const layout = computeDocumentLayout(PAGE_SIZES, 1, false);
        const page0 = layout.layouts[0]!;
        await waitFor(() => {
            const v = useViewerStore.getState().view;
            expect(page0.top * v.scale - v.scrollY).toBeGreaterThanOrEqual(stackBottom);
        });

        /** The followed system's top and bottom in viewport px, once the glide has finished. */
        const followTo = (t: number) => {
            tick.current = t;
            act(() => useViewerStore.getState().notePlayheadJump());
            flushFrames();
            now += 10_000;
            flushFrames();
            const v = useViewerStore.getState().view;
            const rect = playheadRect(tinyScore, t)!;
            const page = layout.layouts[rect.pageIndex]!;
            return {
                top: (page.top + rect.y0 * page.height) * v.scale - v.scrollY,
                bottom: (page.top + rect.y1 * page.height) * v.scale - v.scrollY,
            };
        };

        for (const t of [0, SYSTEM_2_TICK, tinyScore.totalTicks - 1]) {
            const system = followTo(t);
            expect(system.top).toBeGreaterThanOrEqual(stackBottom);
            expect(system.bottom).toBeLessThanOrEqual(PHONE.height);
        }
    });
});

/**
 * The notice region over the viewport, as ViewerPage arranges them; the
 * rejected-changes card can be dismissed, or shown and hidden by `rejected`.
 */
const ViewerUnderNotices = ({
    readOnly = true,
    playback,
    onStore,
    rejected,
}: {
    readOnly?: boolean;
    playback?: PlaybackFeature;
    onStore?: (store: AnnotationStore) => void;
    rejected?: boolean;
}) => {
    const [inset, setInset] = useState(0);
    const [shown, setShowRejected] = useState(true);
    const showRejected = rejected ?? shown;
    return (
        <div>
            <ViewerNoticeRegion onInsetChange={setInset}>
                <ViewerNotice>
                    <p>Your access to this score changed.</p>
                </ViewerNotice>
                {showRejected ? <SyncRejectedNotice count={2} onDismiss={() => setShowRejected(false)} /> : null}
                <SyncHeldNotice count={3} />
            </ViewerNoticeRegion>
            <PdfViewport
                docId="doc-notices"
                readOnly={readOnly}
                noticeInset={inset}
                playback={playback}
                onStoreReady={onStore}
            />
        </div>
    );
};

/**
 * Animation frames run by hand, at a clock the test moves. Frames get ids,
 * and cancelling one records it, so a cancel is something a test can assert.
 */
const manualFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    let nextId = 0;
    // Well after 0: the gesture controller takes touches that soon after its
    // (never-active) pen as palms.
    let now = 10_000;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        nextId += 1;
        frames.set(nextId, callback);
        return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        cancelled.push(id);
        frames.delete(id);
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return {
        cancelled,
        pending: () => [...frames.keys()],
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

/** How far down the stack reaches with `cards` notices up (56 + cards×52 + gaps). */
const stackBottomPx = (cards: number) => REGION_TOP_PX + cards * NOTICE_PX + (cards - 1) * NOTICE_GAP_PX;

/** The region measures itself on resize, which jsdom never reports on its own. */
const reportResizes = () => {
    act(() => {
        for (const callback of [...resizeCallbacks]) {
            callback();
        }
    });
};

const view = () => useViewerStore.getState().view;

/** A pointer on the score, at viewport px (x, y). */
const pointer = (type: string, pointerId: number, pointerType: string, x: number, y: number) =>
    act(() => {
        document
            .querySelector('.ink-surface')!
            .dispatchEvent(new PointerEvent(type, { pointerId, pointerType, clientX: x, clientY: y, bubbles: true }));
    });

describe('PdfViewport page turns under a tall notice stack', () => {
    const layout = computeDocumentLayout(PAGE_SIZES, 1, false);
    const STACK = stackBottomPx(3);

    const pagerLabel = () => screen.getByText(/^p\. \d+ \/ \d+$/).textContent;
    const previous = () => screen.getByRole('button', { name: 'Previous page' });
    const next = () => screen.getByRole('button', { name: 'Next page' });

    /** Pager buttons, or a page-turner pedal's arrow keys. */
    const turners = {
        pager: (direction: -1 | 1) => fireEvent.click(direction === 1 ? next() : previous()),
        keyboard: (direction: -1 | 1) =>
            fireEvent.keyDown(document.body, { key: direction === 1 ? 'ArrowRight' : 'ArrowLeft' }),
    };

    /** Viewport px of page `i`'s top and bottom edges. */
    const pageEdges = (i: number) => {
        const v = view();
        const page = layout.layouts[i]!;
        return { top: page.top * v.scale - v.scrollY, bottom: (page.top + page.height) * v.scale - v.scrollY };
    };

    const expectPager = (page: number, canPrevious: boolean, canNext: boolean) => {
        expect(pagerLabel()).toBe(`p. ${page} / 3`);
        if (canPrevious) {
            expect(previous()).toBeEnabled();
        } else {
            expect(previous()).toBeDisabled();
        }
        if (canNext) {
            expect(next()).toBeEnabled();
        } else {
            expect(next()).toBeDisabled();
        }
    };

    const openUnderStack = async () => {
        render(<ViewerUnderNotices />);
        expect(screen.getAllByRole('status')).toHaveLength(3);
        // The first fit starts page 1 below the stack, at the top scroll bound.
        await waitFor(() => expect(view().scrollY).toBe(-STACK));
    };

    it.each(Object.entries(turners))(
        'pages forward to the last page and back at minimum zoom in a short phone viewport (%s)',
        async (_, turn) => {
            viewport = { width: 390, height: 480 };
            await openUnderStack();
            act(() => useViewerStore.getState().setView({ ...view(), scale: MIN_SCALE }));
            expectPager(1, false, true);

            // Page 1 -> 2 lands above 0 (808 × 0.25 − 224 = −22): still page 2, not page 1.
            act(() => turn(1));
            expect(view().scrollY).toBeCloseTo(-22);
            expectPager(2, true, true);

            // And on to page 3, which comes fully into view below the stack.
            act(() => turn(1));
            expectPager(3, true, false);
            expect(pageEdges(2).top).toBeGreaterThanOrEqual(STACK);
            expect(pageEdges(2).bottom).toBeLessThanOrEqual(480);
            const atEnd = view().scrollY;
            act(() => turn(1));
            expect(view().scrollY).toBe(atEnd);

            // Back the same way, to page 1 below the stack.
            act(() => turn(-1));
            expectPager(2, true, true);
            expect(pageEdges(1).top).toBeCloseTo(STACK + 16 * MIN_SCALE);
            act(() => turn(-1));
            expectPager(1, false, true);
            expect(view().scrollY).toBe(-STACK);
            act(() => turn(-1));
            expect(view().scrollY).toBe(-STACK);
        },
    );

    it.each(Object.entries(turners))(
        'pages through every page at fit width when the stack reaches past the viewport middle (%s)',
        async (_, turn) => {
            // 224 px of notices over a 400 px viewport: the middle of the whole
            // viewport is under the stack.
            viewport = { width: 390, height: 400 };
            await openUnderStack();
            expect(STACK).toBeGreaterThan(400 / 2);
            expectPager(1, false, true);

            for (const page of [2, 3]) {
                const before = view().scrollY;
                act(() => turn(1));
                expect(view().scrollY).toBeGreaterThan(before);
                // Each turn starts the next page just below the stack.
                expect(pageEdges(page - 1).top).toBeCloseTo(STACK + 16 * view().scale);
                expectPager(page, true, true);
            }
            // The rest of page 3 is still below: Next goes on to its end, then stops.
            act(() => turn(1));
            expect(pageEdges(2).bottom).toBeCloseTo(400 - 16 * view().scale);
            expectPager(3, true, false);
            for (const page of [2, 1]) {
                act(() => turn(-1));
                expect(pageEdges(page - 1).top).toBeCloseTo(STACK + 16 * view().scale);
                expectPager(page, page > 1, true);
            }
        },
    );
});

describe('PdfViewport zoomed out under a tall notice stack', () => {
    it('lets Previous bring the top of page 1 out from under notices that came up over it', async () => {
        viewport = { width: 390, height: 480 };
        render(<ViewerUnderNotices />);
        await waitFor(() => expect(view().scrollY).toBe(-stackBottomPx(3)));
        // The score was opened before the notices came up (the fit put page 1
        // below the pager strip only), then zoomed out about the viewport centre.
        act(() => useViewerStore.getState().setView({ ...view(), scrollY: -REGION_TOP_PX }));
        for (let i = 0; i < 4; i++) {
            fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
        }
        const page1Top = PAGE_GAP * view().scale - view().scrollY;
        expect(page1Top).toBeLessThan(stackBottomPx(3));
        expect(screen.getByText('p. 1 / 3')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(view().scrollY).toBe(-stackBottomPx(3));
        expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    });
});

describe('PdfViewport when a notice goes away', () => {
    const PHONE = { width: 390, height: 664 };

    const dismiss = () => {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.getAllByRole('status')).toHaveLength(2);
        reportResizes();
    };

    const openUnderStack = async () => {
        viewport = PHONE;
        render(<ViewerUnderNotices />);
        await waitFor(() => expect(view().scrollY).toBe(-stackBottomPx(3)));
    };

    it('settles the score up into the room it leaves at once under reduced motion', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
        await openUnderStack();
        dismiss();
        expect(view().scrollY).toBe(-stackBottomPx(2));
    });

    it('glides up into the room it leaves', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', () => {});
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const flushFrames = () =>
            act(() => {
                for (const callback of frames.splice(0, frames.length)) {
                    callback(now);
                }
            });

        await openUnderStack();
        dismiss();
        flushFrames();
        now += 90;
        flushFrames();
        const midway = view().scrollY;
        expect(midway).toBeGreaterThan(-stackBottomPx(3));
        expect(midway).toBeLessThan(-stackBottomPx(2));
        now += 1000;
        flushFrames();
        expect(view().scrollY).toBe(-stackBottomPx(2));
        expect(frames).toHaveLength(0);
    });

    it('does not move the score under a finger mid-pan, and settles when it lifts', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
        await openUnderStack();
        const surface = document.querySelector('.ink-surface')!;
        const touch = (type: string, y: number) =>
            surface.dispatchEvent(
                new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: y, bubbles: true }),
            );
        touch('pointerdown', 300);
        dismiss();
        expect(view().scrollY).toBe(-stackBottomPx(3));
        // Dragging further down cannot take it past where it was, nor snap it up.
        act(() => touch('pointermove', 310));
        expect(view().scrollY).toBe(-stackBottomPx(3));
        // Dragging back up moves it with the finger.
        act(() => touch('pointermove', 300));
        expect(view().scrollY).toBe(-stackBottomPx(3) + 10);
        act(() => touch('pointerup', 300));
        expect(view().scrollY).toBe(-stackBottomPx(2));
    });

    it('leaves a view already clear of the room alone', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
        await openUnderStack();
        act(() => useViewerStore.getState().setView({ ...view(), scrollY: 300 }));
        dismiss();
        expect(view().scrollY).toBe(300);
    });

    describe('a gesture that starts while the score glides up', () => {
        /** Dismiss the notice and let 30 ms of the 180 ms glide run: the score is part way up. */
        const dismissAndGlidePartway = (frames: ReturnType<typeof manualFrames>) => {
            dismiss();
            frames.advance(0);
            frames.advance(30);
            const midway = view().scrollY;
            expect(midway).toBeGreaterThan(-stackBottomPx(3));
            expect(midway).toBeLessThan(-stackBottomPx(2) - 10);
            return midway;
        };

        /** The rest of the glide runs once nothing is down on the score. */
        const expectSettlesAfterRelease = (frames: ReturnType<typeof manualFrames>) => {
            frames.advance(0);
            frames.advance(30);
            expect(view().scrollY).toBeGreaterThan(-stackBottomPx(3));
            frames.advance(1000);
            expect(view().scrollY).toBe(-stackBottomPx(2));
            expect(frames.pending()).toHaveLength(0);
        };

        it('holds the page still under a stroke, so its points do not drift, then settles', async () => {
            const frames = manualFrames();
            let store: AnnotationStore | null = null;
            viewport = PHONE;
            render(<ViewerUnderNotices readOnly={false} onStore={(s) => (store = s)} />);
            await waitFor(() => expect(view().scrollY).toBe(-stackBottomPx(3)));
            await waitFor(() => expect(store).not.toBeNull());
            const create = vi.spyOn(store as unknown as AnnotationStore, 'create');
            act(() => useViewerStore.getState().setTool('pen'));

            const midway = dismissAndGlidePartway(frames);
            // A level line drawn across the frames the glide would have run.
            pointer('pointerdown', 7, 'pen', 120, 300);
            for (const x of [140, 160, 180, 200, 220]) {
                frames.advance(30);
                pointer('pointermove', 7, 'pen', x, 300);
            }
            expect(view().scrollY).toBe(midway);
            pointer('pointerup', 7, 'pen', 220, 300);

            expect(create).toHaveBeenCalledTimes(1);
            const { pts } = create.mock.calls[0]![0].payload as { pts: number[] };
            const ys = pts.filter((_, i) => i % 3 === 1);
            expect(ys.length).toBeGreaterThan(1);
            for (const y of ys) {
                expect(y).toBeCloseTo(ys[0]!, 6);
            }
            expectSettlesAfterRelease(frames);
        });

        it('lets a pan move with the finger instead of snapping the rest of the way, then settles', async () => {
            const frames = manualFrames();
            await openUnderStack();
            const midway = dismissAndGlidePartway(frames);

            pointer('pointerdown', 1, 'touch', 200, 300);
            frames.advance(30);
            expect(view().scrollY).toBe(midway);
            // The finger moves the score up by 10 px: by that much, not to the bound.
            pointer('pointermove', 1, 'touch', 200, 290);
            expect(view().scrollY).toBeCloseTo(midway + 10);
            frames.advance(30);
            expect(view().scrollY).toBeCloseTo(midway + 10);
            pointer('pointerup', 1, 'touch', 200, 290);
            expectSettlesAfterRelease(frames);
        });

        it('waits for the last of two fingers to lift', async () => {
            const frames = manualFrames();
            await openUnderStack();
            const midway = dismissAndGlidePartway(frames);

            pointer('pointerdown', 1, 'touch', 150, 300);
            pointer('pointerdown', 2, 'touch', 250, 300);
            frames.advance(30);
            expect(view().scrollY).toBe(midway);
            pointer('pointerup', 1, 'touch', 150, 300);
            frames.advance(30);
            expect(view().scrollY).toBe(midway);
            pointer('pointerup', 2, 'touch', 250, 300);
            expectSettlesAfterRelease(frames);
        });

        it('cancels a glide under way when the viewer unmounts', async () => {
            const frames = manualFrames();
            await openUnderStack();
            dismiss();
            frames.advance(0);
            const [glide] = frames.pending();
            expect(glide).toBeDefined();
            cleanup();
            expect(frames.cancelled).toContain(glide);
            expect(frames.pending()).toHaveLength(0);
        });
    });

    it('ends a playback follow glide under way inside the bounds it leaves', async () => {
        viewport = PHONE;
        const frames = manualFrames();
        render(
            <ViewerUnderNotices
                playback={{
                    score: tinyScore,
                    getEngine: () => ({ getPositionTicks: () => 0 }) as unknown as PlaybackEngine,
                }}
            />,
        );
        await waitFor(() => expect(view().scrollY).toBe(-stackBottomPx(3)));
        frames.advance(0);
        act(() => useViewerStore.getState().setPlaybackStatus('playing'));

        // Read further down, then follow is resumed: it glides back up to the
        // first system, which sits just under the three-card stack.
        act(() => useViewerStore.getState().setView({ ...view(), scrollY: 300 }));
        act(() => useViewerStore.getState().setFollowMode('suspended'));
        act(() => useViewerStore.getState().setFollowMode('on'));
        frames.advance(0);
        frames.advance(200);
        expect(view().scrollY).toBeLessThan(-stackBottomPx(2));

        // A card goes mid-glide: the top bound tightens to the two-card stack.
        dismiss();
        for (let i = 0; i < 40; i++) {
            frames.advance(16);
        }
        expect(useViewerStore.getState().followMode).toBe('on');
        expect(view().scrollY).toBeCloseTo(-stackBottomPx(2));
        // Still playing, the follow holds it there.
        for (let i = 0; i < 10; i++) {
            frames.advance(16);
        }
        expect(view().scrollY).toBeCloseTo(-stackBottomPx(2));
    });
});

describe('PdfViewport when a notice comes up over a score that fits', () => {
    // Zoomed out on an iPad, the whole score fits below the stack, so the top
    // bound is also the bottom one: a card coming up moves the score down.
    const IPAD = { width: 768, height: 1024 };

    it('finishes a settle that a stroke cut short once the pen lifts', async () => {
        viewport = IPAD;
        const frames = manualFrames();
        let store: AnnotationStore | null = null;
        const { rerender } = render(
            <ViewerUnderNotices readOnly={false} rejected={false} onStore={(s) => (store = s)} />,
        );
        await waitFor(() => expect(view().scrollY).toBe(-stackBottomPx(2)));
        await waitFor(() => expect(store).not.toBeNull());
        const layout = computeDocumentLayout(PAGE_SIZES, 1, false);
        const twoCards = { top: stackBottomPx(2), bottom: 0 };
        act(() =>
            useViewerStore
                .getState()
                .setView(clampScroll({ ...view(), scale: MIN_SCALE }, layout, IPAD.width, IPAD.height, twoCards)),
        );
        expect(view().scrollY).toBe(-stackBottomPx(2));
        act(() => useViewerStore.getState().setTool('pen'));

        // The card comes up (166 -> 224 px): the score glides down under it.
        rerender(<ViewerUnderNotices readOnly={false} rejected onStore={(s) => (store = s)} />);
        expect(screen.getAllByRole('status')).toHaveLength(3);
        reportResizes();
        frames.advance(0);
        frames.advance(30);
        const midway = view().scrollY;
        expect(midway).toBeLessThan(-stackBottomPx(2) - 10);
        expect(midway).toBeGreaterThan(-stackBottomPx(3));

        // A stroke 30 ms in stops the glide where it is...
        pointer('pointerdown', 7, 'pen', 360, 600);
        for (const x of [370, 380, 390, 400]) {
            frames.advance(30);
            pointer('pointermove', 7, 'pen', x, 600);
        }
        expect(view().scrollY).toBe(midway);
        pointer('pointerup', 7, 'pen', 400, 600);

        // ...and the rest of it runs once the pen lifts, to the new bound.
        frames.advance(0);
        frames.advance(1000);
        expect(view().scrollY).toBe(-stackBottomPx(3));
        expect(frames.pending()).toHaveLength(0);
    });
});
