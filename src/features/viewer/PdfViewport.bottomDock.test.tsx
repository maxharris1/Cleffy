import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomDock } from '@/features/viewer/bottomDock';
import { computeDocumentLayout } from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';

const LETTER = { width: 612, height: 792 };
let PAGE_SIZES = [LETTER];

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
    PAGE_SIZES = [LETTER];
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const pageBottomOnScreen = (index = 0) => {
    const { scale, scrollY } = useViewerStore.getState().view;
    const page = computeDocumentLayout(PAGE_SIZES, 1, false).layouts[index]!;
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

const controlFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return (ms: number) => {
        now += ms;
        act(() => {
            const due = [...frames.values()];
            frames.clear();
            for (const callback of due) {
                callback(now);
            }
        });
    };
};

const touch = (type: string, y: number) =>
    act(() => {
        document
            .querySelector('.ink-surface')!
            .dispatchEvent(
                new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: 195, clientY: y, bubbles: true }),
            );
    });

describe('PdfViewport when the bottom dock goes with the score at its end', () => {
    const dismissDockAtEnd = async (advance: (ms: number) => void) => {
        PAGE_SIZES = [LETTER, LETTER, LETTER];
        const { container, rerender } = render(
            <>
                <PdfViewport docId="doc-dock-settle" readOnly />
                <Dock />
            </>,
        );
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        scrollToEnd(container.querySelector('.ink-surface')!);
        const atEnd = useViewerStore.getState().view.scrollY;

        rerender(<PdfViewport docId="doc-dock-settle" readOnly />);
        advance(0);
        advance(20);
        const settling = useViewerStore.getState().view.scrollY;
        expect(settling).toBeLessThan(atEnd);
        return settling;
    };

    it('moves the score with a finger that interrupts the settle, not to the new bound', async () => {
        const advance = controlFrames();
        const settling = await dismissDockAtEnd(advance);

        touch('pointerdown', 300);
        advance(40);
        expect(useViewerStore.getState().view.scrollY).toBe(settling);
        touch('pointermove', 302);
        expect(useViewerStore.getState().view.scrollY).toBeCloseTo(settling - 2);
        touch('pointermove', 312);
        expect(useViewerStore.getState().view.scrollY).toBeCloseTo(settling - 12);
        touch('pointermove', 290);
        expect(useViewerStore.getState().view.scrollY).toBeCloseTo(settling - 12);

        touch('pointerup', 290);
        advance(0);
        advance(1000);
        expect(pageBottomOnScreen(2)).toBeLessThanOrEqual(VIEWPORT.height - CONTROLS_STRIP_PX);
        expect(useViewerStore.getState().view.scrollY).toBeLessThan(settling);
    });

    it('holds the new bottom bound when a drag that came back inside it reverses', async () => {
        const advance = controlFrames();
        const settling = await dismissDockAtEnd(advance);

        touch('pointerdown', 300);
        for (let y = 325; y <= 500; y += 25) {
            advance(16);
            touch('pointermove', y);
        }
        const inside = useViewerStore.getState().view.scrollY;
        advance(60);
        let furthest = inside;
        for (let y = 475; y >= 300; y -= 25) {
            advance(16);
            touch('pointermove', y);
            furthest = Math.max(furthest, useViewerStore.getState().view.scrollY);
        }
        touch('pointerup', 300);
        advance(0);
        advance(1000);
        const limit = useViewerStore.getState().view.scrollY;

        expect(inside).toBeLessThan(limit);
        expect(limit).toBeLessThan(settling);
        expect(furthest).toBeLessThanOrEqual(limit + 0.5);
        expect(pageBottomOnScreen(2)).toBeLessThanOrEqual(VIEWPORT.height - CONTROLS_STRIP_PX);
    });
});
