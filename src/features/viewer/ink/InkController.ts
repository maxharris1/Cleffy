import { MIN_SELECTION_CSS, rectFromPoints } from '@/features/fingering/selection';
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
import type { LiveInkPublisher } from '@/sync/realtimeChannel';
import { RemoteInkBuffers } from '@/sync/remoteInkBuffers';
import type { InkProgressMsg } from '@/sync/wire';
import { ERASER_RADIUS_CSS, HIGHLIGHT_WIDTH_FACTOR, STROKE_WIDTHS, useViewerStore } from '@/state/store';
import { isTextPayload, type Annotation, type StrokePayload, type TextPayload, type ViewState } from '@/types/models';

export interface TextIntent {
    pageIndex: number;
    nx: number;
    ny: number;
    existing: Annotation | null;
}

export interface FingeringSelection {
    pageIndex: number;
    /** Normalized page rect of the dragged marquee. */
    rect: { x: number; y: number; w: number; h: number };
}

interface LiveStroke {
    strokeId: string;
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

/** Pen-up movement under this many CSS px counts as a tap (text tool). */
const TAP_SLOP_CSS = 6;
/** Decimation threshold in CSS px. */
const DECIMATE_CSS = 0.75;
/** While dragging a text note, commit (and so live-sync) its position at most this often. */
export const TEXT_DRAG_SYNC_MS = 80;

/** Text tool: a press on a text note that may become a drag (tap = edit). */
interface TextDrag {
    annotation: Annotation;
    payload: TextPayload;
    pageIndex: number;
    /** Pointer-down in normalized page coords. */
    startNx: number;
    startNy: number;
    /** Last position committed to the store (null until the first move). */
    committed: { x: number; y: number } | null;
    lastCommitAt: number;
}

/**
 * Orchestrates ink: implements the GestureController's InkDelegate, renders
 * the in-flight stroke on per-page live canvases, repaints committed canvases
 * from the AnnotationStore, and turns completed gestures into store commits.
 * Deliberately framework-free — PdfViewport wires it to React.
 */
export class InkController {
    private live: LiveStroke | null = null;
    /** In-flight fingering marquee (page-anchored drag corners, normalized). */
    private fingeringSel: { pageIndex: number; x0: number; y0: number; x1: number; y1: number } | null = null;
    private textDrag: TextDrag | null = null;
    private downX = 0;
    private downY = 0;
    private moved = false;
    private rafPending = false;
    private pathCache = new StrokePathCache();
    private unsubscribes: Array<() => void> = [];
    private publisher: LiveInkPublisher | null = null;
    private remote = new RemoteInkBuffers();
    private remoteGcTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private opts: {
            store: AnnotationStore;
            registry: CanvasRegistry;
            isReadOnly: () => boolean;
            getView: () => ViewState;
            getLayout: () => DocumentLayout;
            /** Viewport-local coords for a pointer event. */
            toLocal: (e: { clientX: number; clientY: number }) => { x: number; y: number };
            onTextIntent: (intent: TextIntent) => void;
            onFingeringSelect: (selection: FingeringSelection) => void;
            /** A pen/highlighter stroke of THIS writer has been committed to the store. */
            onStrokeCommitted?: (annotation: Annotation) => void;
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
        if (this.remoteGcTimer) {
            clearInterval(this.remoteGcTimer);
            this.remoteGcTimer = null;
        }
        this.live = null;
        this.publisher = null;
    }

    /** Wire the realtime live-ink publisher (cloud documents only). */
    setLivePublisher(publisher: LiveInkPublisher | null): void {
        this.publisher = publisher;
    }

    /** A collaborator's live ink batch arrived — buffer and repaint its page. */
    applyRemoteInk(msg: InkProgressMsg): void {
        const page = this.remote.apply(msg);
        if (page !== null) {
            this.renderPageLive(page);
        }
        if (!this.remoteGcTimer && this.remote.size > 0) {
            this.remoteGcTimer = setInterval(() => {
                for (const affected of this.remote.expire()) {
                    this.renderPageLive(affected);
                }
                if (this.remote.size === 0 && this.remoteGcTimer) {
                    clearInterval(this.remoteGcTimer);
                    this.remoteGcTimer = null;
                }
            }, 5000);
        }
    }

    /** The committed row for a live stroke landed — drop the preview. */
    remoteInkCommitted(strokeId: string): void {
        const page = this.remote.removeByStrokeId(strokeId);
        if (page !== null) {
            this.renderPageLive(page);
        }
    }

