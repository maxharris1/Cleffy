import { cleanup, render, waitFor } from '@testing-library/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { PageView } from '@/features/viewer/pdf/PageView';
import { perfReport } from '@/lib/perf';

const PHONE_SHADOW = 'shadow-[0_0_0_1px_rgba(28,25,23,0.08),0_20px_40px_-24px_rgba(28,25,23,0.5)]';
const DESKTOP_SHADOW = 'shadow-[0_0_0_1px_rgba(28,25,23,0.08),0_30px_60px_-30px_rgba(28,25,23,0.45)]';

afterEach(() => {
    cleanup();
    performance.clearMarks();
});

describe('PageView', () => {
    it('casts the phone page shadow below sm and the desktop one from sm up', () => {
        const doc = { getPage: () => new Promise(() => {}) } as unknown as PDFDocumentProxy;
        const registry = { register: () => {}, unregister: () => {} } as unknown as CanvasRegistry;
        const { container } = render(
            <PageView
                doc={doc}
                pageIndex={0}
                layout={{ top: 16, left: 0, width: 612, height: 792 }}
                scale={1}
                pixelRatio={1}
                registry={registry}
            />,
        );
        const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
        expect(classes).toContain(PHONE_SHADOW);
        expect(classes).toContain(`sm:${DESKTOP_SHADOW}`);
        expect(classes).not.toContain(DESKTOP_SHADOW);
    });

    it('marks page 1 painted a frame after its raster finishes, and no other page', async () => {
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
        const page = {
            getViewport: () => ({ width: 612, height: 792 }),
            render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        };
        const doc = { getPage: async () => page } as unknown as PDFDocumentProxy;
        const registry = { register: () => {}, unregister: () => {} } as unknown as CanvasRegistry;
        const layout = { top: 16, left: 0, width: 612, height: 792 };
        render(
            <>
                <PageView doc={doc} pageIndex={0} layout={layout} scale={1} pixelRatio={1} registry={registry} />
                <PageView doc={doc} pageIndex={1} layout={layout} scale={1} pixelRatio={1} registry={registry} />
            </>,
        );

        await waitFor(() => expect(perfReport().map((row) => row.mark)).toEqual(['pdf-page1-painted']));
    });
});
