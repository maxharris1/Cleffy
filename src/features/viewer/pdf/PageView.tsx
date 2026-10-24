import { RenderingCancelledException, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { memo, useEffect, useRef, useState } from 'react';

import { bitmapDims, INK_MAX_DPR, type PageLayout } from '@/features/viewer/geometry';
import type { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';

export interface PageViewProps {
    doc: PDFDocumentProxy;
    pageIndex: number;
    layout: PageLayout;
    scale: number;
    /**
     * Backing pixels per CSS pixel for the PDF raster — the device ratio,
     * already reduced by the viewport's bitmap budget. Ink canvases use at
     * most INK_MAX_DPR of it.
     */
    pixelRatio: number;
    registry: CanvasRegistry;
}

/**
 * One page of the score: a three-canvas stack (plan §canvas/input) —
 * 1. pdf canvas: pdf.js raster, redrawn only when the settled scale changes;
 * 2. committed canvas: all committed annotations, repainted by InkController;
 * 3. live canvas: the in-flight stroke (local or remote), cleared per frame.
 * Positioned absolutely by the parent in scaled CSS px.
 */
export const PageView = memo(({ doc, pageIndex, layout, scale, pixelRatio, registry }: PageViewProps) => {
    const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const [renderFailed, setRenderFailed] = useState(false);

    // pdf.js raster.
    useEffect(() => {
        const canvas = pdfCanvasRef.current;
        if (!canvas) {
            return;
        }
        let renderTask: RenderTask | null = null;
        let cancelled = false;
        setRenderFailed(false);

        (async () => {
            try {
                const page = await doc.getPage(pageIndex + 1);
                if (cancelled) {
                    return;
                }
                const dims = bitmapDims(layout, scale, pixelRatio);
                const viewport = page.getViewport({ scale: dims.pxPerBase });
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
                    // Leave the canvas blank but surface a product-level failure.
                    console.warn(`PDF page ${pageIndex + 1} failed to render`, err);
                    setRenderFailed(true);
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
    }, [doc, pageIndex, layout, scale, pixelRatio]);

    // Annotation canvases: sized like the raster but at ink resolution, then
    // registered — the ink controller listens on the registry and paints
    // committed strokes scaled to whatever size the canvas has.
    useEffect(() => {
        const committed = committedCanvasRef.current;
        const live = liveCanvasRef.current;
        if (!committed || !live) {
            return;
        }
        const dims = bitmapDims(layout, scale, Math.min(pixelRatio, INK_MAX_DPR));
        committed.width = dims.width;
        committed.height = dims.height;
        live.width = dims.width;
        live.height = dims.height;
        registry.register(pageIndex, { committed, live });

        return () => {
            registry.unregister(pageIndex);
            committed.width = 0;
            committed.height = 0;
            live.width = 0;
            live.height = 0;
        };
    }, [registry, pageIndex, layout, scale, pixelRatio]);

    return (
        <div
            className="absolute bg-white shadow-md"
            style={{
                top: layout.top * scale,
                left: layout.left * scale,
                width: layout.width * scale,
                height: layout.height * scale,
            }}
        >
            <canvas ref={pdfCanvasRef} className="absolute inset-0 h-full w-full" data-page-index={pageIndex} />
            <canvas ref={committedCanvasRef} className="absolute inset-0 h-full w-full" data-ink-layer="committed" />
            <canvas ref={liveCanvasRef} className="absolute inset-0 h-full w-full" data-ink-layer="live" />
            {renderFailed ? (
                <div
                    className="absolute inset-0 z-10 flex items-center justify-center bg-white/90 p-4 text-center"
                    role="alert"
                >
                    <p className="text-sm text-red-700">Page {pageIndex + 1} couldn&apos;t render</p>
                </div>
            ) : null}
        </div>
    );
});

PageView.displayName = 'PageView';
