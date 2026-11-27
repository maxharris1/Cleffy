import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalViewerFrame } from '@/features/viewer/LocalViewerFrame';

vi.mock('@/features/viewer/PdfViewport', () => ({ PdfViewport: () => null }));
vi.mock('@/features/viewer/pdf/PdfProvider', () => ({
    PdfProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const HEADER_BOTTOM = 100;
const HINT_OVERLAY = { top: 108, bottom: 144 };

const band = () => document.documentElement.style.getPropertyValue('--viewer-top-band');

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.firstElementChild?.hasAttribute('data-hint')) {
            return DOMRect.fromRect({
                x: 0,
                y: HINT_OVERLAY.top,
                width: 390,
                height: HINT_OVERLAY.bottom - HINT_OVERLAY.top,
            });
        }
        const score = this.parentElement?.tagName === 'MAIN';
        return DOMRect.fromRect({ x: 0, y: HEADER_BOTTOM, width: 390, height: score ? 480 - HEADER_BOTTOM : 0 });
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

const frame = (overlay: React.ReactNode) => (
    <LocalViewerFrame
        docId="doc-band"
        bytes={new ArrayBuffer(0)}
        header={<header />}
        overlay={overlay}
        onStoreReady={() => {}}
    />
);

describe('LocalViewerFrame on a 390 × 480 phone', () => {
    it('publishes the drawing hint’s bottom as --viewer-top-band, so a bottom dock stays below it', () => {
        render(frame(<p data-hint>Draw on the score</p>));
        expect(band()).toBe(`${HINT_OVERLAY.bottom}px`);
    });

    it('publishes the top of the score once the hint goes', () => {
        const { rerender } = render(frame(<p data-hint>Draw on the score</p>));
        rerender(frame(null));
        expect(band()).toBe(`${HEADER_BOTTOM}px`);
    });

    it('removes the property when the viewer unmounts', () => {
        const { unmount } = render(frame(<p data-hint>Draw on the score</p>));
        unmount();
        expect(band()).toBe('');
    });
});
