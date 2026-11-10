import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PAGE_GAP,
    computeDocumentLayout,
    fitPageWidthScale,
    focusedPageIndex,
    type PageColumns,
} from '@/features/viewer/geometry';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';
import { menuBaseModule } from '@/ui/lazyPrimitives';

/** Letter-size pages, enough of them that the reader can be somewhere in the middle. */
const PAGE_SIZES = Array.from({ length: 8 }, () => ({ width: 612, height: 792 }));

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

/** Viewer areas (px) the toggle is offered at: desktop around 1024 wide, iPad landscape, a large desktop. */
const VIEWPORTS = [
    { name: 'desktop 1024', width: 1024, height: 700 },
    { name: 'iPad landscape', width: 1180, height: 760 },
    { name: 'desktop 1440', width: 1440, height: 820 },
];

let viewport = { width: 1024, height: 700 };

beforeAll(async () => {
    await menuBaseModule.load();
});

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewport.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport.height);
    useViewerStore.setState({ pageColumns: 1, spreadCover: false });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useViewerStore.setState({ pageColumns: 1, spreadCover: false });
    window.localStorage.clear();
});

/** The layout choices live in the layout button's menu: open it to reach one. */
const inLayoutMenu = (role: 'menuitemradio' | 'menuitemcheckbox', name: string) => {
    const button = screen.getByRole('button', { name: /^Page layout/ });
    if (button.getAttribute('aria-expanded') !== 'true') {
        fireEvent.click(button);
    }
    return screen.getByRole(role, { name });
};
const singlePage = () => inLayoutMenu('menuitemradio', 'Single page');
const twoPages = () => inLayoutMenu('menuitemradio', 'Two pages');
const coverChip = () => inLayoutMenu('menuitemcheckbox', 'Start with cover page');

/** The page wrapper: laid out at renderScale, CSS-scaled to the live view. */
const wrapper = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-render-scale]');
    if (!el) {
        throw new Error('page wrapper not rendered');
    }
    return el;
};

/**
 * What the reader sees: the pages' on-screen width, left edge and top edge,
 * from the wrapper's laid-out size and the transform actually on the DOM —
 * not from the store, which can be right while the screen is not.
 */
const onScreen = () => {
    const el = wrapper();
    const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(el.style.transform);
    if (!match) {
        throw new Error(`unexpected wrapper transform: ${el.style.transform}`);
    }
    const cssScale = Number(match[3]);
    return {
        width: parseFloat(el.style.width) * cssScale,
        left: Number(match[1]),
        top: Number(match[2]),
        cssScale,
    };
};

const expectFitWidth = (columns: PageColumns, cover: boolean) => {
    const layout = computeDocumentLayout(PAGE_SIZES, columns, cover);
    const fitted = fitPageWidthScale(layout, viewport.width);
    const { view } = useViewerStore.getState();
    expect(view.scale).toBeCloseTo(fitted, 6);
    const screenBox = onScreen();
    // The page (or the spread) fills the width, with the usual margin each side.
    expect(screenBox.width).toBeCloseTo(viewport.width - 2 * PAGE_GAP, 3);
    expect(screenBox.left).toBeCloseTo(PAGE_GAP, 3);
    expect(screenBox.cssScale).toBeCloseTo(1, 6);
    return layout;
};

/** Reach the item first: the menu has to open (and render) before its item can be pressed. */
const toggleColumns = (columns: PageColumns) => {
    const item = columns === 1 ? singlePage() : twoPages();
    act(() => {
        fireEvent.click(item);
    });
};

const toggleCover = () => {
    const item = coverChip();
    act(() => {
        fireEvent.click(item);
    });
};

describe.each(VIEWPORTS)('switching Single page / Two pages at $name', ({ width, height }) => {
    beforeEach(() => {
        viewport = { width, height };
    });

    it.each([false, true])(
        'refits to the page width every time, two→single and single→two, repeatedly (cover %s)',
        async (cover) => {
            render(<PdfViewport docId="doc-toggle" />);
            await waitFor(() => expect(singlePage()).toHaveAttribute('aria-checked', 'true'));
            expectFitWidth(1, false);

            toggleColumns(2);
            if (cover) {
                toggleCover();
            }
            for (let round = 0; round < 3; round++) {
                expectFitWidth(2, cover);
                toggleColumns(1);
                expectFitWidth(1, cover);
                toggleColumns(2);
            }
            expectFitWidth(2, cover);
        },
    );

    it('keeps the page being read in view, and fitted, across a round trip from mid-score', async () => {
        render(<PdfViewport docId="doc-toggle-mid" />);
        await waitFor(() => expect(singlePage()).toHaveAttribute('aria-checked', 'true'));

        // Turn to page 5 in single page.
        for (let i = 0; i < 4; i++) {
            act(() => {
                fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            });
        }
        const pageInView = () => {
            const { view, pageColumns, spreadCover } = useViewerStore.getState();
            const layout = computeDocumentLayout(PAGE_SIZES, pageColumns, spreadCover);
            return focusedPageIndex(view, viewport.height, layout.layouts);
        };
        expect(pageInView()).toBe(4);

        toggleColumns(2);
        const spread = expectFitWidth(2, false);
        // Page 5 sits in the 5|6 spread, whose top starts the view.
        const spreadTop = spread.layouts[4]?.top ?? 0;
        expect(onScreen().top).toBeCloseTo(-(spreadTop - PAGE_GAP) * useViewerStore.getState().view.scale, 3);
        expect([4, 5]).toContain(pageInView());

        toggleColumns(1);
        const single = expectFitWidth(1, false);
        expect(onScreen().top).toBeCloseTo(
            -((single.layouts[4]?.top ?? 0) - PAGE_GAP) * useViewerStore.getState().view.scale,
            3,
        );
        expect(pageInView()).toBe(4);
    });

    it('turning the cover page on and off refits the spread at the top of the score', async () => {
        render(<PdfViewport docId="doc-toggle-cover" />);
        await waitFor(() => expect(singlePage()).toHaveAttribute('aria-checked', 'true'));
        toggleColumns(2);
        for (let round = 0; round < 3; round++) {
            toggleCover();
            expectFitWidth(2, true);
            toggleCover();
            expectFitWidth(2, false);
        }
    });
});
