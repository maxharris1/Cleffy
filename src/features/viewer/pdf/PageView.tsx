import { RenderingCancelledException, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { memo, useEffect, useRef } from 'react';

import { MAX_BITMAP_SIDE, type PageLayout } from '@/features/viewer/geometry';

export interface PageViewProps {
    doc: PDFDocumentProxy;
    pageIndex: number;
    layout: PageLayout;
    scale: number;
}

/**
 * Renders one PDF page to a canvas at the committed scale.
 * Positioned absolutely by the parent in scaled CSS px.
 */
export const PageView = memo(({ doc, pageIndex, layout, scale }: PageViewProps) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const cssWidth = layout.width * scale;
    const cssHeight = layout.height * scale;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        let renderTask: RenderTask | null = null;
        let cancelled = false;

        (async () => {
            try {
                const page = await doc.getPage(pageIndex + 1);
                if (cancelled) {
                    return;
                }
                const dpr = Math.min(window.devicePixelRatio || 1, 3);
                const targetWidth = layout.width * scale * dpr;
                const targetHeight = layout.height * scale * dpr;
                const cap = MAX_BITMAP_SIDE / Math.max(targetWidth, targetHeight);
                const bitmapScale = scale * dpr * Math.min(1, cap);

                const viewport = page.getViewport({ scale: bitmapScale });
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return;
                }
                // PDFs without an explicit background are transparent — paint the
                // paper white ourselves so scans and vector pages look the same.
                renderTask = page.render({ canvasContext: ctx, viewport, canvas, background: 'rgba(255,255,255,1)' });
                await renderTask.promise;
            } catch (err) {
                if (!(err instanceof RenderingCancelledException) && !cancelled) {
                    // A single failed page shouldn't crash the viewer — leave the
                    // canvas blank but make the failure observable.
                    console.warn(`PDF page ${pageIndex + 1} failed to render`, err);
                }
            }
        })();

        return () => {
            cancelled = true;
            renderTask?.cancel();
            // Required to actually free canvas memory on iOS.
            canvas.width = 0;
            canvas.height = 0;
        };
    }, [doc, pageIndex, layout, scale]);

    return (
        <div
            className="absolute bg-white shadow-md"
            style={{
                top: layout.top * scale,
                left: layout.left * scale,
                width: cssWidth,
                height: cssHeight,
            }}
        >
            <canvas ref={canvasRef} className="h-full w-full" data-page-index={pageIndex} />
        </div>
    );
});

PageView.displayName = 'PageView';
