import { useEffect, useMemo, useRef, useState } from 'react';

import {
    clampScroll,
    computeDocumentLayout,
    fitPageWidthScale,
    visiblePageRange,
    zoomAt,
    type DocumentLayout,
} from '@/features/viewer/geometry';
import { GestureController } from '@/features/viewer/ink/GestureController';
import { PageView } from '@/features/viewer/pdf/PageView';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
import { useViewerStore } from '@/state/store';

/** Delay before re-rendering page bitmaps at a new zoom level (ms). */
const RENDER_SETTLE_MS = 200;

interface ViewportSize {
    width: number;
    height: number;
}

/**
 * The scrollable, zoomable stack of PDF pages. Owns the gesture wiring and
 * page virtualization; assumes a ready PdfProvider above it.
 */
export const PdfViewport = () => {
    const { doc, pageSizes, status, error } = usePdf();
    const view = useViewerStore((s) => s.view);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
    const [renderScale, setRenderScale] = useState(view.scale);
    const didFitRef = useRef(false);

    const layout: DocumentLayout = useMemo(() => computeDocumentLayout(pageSizes), [pageSizes]);

    // Track viewport size.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const observer = new ResizeObserver(() => {
            setViewportSize({ width: el.clientWidth, height: el.clientHeight });
        });
        observer.observe(el);
        setViewportSize({ width: el.clientWidth, height: el.clientHeight });
        return () => observer.disconnect();
    }, []);

    // Fit the widest page to the viewport width once the document is ready.
    useEffect(() => {
        if (didFitRef.current || status !== 'ready' || viewportSize.width === 0 || layout.layouts.length === 0) {
            return;
        }
        didFitRef.current = true;
        const scale = fitPageWidthScale(layout, viewportSize.width);
        const fitted = clampScroll({ scale, scrollX: 0, scrollY: 0 }, layout, viewportSize.width, viewportSize.height);
        useViewerStore.getState().resetView(fitted);
        setRenderScale(scale);
    }, [status, viewportSize, layout]);

    // Crisp bitmap re-render shortly after zoom settles (canvases CSS-stretch meanwhile).
    useEffect(() => {
        if (view.scale === renderScale) {
            return;
        }
        const timer = setTimeout(() => setRenderScale(useViewerStore.getState().view.scale), RENDER_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [view.scale, renderScale]);

    // Gesture wiring. Layout/viewport live in refs so the controller attaches once.
    const layoutRef = useRef(layout);
    const viewportSizeRef = useRef(viewportSize);
    useEffect(() => {
        layoutRef.current = layout;
        viewportSizeRef.current = viewportSize;
    }, [layout, viewportSize]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const clamp = (v: { scale: number; scrollX: number; scrollY: number }) =>
            clampScroll(v, layoutRef.current, viewportSizeRef.current.width, viewportSizeRef.current.height);

        const controller = new GestureController(el, {
            onPan: (dx, dy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX - dx, scrollY: v.scrollY - dy }));
            },
            onZoomBy: (factor, cx, cy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp(zoomAt(v, v.scale * factor, cx, cy)));
            },
            onWheelScroll: (dx, dy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX + dx, scrollY: v.scrollY + dy }));
            },
            onGestureEnd: () => {
                // Bitmap refresh is handled by the settle timer on scale change.
            },
        });
        return () => controller.destroy();
    }, []);

    const pages = [];
    if (doc) {
        const range = visiblePageRange(view, viewportSize.height, layout.layouts);
        for (let i = range.start; i <= range.end; i++) {
            const pageLayout = layout.layouts[i];
            if (pageLayout) {
                pages.push(<PageView key={i} doc={doc} pageIndex={i} layout={pageLayout} scale={renderScale} />);
            }
        }
    }

    // Positions use the live scale; bitmaps use the settled renderScale. While they
    // differ, canvases are CSS-stretched by wrapping pages in a scaling transform.
    const previewFactor = view.scale / renderScale;

    // NOTE: the ref'd container must render in every state — the ResizeObserver
    // and GestureController bind once and would otherwise attach to nothing.
    return (
        <div ref={containerRef} className="ink-surface relative h-full overflow-hidden bg-stone-200">
            {status === 'loading' ? (
                <div className="flex h-full items-center justify-center">
                    <p className="animate-pulse text-stone-500">Loading score…</p>
                </div>
            ) : status === 'error' || !doc ? (
                <div className="flex h-full items-center justify-center p-8">
                    <p className="text-red-600">Could not open this PDF{error ? `: ${error}` : '.'}</p>
                </div>
            ) : (
                <>
                    <div
                        className="absolute left-0 top-0"
                        style={{
                            transform: `translate(${-view.scrollX}px, ${-view.scrollY}px) scale(${previewFactor})`,
                            transformOrigin: '0 0',
                            width: layout.contentWidth * renderScale,
                            height: layout.contentHeight * renderScale,
                        }}
                    >
                        {pages}
                    </div>
                    <ZoomControls
                        onZoomBy={(factor) => {
                            const { view: v, setView } = useViewerStore.getState();
                            const zoomed = zoomAt(v, v.scale * factor, viewportSize.width / 2, viewportSize.height / 2);
                            setView(clampScroll(zoomed, layout, viewportSize.width, viewportSize.height));
                        }}
                    />
                </>
            )}
        </div>
    );
};

const ZoomControls = ({ onZoomBy }: { onZoomBy: (factor: number) => void }) => {
    const zoomBy = onZoomBy;

    return (
        <div className="absolute bottom-[calc(1rem+var(--safe-bottom))] right-4 flex flex-col gap-2">
            <button
                type="button"
                aria-label="Zoom in"
                onClick={() => zoomBy(1.25)}
                className="h-11 w-11 rounded-full bg-white text-xl font-bold text-stone-700 shadow-md active:bg-stone-100"
            >
                +
            </button>
            <button
                type="button"
                aria-label="Zoom out"
                onClick={() => zoomBy(0.8)}
                className="h-11 w-11 rounded-full bg-white text-xl font-bold text-stone-700 shadow-md active:bg-stone-100"
            >
                −
            </button>
        </div>
    );
};
