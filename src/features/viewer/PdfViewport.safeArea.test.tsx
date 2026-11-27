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
let viewportHeight = VIEWPORT.height;
const SAFE_BOTTOM_PX = 34;
let safeBottom = SAFE_BOTTOM_PX;
const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
/** The pager's 0.5rem lift above the safe area, its 46 px keys and a 2 px gap. */
const PAGER_STRIP_PX = 56;

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            private readonly entry: (typeof observers)[number];
            constructor(callback: ResizeObserverCallback) {
                this.entry = { callback, targets: [] };
                observers.push(this.entry);
            }
            observe(target: Element) {
                this.entry.targets.push(target);
            }
            unobserve() {}
            disconnect() {
                this.entry.targets = [];
            }
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => VIEWPORT.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.className.includes('h-[var(--safe-bottom)]') ? safeBottom : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
        DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT }),
    );
    safeBottom = SAFE_BOTTOM_PX;
    viewportHeight = VIEWPORT.height;
    observers.length = 0;
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function lastPageBottom(): number {
    const { scale, scrollY } = useViewerStore.getState().view;
    const last = computeDocumentLayout(PAGE_SIZES, 1, false).layouts[2]!;
    return (last.top + last.height) * scale - scrollY;
}

function turnToLastPage(): HTMLElement {
    const next = screen.getByRole('button', { name: 'Next page' });
    for (let turns = 0; turns < 10 && !next.hasAttribute('disabled'); turns++) {
        act(() => fireEvent.click(next));
    }
    expect(next).toBeDisabled();
    expect(screen.getByText(/^p\. \d+ \/ 3$/)).toHaveTextContent('p. 3 / 3');
    return next;
}

/** What the browser does when only the inset changes: the viewport keeps its size. */
function changeSafeBottom(px: number) {
    safeBottom = px;
    deliverResize();
}

/** One observer delivery to every observer watching the safe-area probe. */
function deliverResize() {
    const probe = document.querySelector('.h-\\[var\\(--safe-bottom\\)\\]');
    expect(probe).not.toBeNull();
    act(() => {
        for (const { callback, targets } of observers) {
            if (targets.includes(probe!)) {
                callback([], {} as ResizeObserver);
            }
        }
    });
}

describe('PdfViewport on a phone with a bottom safe area and no toolbar', () => {
    it('scrolls the end of the last page above the pager, which sits on the safe area', async () => {
        render(<PdfViewport docId="doc-safe-area" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        turnToLastPage();

        expect(lastPageBottom()).toBeLessThanOrEqual(VIEWPORT.height - SAFE_BOTTOM_PX - PAGER_STRIP_PX);
    });

    it('re-measures the safe area when only the inset grows after mount', async () => {
        safeBottom = 0;
        render(<PdfViewport docId="doc-safe-area-grows" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));

        changeSafeBottom(SAFE_BOTTOM_PX);
        turnToLastPage();

        expect(lastPageBottom()).toBeLessThanOrEqual(VIEWPORT.height - SAFE_BOTTOM_PX - PAGER_STRIP_PX);
    });

    it('frees the room when the inset shrinks back, settling a view resting at the bottom', async () => {
        render(<PdfViewport docId="doc-safe-area-shrinks" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        turnToLastPage();
        const restingBottom = lastPageBottom();

        changeSafeBottom(0);
        await waitFor(() => expect(lastPageBottom()).toBeCloseTo(restingBottom + SAFE_BOTTOM_PX, 0));
    });

    it('gives the pager its room back on leaving stand mode after the inset changed in it', async () => {
        safeBottom = 0;
        render(<PdfViewport docId="doc-safe-area-stand" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        turnToLastPage();

        act(() => useViewerStore.getState().setStandMode(true));
        changeSafeBottom(SAFE_BOTTOM_PX);
        changeSafeBottom(0);
        act(() => useViewerStore.getState().setStandMode(false));

        expect(lastPageBottom()).toBeLessThanOrEqual(VIEWPORT.height - PAGER_STRIP_PX);
    });

    it('keeps the reading position when the height and the inset change in one delivery', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
        render(<PdfViewport docId="doc-safe-area-resize" readOnly />);
        await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
        turnToLastPage();
        const before = useViewerStore.getState().view;

        viewportHeight = 500;
        safeBottom = 0;
        deliverResize();

        const centreY = before.scrollY + VIEWPORT.height / 2 - viewportHeight / 2;
        await waitFor(() => expect(useViewerStore.getState().view.scrollY).toBeCloseTo(centreY, 1));
    });
});
