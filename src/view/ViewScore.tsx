import { RenderingCancelledException, type PDFDocumentProxy } from 'pdfjs-dist';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { drawAnnotation, StrokePathCache } from '@/features/viewer/ink/strokeRenderer';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
import type { Annotation, AnnotationPayload, PageSize } from '@/types/models';
import type { ViewScoreProps } from '@/view/ViewApp';
import type { ViewMark } from '@/view/viewLinkClient';

/**
 * The read-only score for /v: pdf.js pages fitted to the width, each with an
 * ink canvas painted by the same drawAnnotation the viewer uses. No
 * PdfViewport: that brings the annotation store, its on-device cache and sync. No
 * input, no toolbar, nothing stored.
 */

/** Backing pixels per CSS pixel, capped: a phone at 3x would triple memory for no visible gain. */
const MAX_DPR = 2;

const toAnnotation = (mark: ViewMark): Annotation => ({
    id: mark.id,
    docId: '',
    page: mark.page,
    kind: mark.kind,
    color: mark.color,
    payload: mark.payload as AnnotationPayload,
    createdBy: null,
    createdAt: '',
    // The path cache keys on this: a new seq is a new version of the mark.
    updatedAt: String(mark.seq),
    deletedAt: null,
    seq: mark.seq,
});

export const ViewScore = ({ bytes, annotations }: ViewScoreProps) => (
    <PdfProvider data={bytes}>
        <Pages annotations={annotations} />
    </PdfProvider>
);

const Pages = ({ annotations }: { annotations: readonly ViewMark[] }) => {
    const { doc, pageSizes, status } = usePdf();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const measure = () => setWidth(Math.floor(el.clientWidth));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const byPage = useMemo(() => {
        const map = new Map<number, Annotation[]>();
        for (const mark of annotations) {
            const list = map.get(mark.page) ?? [];
            list.push(toAnnotation(mark));
            map.set(mark.page, list);
        }
        return map;
    }, [annotations]);

    return (
        <div className="mx-auto w-full max-w-4xl flex-1 px-2 pb-4 sm:px-4">
            {/* Measured without the padding around it: a page as wide as the
                padded box would stick out past the screen's edge on a phone. */}
            <div ref={containerRef} className="w-full">
                {status === 'error' ? (
                    <p role="alert" className="p-6 text-center text-sm text-red-700">
                        This score couldn’t be shown.
                    </p>
                ) : null}
                {status === 'loading' ? (
                    <p role="status" className="p-6 text-center text-sm text-ink-muted">
                        Loading the score…
                    </p>
                ) : null}
                {doc && width > 0
                    ? pageSizes.map((size, index) => (
                          <PageCanvas
                              key={index}
                              doc={doc}
                              index={index}
                              size={size}
                              width={width}
                              marks={byPage.get(index) ?? EMPTY}
                          />
                      ))
                    : null}
            </div>
        </div>
    );
};

const EMPTY: Annotation[] = [];

interface PageCanvasProps {
    doc: PDFDocumentProxy;
    index: number;
    size: PageSize;
    width: number;
    marks: readonly Annotation[];
}

const PageCanvas = memo(({ doc, index, size, width, marks }: PageCanvasProps) => {
    const pdfRef = useRef<HTMLCanvasElement | null>(null);
    const inkRef = useRef<HTMLCanvasElement | null>(null);
    const cache = useMemo(() => new StrokePathCache(), []);
    const height = Math.round((width * size.height) / size.width);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const bitmapW = Math.floor(width * dpr);
    const bitmapH = Math.floor(height * dpr);

    useEffect(() => {
        const canvas = pdfRef.current;
        if (!canvas) {
            return;
        }
        let cancelled = false;
        let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
        void (async () => {
            try {
                const page = await doc.getPage(index + 1);
                if (cancelled) {
                    return;
                }
                const viewport = page.getViewport({ scale: bitmapW / size.width });
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    return;
                }
                task = page.render({ canvasContext: ctx, viewport, canvas, background: 'rgba(255,255,255,1)' });
                await task.promise;
            } catch (err) {
                if (!(err instanceof RenderingCancelledException) && !cancelled) {
                    canvas.dataset.renderFailed = '1';
                }
            }
        })();
        return () => {
            cancelled = true;
            task?.cancel();
            canvas.width = 0;
            canvas.height = 0;
        };
    }, [doc, index, size.width, bitmapW]);

    useEffect(() => {
        const canvas = inkRef.current;
        if (!canvas) {
            return;
        }
        canvas.width = bitmapW;
        canvas.height = bitmapH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.clearRect(0, 0, bitmapW, bitmapH);
        for (const mark of marks) {
            drawAnnotation(ctx, mark, bitmapW, bitmapH, cache);
        }
        cache.retainOnly(new Set(marks.map((m) => m.id)));
    }, [marks, bitmapW, bitmapH, cache]);

    return (
        <div
            className="relative mx-auto my-3 bg-white shadow-md"
            style={{ width, height }}
            aria-label={`Page ${index + 1}`}
            role="img"
        >
            <canvas ref={pdfRef} className="absolute inset-0 h-full w-full" />
            <canvas ref={inkRef} className="absolute inset-0 h-full w-full" />
        </div>
    );
});

PageCanvas.displayName = 'PageCanvas';