    /** Reconnect: stale previews would linger forever — clear them all. */
    clearRemoteInk(): void {
        for (const page of this.remote.clear()) {
            this.renderPageLive(page);
        }
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
        // The fingering tool only selects a region (never writes), so view-only
        // members may use it and a single finger may drag the marquee.
        if (tool !== 'fingering') {
            if (this.opts.isReadOnly()) {
                return false;
            }
            if (e.pointerType === 'touch' && !fingerDraws) {
                return false;
            }
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

        if (tool === 'fingering') {
            this.fingeringSel = {
                pageIndex: point.pageIndex,
                x0: point.nx,
                y0: point.ny,
                x1: point.nx,
                y1: point.ny,
            };
            this.scheduleLiveRender();
            return;
        }
        if (tool === 'eraser') {
            this.opts.store.beginBatch();
            this.eraseAt(point.pageIndex, point.nx, point.ny);
            return;
        }
        if (tool === 'text') {
            // Resolved on pointer-up: a tap edits, a drag on an existing note moves it.
            const existing = this.findTextAt(point.pageIndex, point.nx, point.ny);
            if (existing && isTextPayload(existing.payload)) {
                this.textDrag = {
                    annotation: existing,
                    payload: existing.payload,
                    pageIndex: point.pageIndex,
                    startNx: point.nx,
                    startNy: point.ny,
                    committed: null,
                    lastCommitAt: 0,
                };
            }
            return;
        }

        const isHighlight = tool === 'highlighter';
        const baseWidth = STROKE_WIDTHS[widthKey] * (isHighlight ? HIGHLIGHT_WIDTH_FACTOR : 1);
        this.live = {
            strokeId: crypto.randomUUID(),
            pageIndex: point.pageIndex,
            kind: isHighlight ? 'highlight' : 'stroke',
            color,
            w: baseWidth,
            pts: [point.nx, point.ny, this.pressureOf(e)],
            predicted: [],
            simulatePressure: e.pointerType !== 'pen',
        };
        this.publisher?.start({
            strokeId: this.live.strokeId,
            page: point.pageIndex,
            kind: this.live.kind,
            color,
            w: baseWidth,
        });
        this.publisher?.append(this.live.pts);
        this.scheduleLiveRender();
    }

    private onMove(e: PointerEvent): void {
        const { x, y } = this.opts.toLocal(e);
        if (Math.hypot(x - this.downX, y - this.downY) > TAP_SLOP_CSS) {
            this.moved = true;
        }

        const tool = useViewerStore.getState().tool;
        if (tool === 'fingering') {
            const sel = this.fingeringSel;
            const layout = sel ? this.opts.getLayout().layouts[sel.pageIndex] : undefined;
            if (sel && layout) {
                // Clamp to the anchor page, like an in-flight stroke.
                const p = viewportToPageClamped(this.opts.getView(), layout, x, y);
                if (p) {
                    sel.x1 = p.nx;
                    sel.y1 = p.ny;
                    this.scheduleLiveRender();
                }
            }
            return;
        }
        if (tool === 'eraser') {
            const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
            if (point) {
                this.eraseAt(point.pageIndex, point.nx, point.ny);
            }
            return;
        }
        if (tool === 'text') {
            if (this.textDrag && this.moved) {
                this.moveTextTo(this.textDrag, x, y, false);
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
        const appended: number[] = [];
        for (const ev of events.length > 0 ? events : [e]) {
            const local = this.opts.toLocal(ev);
            const p = viewportToPageClamped(view, layout, local.x, local.y);
            if (p) {
                appended.push(p.nx, p.ny, this.pressureOf(ev));
            }
        }
        if (appended.length > 0) {
            this.live.pts.push(...appended);
            this.publisher?.append(appended);
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
        if (tool === 'fingering') {
            const sel = this.fingeringSel;
            this.fingeringSel = null;
            if (!sel) {
                return;
            }
            this.renderPageLive(sel.pageIndex);
            const layout = this.opts.getLayout().layouts[sel.pageIndex];
            if (!this.moved || !layout) {
                return;
            }
            const view = this.opts.getView();
            const rect = rectFromPoints(sel.x0, sel.y0, sel.x1, sel.y1);
            // Reject accidental slivers (threshold in CSS px at current zoom).
            const minW = MIN_SELECTION_CSS / (layout.width * view.scale);
            const minH = MIN_SELECTION_CSS / (layout.height * view.scale);
            if (rect.w < minW || rect.h < minH) {
                return;
            }
            this.opts.onFingeringSelect({ pageIndex: sel.pageIndex, rect });
            return;
        }
        if (tool === 'eraser') {
            this.opts.store.endBatch();
            return;
        }
        if (tool === 'text') {
            const drag = this.textDrag;
            this.textDrag = null;
            const { x, y } = this.opts.toLocal(e);
            if (drag && this.moved) {
                // Final position, then close the single undo step.
                this.moveTextTo(drag, x, y, true);
                if (drag.committed) {
                    this.opts.store.endBatch();
                }
                return;
            }
            if (!this.moved) {
                const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
                if (point) {
                    this.opts.onTextIntent({
                        pageIndex: point.pageIndex,
                        nx: point.nx,
                        ny: point.ny,
                        existing: drag?.annotation ?? this.findTextAt(point.pageIndex, point.nx, point.ny),
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
        this.publisher?.end();
        this.renderPageLive(live.pageIndex);

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
        // The live strokeId becomes the annotation id, so collaborators can
        // atomically swap the streamed preview for the committed stroke.
        const annotation: Annotation = {
            id: live.strokeId,
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
        };
        // Commit first; only then may print conversion consider the stroke.
        void this.opts.store.create(annotation).then(() => this.opts.onStrokeCommitted?.(annotation));
    }

    private onCancel(): void {
        if (this.live) {
            const page = this.live.pageIndex;
            this.live = null;
            this.publisher?.cancel();
            this.renderPageLive(page);
        }
        if (this.fingeringSel) {
            const page = this.fingeringSel.pageIndex;
            this.fingeringSel = null;
            this.renderPageLive(page);
        }
        if (this.textDrag) {
            // The note stays where it was last committed; just close the step.
            if (this.textDrag.committed) {
                this.opts.store.endBatch();
            }
            this.textDrag = null;
        }
        if (useViewerStore.getState().tool === 'eraser') {
            this.opts.store.endBatch();
        }
    }

    /**
     * Drag a text note: patch x/y (text and size untouched) from the pointer
     * delta since press. Every commit inside the drag is one store update, so
     * peers see the note move live; they all sit in ONE undo batch, so Cmd+Z
     * puts the note straight back. Commits are throttled unless `final`.
     */
    private moveTextTo(drag: TextDrag, x: number, y: number, final: boolean): void {
        const layout = this.opts.getLayout().layouts[drag.pageIndex];
        if (!layout) {
            return;
        }
        const point = viewportToPageClamped(this.opts.getView(), layout, x, y);
        if (!point) {
            return;
        }
        const now = Date.now();
        if (!final && now - drag.lastCommitAt < TEXT_DRAG_SYNC_MS) {
            return;
        }
        const next = {
            x: Math.min(1, Math.max(0, drag.payload.x + (point.nx - drag.startNx))),
            y: Math.min(1, Math.max(0, drag.payload.y + (point.ny - drag.startNy))),
        };
        if (drag.committed && drag.committed.x === next.x && drag.committed.y === next.y) {
            return;
        }
        if (!drag.committed) {
            this.opts.store.beginBatch();
        }
        drag.committed = next;
        drag.lastCommitAt = now;
        void this.opts.store.update(drag.annotation.id, { payload: { ...drag.payload, ...next } });
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
        // Pick radius: CSS px (from Size control) → bitmap px.
        const eraserCss = ERASER_RADIUS_CSS[useViewerStore.getState().widthKey];
        const radiusPx = (eraserCss / (layout.width * view.scale)) * canvases.committed.width;
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
        if (this.live) {
            this.renderPageLive(this.live.pageIndex);
        }
        if (this.fingeringSel) {
            this.renderPageLive(this.fingeringSel.pageIndex);
        }
    }

    /** Repaint a page's live canvas: local in-flight stroke + remote previews. */
    renderPageLive(pageIndex: number): void {
        const canvases = this.opts.registry.get(pageIndex);
        if (!canvases || canvases.live.width === 0) {
            return;
        }
        const ctx = canvases.live.getContext('2d');
        if (!ctx) {
            return;
        }
        const { width, height } = canvases.live;
        ctx.clearRect(0, 0, width, height);

        const drawInk = (
            pts: number[],
            w: number,
            color: string,
            kind: 'stroke' | 'highlight',
            simulatePressure: boolean,
        ) => {
            if (pts.length < 3) {
                return;
            }
            const payload: StrokePayload = { pts, w };
            if (simulatePressure) {
                payload.sp = 1;
            }
            const path = buildStrokePath(payload, width, height);
            ctx.save();
            if (kind === 'highlight') {
                ctx.globalAlpha = HIGHLIGHT_ALPHA;
                ctx.globalCompositeOperation = 'multiply';
            }
            ctx.fillStyle = color;
            ctx.fill(path);
            ctx.restore();
        };

        for (const remote of this.remote.forPage(pageIndex)) {
            // Remote pressure fidelity is already baked into the points.
            drawInk(remote.pts, remote.w, remote.color, remote.kind, false);
        }

        const live = this.live;
        if (live && live.pageIndex === pageIndex) {
            const pts = live.predicted.length > 0 ? [...live.pts, ...live.predicted] : live.pts;
            drawInk(pts, live.w, live.color, live.kind, live.simulatePressure);
        }

        const sel = this.fingeringSel;
        if (sel && sel.pageIndex === pageIndex) {
            const x = Math.min(sel.x0, sel.x1) * width;
            const y = Math.min(sel.y0, sel.y1) * height;
            const w = Math.abs(sel.x1 - sel.x0) * width;
            const h = Math.abs(sel.y1 - sel.y0) * height;
            ctx.save();
            // Accent marquee (canvas can't read CSS tokens — keep in sync with --color-accent).
            ctx.fillStyle = 'rgba(67, 56, 202, 0.08)';
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = '#4338ca';
            ctx.lineWidth = Math.max(1, width / 700);
            ctx.setLineDash([width / 120, width / 200]);
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
        }
    }
}
