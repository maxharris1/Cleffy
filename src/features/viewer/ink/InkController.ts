import {
    decimateStroke,
    viewportToPageClamped,
    viewportToPagePoint,
    type DocumentLayout,
} from '@/features/viewer/geometry';
import { hitTestPage } from '@/features/viewer/ink/hitTest';
import {
    buildStrokePath,
    drawAnnotation,
    HIGHLIGHT_ALPHA,
    StrokePathCache,
} from '@/features/viewer/ink/strokeRenderer';
import type { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import type { InkDelegate } from '@/features/viewer/ink/GestureController';
import type { AnnotationStore } from '@/sync/annotationStore';
import { HIGHLIGHT_WIDTH_FACTOR, STROKE_WIDTHS, useViewerStore } from '@/state/store';
import type { Annotation, StrokePayload, ViewState } from '@/types/models';

export interface TextIntent {
    pageIndex: number;
    nx: number;
    ny: number;
    existing: Annotation | null;
}

interface LiveStroke {
    pageIndex: number;
    kind: 'stroke' | 'highlight';
    color: string;
    /** Normalized width (fraction of page width). */
    w: number;
    /** Flat normalized [x,y,p,…] including coalesced points. */
    pts: number[];
    /** Predicted tail (rendered, never committed). */
    predicted: number[];
    simulatePressure: boolean;
}

/** Eraser pick radius in CSS px at current zoom. */
const ERASER_RADIUS_CSS = 12;
/** Pen-up movement under this many CSS px counts as a tap (text tool). */
const TAP_SLOP_CSS = 6;
/** Decimation threshold in CSS px. */
const DECIMATE_CSS = 0.75;

/**
 * Orchestrates ink: implements the GestureController's InkDelegate, renders
 * the in-flight stroke on per-page live canvases, repaints committed canvases
 * from the AnnotationStore, and turns completed gestures into store commits.
 * Deliberately framework-free — PdfViewport wires it to React.
 */
export class InkController {
    private live: LiveStroke | null = null;
    private downX = 0;
    private downY = 0;
    private moved = false;
    private rafPending = false;
    private pathCache = new StrokePathCache();
    private unsubscribes: Array<() => void> = [];

    constructor(
        private opts: {
            store: AnnotationStore;
            registry: CanvasRegistry;
            getView: () => ViewState;
            getLayout: () => DocumentLayout;
            /** Viewport-local coords for a pointer event. */
            toLocal: (e: { clientX: number; clientY: number }) => { x: number; y: number };
            onTextIntent: (intent: TextIntent) => void;
        },
    ) {
        this.unsubscribes = [
            opts.store.subscribe((pageIndex) => this.repaintPage(pageIndex)),
            opts.registry.onRegister((pageIndex) => this.repaintPage(pageIndex)),
        ];
    }

    destroy(): void {
        for (const unsubscribe of this.unsubscribes) {
            unsubscribe();
        }
        this.live = null;
    }

    /** Redraw every committed stroke of a page onto its committed canvas. */
    repaintPage(pageIndex: number): void {
        const canvases = this.opts.registry.get(pageIndex);
        if (!canvases) {
            return;
        }
        const { committed } = canvases;
        const ctx = committed.getContext('2d');
        if (!ctx || committed.width === 0) {
            return;
        }
        ctx.clearRect(0, 0, committed.width, committed.height);
        for (const annotation of this.opts.store.getPage(pageIndex).values()) {
            drawAnnotation(ctx, annotation, committed.width, committed.height, this.pathCache);
        }
    }

    // ---- InkDelegate ----------------------------------------------------

    readonly delegate: InkDelegate = {
        shouldInk: (e) => this.shouldInk(e),
        onInkDown: (e) => this.onDown(e),
        onInkMove: (e) => this.onMove(e),
        onInkUp: (e) => this.onUp(e),
        onInkCancel: () => this.onCancel(),
    };

    private shouldInk(e: PointerEvent): boolean {
        const { tool, fingerDraws } = useViewerStore.getState();
        if (tool === 'pan') {
            return false;
        }
        if (e.pointerType === 'touch' && !fingerDraws) {
            return false;
        }
        // Only claim the pointer when it lands on a page.
        const { x, y } = this.opts.toLocal(e);
        return viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y) !== null;
    }

    private onDown(e: PointerEvent): void {
        const { tool, color, widthKey } = useViewerStore.getState();
        const { x, y } = this.opts.toLocal(e);
        const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
        if (!point) {
            return;
        }
        this.downX = x;
        this.downY = y;
        this.moved = false;

        if (tool === 'eraser') {
            this.opts.store.beginBatch();
            this.eraseAt(point.pageIndex, point.nx, point.ny);
            return;
        }
        if (tool === 'text') {
            // Resolved on pointer-up (tap vs drag).
            return;
        }

        const isHighlight = tool === 'highlighter';
        const baseWidth = STROKE_WIDTHS[widthKey] * (isHighlight ? HIGHLIGHT_WIDTH_FACTOR : 1);
        this.live = {
            pageIndex: point.pageIndex,
            kind: isHighlight ? 'highlight' : 'stroke',
            color,
            w: baseWidth,
            pts: [point.nx, point.ny, this.pressureOf(e)],
            predicted: [],
            simulatePressure: e.pointerType !== 'pen',
        };
        this.scheduleLiveRender();
    }

    private onMove(e: PointerEvent): void {
        const { x, y } = this.opts.toLocal(e);
        if (Math.hypot(x - this.downX, y - this.downY) > TAP_SLOP_CSS) {
            this.moved = true;
        }

        const tool = useViewerStore.getState().tool;
        if (tool === 'eraser') {
            const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
            if (point) {
                this.eraseAt(point.pageIndex, point.nx, point.ny);
            }
            return;
        }
        if (!this.live) {
            return;
        }

        const layout = this.opts.getLayout().layouts[this.live.pageIndex];
        if (!layout) {
            return;
        }
        const view = this.opts.getView();

        // Full-fidelity input: coalesced events where supported.
        const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
        for (const ev of events.length > 0 ? events : [e]) {
            const local = this.opts.toLocal(ev);
            const p = viewportToPageClamped(view, layout, local.x, local.y);
            if (p) {
                this.live.pts.push(p.nx, p.ny, this.pressureOf(ev));
            }
        }

        // Predicted tail — drawn this frame, discarded from the committed stroke.
        this.live.predicted = [];
        if (typeof e.getPredictedEvents === 'function') {
            for (const ev of e.getPredictedEvents()) {
                const local = this.opts.toLocal(ev);
                const p = viewportToPageClamped(view, layout, local.x, local.y);
                if (p) {
                    this.live.predicted.push(p.nx, p.ny, this.pressureOf(ev));
                }
            }
        }

        this.scheduleLiveRender();
    }

    private onUp(e: PointerEvent): void {
        const tool = useViewerStore.getState().tool;
        if (tool === 'eraser') {
            this.opts.store.endBatch();
            return;
        }
        if (tool === 'text') {
            if (!this.moved) {
                const { x, y } = this.opts.toLocal(e);
                const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
                if (point) {
                    this.opts.onTextIntent({
                        pageIndex: point.pageIndex,
                        nx: point.nx,
                        ny: point.ny,
                        existing: this.findTextAt(point.pageIndex, point.nx, point.ny),
                    });
                }
            }
            return;
        }

        const live = this.live;
        this.live = null;
        if (!live) {
            return;
        }
        this.clearLiveCanvas(live.pageIndex);

        const layout = this.opts.getLayout().layouts[live.pageIndex];
        const view = this.opts.getView();
        if (!layout) {
            return;
        }
        // Decimate in normalized-x units (CSS px threshold at current zoom).
        const minDist = DECIMATE_CSS / (layout.width * view.scale);
        const pts = decimateStroke(live.pts, minDist);
        if (pts.length < 3) {
            return;
        }

        const now = new Date().toISOString();
        const payload: StrokePayload = { pts, w: live.w };
        if (live.simulatePressure) {
            payload.sp = 1;
        }
        void this.opts.store.create({
            id: crypto.randomUUID(),
            docId: this.opts.store.docId,
            page: live.pageIndex,
            kind: live.kind,
            color: live.color,
            payload,
            createdBy: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            seq: 0,
        });
    }

    private onCancel(): void {
        if (this.live) {
            this.clearLiveCanvas(this.live.pageIndex);
            this.live = null;
        }
        if (useViewerStore.getState().tool === 'eraser') {
            this.opts.store.endBatch();
        }
    }

    // ---- internals ------------------------------------------------------

    private pressureOf(e: PointerEvent): number {
        // Mouse reports 0.5 while down; pens report real pressure (0 on some
        // hover/misfires — clamp into a sane inking range).
        return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
    }

    private findTextAt(pageIndex: number, nx: number, ny: number): Annotation | null {
        const canvases = this.opts.registry.get(pageIndex);
        const pageWpx = canvases?.committed.width ?? 1000;
        const pageHpx = canvases?.committed.height ?? 1400;
        const hits = hitTestPage(this.opts.store.getPage(pageIndex).values(), nx, ny, 4, pageWpx, pageHpx);
        return hits.find((h) => h.kind === 'text') ?? null;
    }

    private eraseAt(pageIndex: number, nx: number, ny: number): void {
        const canvases = this.opts.registry.get(pageIndex);
        if (!canvases || canvases.committed.width === 0) {
            return;
        }
        const view = this.opts.getView();
        const layout = this.opts.getLayout().layouts[pageIndex];
        if (!layout) {
            return;
        }
        // Pick radius: CSS px → bitmap px.
        const radiusPx = (ERASER_RADIUS_CSS / (layout.width * view.scale)) * canvases.committed.width;
        const hits = hitTestPage(
            this.opts.store.getPage(pageIndex).values(),
            nx,
            ny,
            radiusPx,
            canvases.committed.width,
            canvases.committed.height,
        );
        for (const hit of hits) {
            void this.opts.store.delete(hit.id);
        }
    }

    private scheduleLiveRender(): void {
        if (this.rafPending) {
            return;
        }
        this.rafPending = true;
        requestAnimationFrame(() => {
            this.rafPending = false;
            this.renderLive();
        });
    }

    private renderLive(): void {
        const live = this.live;
        if (!live) {
            return;
        }
        const canvases = this.opts.registry.get(live.pageIndex);
        if (!canvases || canvases.live.width === 0) {
            return;
        }
        const ctx = canvases.live.getContext('2d');
        if (!ctx) {
            return;
        }
        const { width, height } = canvases.live;
        ctx.clearRect(0, 0, width, height);

        const payload: StrokePayload = {
            pts: live.predicted.length > 0 ? [...live.pts, ...live.predicted] : live.pts,
            w: live.w,
        };
        if (live.simulatePressure) {
            payload.sp = 1;
        }
        const path = buildStrokePath(payload, width, height);
        ctx.save();
        if (live.kind === 'highlight') {
            ctx.globalAlpha = HIGHLIGHT_ALPHA;
            ctx.globalCompositeOperation = 'multiply';
        }
        ctx.fillStyle = live.color;
        ctx.fill(path);
        ctx.restore();
    }

    private clearLiveCanvas(pageIndex: number): void {
        const canvases = this.opts.registry.get(pageIndex);
        const ctx = canvases?.live.getContext('2d');
        if (canvases && ctx) {
            ctx.clearRect(0, 0, canvases.live.width, canvases.live.height);
        }
    }
}
