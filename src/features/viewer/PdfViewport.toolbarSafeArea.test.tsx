import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomDock } from '@/features/viewer/bottomDock';
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

const VIEWPORT = { width: 390, height: 664 };
const DOCK_PX = 100;
const TOOLBAR_HEIGHT_PX = 54;
const TOOLBAR_LIFT_PX = 12;
const PROBE = '.h-\\[var\\(--safe-bottom\\)\\]';
let safeBottom = 34;
const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

beforeEach(() => {
    VIEWPORT.height = 664;
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
    }));
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
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEWPORT.height);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.matches(PROBE) ? safeBottom : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.matches('[data-ui-overlay]') && this.querySelector(`:scope > ${PROBE}`)) {
            const top = VIEWPORT.height - TOOLBAR_HEIGHT_PX - TOOLBAR_LIFT_PX - safeBottom;
            return DOMRect.fromRect({ x: 0, y: top, width: VIEWPORT.width, height: TOOLBAR_HEIGHT_PX });
        }
        if (this.hasAttribute('data-dock')) {
            return DOMRect.fromRect({ x: 0, y: VIEWPORT.height - DOCK_PX, width: VIEWPORT.width, height: DOCK_PX });
        }
        return DOMRect.fromRect({ x: 0, y: 0, ...VIEWPORT });
    });
    observers.length = 0;
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const Dock = () => <div ref={useBottomDock()} data-dock />;

async function mountAtEnd(docId: string, readOnly = false): Promise<ReturnType<typeof render>> {
    const mounted = render(<PdfViewport docId={docId} readOnly={readOnly} />);
    await waitFor(() => expect(useViewerStore.getState().view.scale).not.toBe(1));
    const next = screen.getByRole('button', { name: 'Next page' });
    for (let turns = 0; turns < 10 && !next.hasAttribute('disabled'); turns++) {
        act(() => fireEvent.click(next));
    }
    expect(screen.getByText(/^p\. \d+ \/ 3$/)).toHaveTextContent('p. 3 / 3');
    return mounted;
}

async function coldScrollY(inset: number, readOnly = false): Promise<number> {
    safeBottom = inset;
    await mountAtEnd(`doc-cold-${inset}-${readOnly}`, readOnly);
    const { scrollY } = useViewerStore.getState().view;
    cleanup();
    observers.length = 0;
    return scrollY;
}

const scrollY = () => useViewerStore.getState().view.scrollY;

function viewerObserver(): ResizeObserverCallback {
    const viewerProbe = [...document.querySelectorAll(PROBE)].find((probe) => !probe.closest('[data-ui-overlay]'));
    expect(viewerProbe).toBeDefined();
    return observers.find(({ targets }) => targets.includes(viewerProbe!))!.callback;
}

function deliver(...callbacks: ResizeObserverCallback[]) {
    act(() => {
        for (const callback of callbacks) {
            callback([], {} as ResizeObserver);
        }
    });
}

function probeObservers(): { viewport: ResizeObserverCallback; toolbar: ResizeObserverCallback } {
    const toolbarProbe = document.querySelector(`[data-ui-overlay] > ${PROBE}`);
    const viewerProbe = [...document.querySelectorAll(PROBE)].find((probe) => probe !== toolbarProbe);
    expect(toolbarProbe).not.toBeNull();
    expect(viewerProbe).toBeDefined();
    const watching = (probe: Element) => observers.find(({ targets }) => targets.includes(probe))!.callback;
    return { viewport: watching(viewerProbe!), toolbar: watching(toolbarProbe!) };
}

function changeInset(px: number, first: 'viewport' | 'toolbar') {
    const { viewport, toolbar } = probeObservers();
    safeBottom = px;
    const order = first === 'viewport' ? [viewport, toolbar] : [toolbar, viewport];
    for (const callback of order) {
        act(() => callback([], {} as ResizeObserver));
    }
}

describe('PdfViewport with the annotation toolbar when only the bottom inset changes at the end', () => {
    for (const first of ['viewport', 'toolbar'] as const) {
        it(`lands where a cold mount at the new inset does, 34 → 0 and back, ${first} observer first`, async () => {
            const coldAt0 = await coldScrollY(0);
            const coldAt34 = await coldScrollY(34);
            expect(coldAt34 - coldAt0).toBeCloseTo(34, 1);

            safeBottom = 34;
            await mountAtEnd(`doc-inset-${first}`);
            expect(useViewerStore.getState().view.scrollY).toBeCloseTo(coldAt34, 1);

            changeInset(0, first);
            expect(useViewerStore.getState().view.scrollY).toBeCloseTo(coldAt0, 1);
            act(() => {
                document
                    .querySelector('.ink-surface')!
                    .dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true }));
            });
            expect(useViewerStore.getState().view.scrollY).toBeCloseTo(coldAt0, 1);

            changeInset(34, first);
            expect(useViewerStore.getState().view.scrollY).toBeCloseTo(coldAt34, 1);
            expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
        });
    }
});

describe('PdfViewport at the end of the score when other bottom edges change (as #229 leaves them)', () => {
    it('keeps the read-only view where it is when the inset grows', async () => {
        safeBottom = 0;
        await mountAtEnd('doc-readonly-grow', true);
        const before = scrollY();

        safeBottom = 34;
        deliver(viewerObserver());

        expect(scrollY()).toBeCloseTo(before, 3);
    });

    it('keeps the read-only view where it is when a bottom dock arrives', async () => {
        safeBottom = 0;
        const { rerender } = await mountAtEnd('doc-readonly-dock', true);
        const before = scrollY();

        rerender(
            <>
                <PdfViewport docId="doc-readonly-dock" readOnly />
                <Dock />
            </>,
        );

        expect(scrollY()).toBeCloseTo(before, 3);
    });

    it('settles an inset shrink made just after leaving stand mode', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const coldAt0 = await coldScrollY(0, true);
            safeBottom = 34;
            await mountAtEnd('doc-readonly-stand', true);

            act(() => useViewerStore.getState().setStandMode(true));
            act(() => useViewerStore.getState().setStandMode(false));
            safeBottom = 0;
            deliver(viewerObserver());
            act(() => vi.advanceTimersByTime(1100));

            expect(scrollY()).toBeCloseTo(coldAt0, 3);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('PdfViewport with the annotation toolbar when the height and the inset change together at the end', () => {
    const orders = {
        'window resize, then both observers': ({ viewport, toolbar }: ReturnType<typeof probeObservers>) => {
            act(() => window.dispatchEvent(new Event('resize')));
            deliver(viewport, toolbar);
        },
        'toolbar observer committed first': ({ viewport, toolbar }: ReturnType<typeof probeObservers>) => {
            deliver(toolbar);
            deliver(viewport);
        },
        'both observers in one commit': ({ viewport, toolbar }: ReturnType<typeof probeObservers>) => {
            deliver(toolbar, viewport);
        },
        'viewport observer committed first': ({ viewport, toolbar }: ReturnType<typeof probeObservers>) => {
            deliver(viewport);
            deliver(toolbar);
        },
    };
    for (const [name, change] of Object.entries(orders)) {
        it(`keeps the reading centre, ${name}`, async () => {
            safeBottom = 34;
            await mountAtEnd(`doc-combined-${name}`);
            const before = scrollY();
            const observed = probeObservers();

            VIEWPORT.height = 500;
            safeBottom = 0;
            change(observed);

            expect(scrollY()).toBeCloseTo(before + (664 - 500) / 2, 3);
        });
    }
});
