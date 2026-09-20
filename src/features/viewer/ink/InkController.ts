import { MIN_SELECTION_CSS, rectFromPoints } from '@/features/fingering/selection';
import { MIN_TEXT_SIZE, measureInkText } from '@/features/import/textFit';
import {
    decimateStroke,
    viewportToPageClamped,
    viewportToPagePoint,
    type Bbox,
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
import { maxTextSizeFor, onMusicFontReady, textBoundsNorm, textDrawSpec } from '@/features/viewer/ink/musicFont';
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
export const TEXT_DRAG_SYNC_MS = 250;

/** Pick radius (CSS px) around the selection's resize handle. */
export const RESIZE_HANDLE_HIT_CSS = 14;
/** Drawn size of the resize handle (CSS px). */
const RESIZE_HANDLE_CSS = 10;
/** Selection box padding (CSS px). */
const SELECTION_PAD_CSS = 4;

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
 * Text tool: scaling the selected note — by its corner handle or a pinch.
 * `payload.size` changes; x/y (the top-left anchor) stay put so the note
 * grows away from its anchor instead of jumping.
 */
interface TextScale {
    annotation: Annotation;
    payload: TextPayload;
    pageIndex: number;
    /** Size when the gesture began; pinch factors accumulate against it. */
    startSize: number;
    /** Handle drag only: anchor and initial handle, page-WIDTH units (y × aspect). */
    anchor: { x: number; y: number } | null;
    handleDist: number;
    /** Running pinch factor. */
    factor: number;
    /** Last size committed (null until the first change). */
    committed: number | null;
    lastCommitAt: number;
}

/** The selected text note, for drawing and for tests. */
export interface TextSelection {
    id: string;
    pageIndex: number;
    /** Glyph bounds, normalized page coords. */
    bounds: Bbox;
    /** Resize handle (bottom-right corner), normalized page coords. */
    handle: { nx: number; ny: number };
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
    private textScale: TextScale | null = null;
    /** Text tool: the note last pressed — shows a box + resize handle until deselected. */
    private selectedText: { id: string; pageIndex: number } | null = null;
    /** Open gesture undo frame (eraser / text drag / pinch). Convert uses its own handle. */
    private openBatch: ReturnType<AnnotationStore['beginBatch']> | null = null;
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
            opts.store.subscribe((pageIndex) => {
                this.repaintPage(pageIndex);
                const selected = this.selectedText;
                if (selected && selected.pageIndex === pageIndex) {
                    // The note moved, resized, or vanished (eraser, undo, peer).
                    const live = opts.store.get(selected.id);
                    if (!live || live.deletedAt || !isTextPayload(live.payload)) {
                        this.selectedText = null;
                    }
                    this.renderPageLive(pageIndex);
                }
            }),
            opts.registry.onRegister((pageIndex) => this.repaintPage(pageIndex)),
            // Selection belongs to the text tool; switching tools drops it.
            useViewerStore.subscribe((state, prev) => {
                if (state.tool !== prev.tool && state.tool !== 'text') {
                    this.clearTextSelection();
                }
            }),
            // Converted symbols were drawn as fallback text until the music face arrived.
            onMusicFontReady(() => {
                for (const pageIndex of opts.registry.pageIndices()) {
                    this.repaintPage(pageIndex);
                }
            }),
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
        onPinch: (factor) => this.onPinch(factor),
        onPinchEnd: () => this.onPinchEnd(),
        canPinch: () => this.canPinch(),
        onPromoteToPinch: () => this.onPromoteToPinch(),
    };

    /** The text note currently selected with the text tool, or null. */
    getTextSelection(): TextSelection | null {
        const selected = this.selectedText;
        if (!selected) {
            return null;
        }
        const live = this.opts.store.get(selected.id);
        const layout = this.opts.getLayout().layouts[selected.pageIndex];
        if (!live || live.deletedAt || !isTextPayload(live.payload) || !layout) {
            return null;
        }
        const bounds = textBoundsNorm(live.payload, layout.height / layout.width);
        return { id: live.id, pageIndex: selected.pageIndex, bounds, handle: { nx: bounds[2], ny: bounds[3] } };
    }

    clearTextSelection(): void {
        const selected = this.selectedText;
        if (!selected) {
            return;
        }
        this.selectedText = null;
        this.renderPageLive(selected.pageIndex);
    }

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
            this.startUndoBatch();
            this.eraseAt(point.pageIndex, point.nx, point.ny);
            return;
        }
        if (tool === 'text') {
            // The selected note's corner handle wins over anything under it.
            const scale = this.beginHandleScale(x, y);
            if (scale) {
                this.textScale = scale;
                return;
            }
            // Otherwise resolved on pointer-up: a tap edits, a drag on an
            // existing note moves it; either way the note becomes selected.
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
                this.selectText(existing.id, point.pageIndex);
            }
            // Miss: keep the selection so a second Finger-draw touch can still
            // pinch-resize. A tap-up on empty paper deselects in `onUp`.
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
            if (this.textScale && this.moved) {
                this.scaleTextToHandle(this.textScale, x, y, false);
            } else if (this.textDrag && this.moved) {
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
            this.finishUndoBatch();
            return;
        }
        if (tool === 'text') {
            const drag = this.textDrag;
            this.textDrag = null;
            const { x, y } = this.opts.toLocal(e);
            const scale = this.textScale;
            if (scale) {
                this.textScale = null;
                if (this.moved) {
                    this.scaleTextToHandle(scale, x, y, true);
                }
                this.endTextScale();
                return;
            }
            if (drag && this.moved) {
                // Final position, then close the single undo step.
                this.moveTextTo(drag, x, y, true);
                this.finishUndoBatch();
                return;
            }
            if (!this.moved) {
                const point = viewportToPagePoint(this.opts.getView(), this.opts.getLayout().layouts, x, y);
                if (point) {
                    const existing = drag?.annotation ?? this.findTextAt(point.pageIndex, point.nx, point.ny);
                    if (!existing) {
                        this.clearTextSelection();
                    }
                    this.opts.onTextIntent({
                        pageIndex: point.pageIndex,
                        nx: point.nx,
                        ny: point.ny,
                        existing,
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
            this.finishUndoBatch();
            this.textDrag = null;
        }
        if (this.textScale) {
            const scale = this.textScale;
            this.textScale = null;
            if (scale.anchor === null) {
                this.commitTextSize(scale, scale.startSize * scale.factor, true);
            }
            this.endTextScale();
        }
        if (useViewerStore.getState().tool === 'eraser') {
            this.finishUndoBatch();
        }
    }

    /**
     * Finger-draw first touch is becoming a pinch. Keep any drag undo frame
     * open so move + resize is one Cmd+Z; do not deselect.
     */
    private onPromoteToPinch(): void {
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
        this.textDrag = null;
        this.moved = true;
    }

    // ---- text selection: scale by handle or pinch -------------------------

    private selectText(id: string, pageIndex: number): void {
        const prev = this.selectedText;
        this.selectedText = { id, pageIndex };
        if (prev && prev.pageIndex !== pageIndex) {
            this.renderPageLive(prev.pageIndex);
        }
        this.renderPageLive(pageIndex);
    }

    /** Selection handle in viewport CSS coords, or null when nothing is selected/visible. */
    private handleCss(selection: TextSelection): { x: number; y: number } | null {
        const layout = this.opts.getLayout().layouts[selection.pageIndex];
        if (!layout) {
            return null;
        }
        const view = this.opts.getView();
        return {
            x: (layout.left + selection.handle.nx * layout.width) * view.scale - view.scrollX,
            y: (layout.top + selection.handle.ny * layout.height) * view.scale - view.scrollY,
        };
    }

    /** Pointer-down at viewport (x, y): a scale gesture if it lands on the selected note's handle. */
    private beginHandleScale(x: number, y: number): TextScale | null {
        const selection = this.getTextSelection();
        if (!selection) {
            return null;
        }
        const handle = this.handleCss(selection);
        if (!handle || Math.hypot(x - handle.x, y - handle.y) > RESIZE_HANDLE_HIT_CSS) {
            return null;
        }
        const live = this.opts.store.get(selection.id);
        const layout = this.opts.getLayout().layouts[selection.pageIndex];
        if (!live || !isTextPayload(live.payload) || !layout) {
            return null;
        }
        const aspect = layout.height / layout.width;
        const [minX, minY, maxX, maxY] = selection.bounds;
        const anchor = { x: minX, y: minY * aspect };
        return {
            annotation: live,
            payload: live.payload,
            pageIndex: selection.pageIndex,
            startSize: live.payload.size,
            anchor,
            handleDist: Math.max(1e-6, Math.hypot(maxX - anchor.x, maxY * aspect - anchor.y)),
            factor: 1,
            committed: null,
            lastCommitAt: 0,
        };
    }

    /** Handle drag: the note scales so its far corner follows the pointer, anchored at its top-left. */
    private scaleTextToHandle(scale: TextScale, x: number, y: number, final: boolean): void {
        const layout = this.opts.getLayout().layouts[scale.pageIndex];
        if (!layout || !scale.anchor) {
            return;
        }
        const point = viewportToPageClamped(this.opts.getView(), layout, x, y);
        if (!point) {
            return;
        }
        const aspect = layout.height / layout.width;
        const dist = Math.hypot(point.nx - scale.anchor.x, point.ny * aspect - scale.anchor.y);
        this.commitTextSize(scale, scale.startSize * (dist / scale.handleDist), final);
    }

    /**
     * Commit a new size — clamped to the note's range — as one store update.
     * Live fields (`text`, `hw`, `color` via payload) are read from the store
     * so a peer edit during the gesture is not clobbered. Size grows about the
     * visual top-left (payload `y` is shifted by `topInset`). Throttled unless
     * `final`.
     */
    private commitTextSize(scale: TextScale, rawSize: number, final: boolean): void {
        const now = Date.now();
        if (!final && now - scale.lastCommitAt < TEXT_DRAG_SYNC_MS) {
            return;
        }
        const livePayload = this.liveTextPayload(scale.annotation.id, scale.payload);
        const size = Math.min(maxTextSizeFor(livePayload), Math.max(MIN_TEXT_SIZE, rawSize));
        if (scale.committed === size || (scale.committed === null && size === scale.payload.size)) {
            return;
        }
        if (scale.committed === null) {
            this.startUndoBatch();
        }
        scale.committed = size;
        scale.lastCommitAt = now;
        const layout = this.opts.getLayout().layouts[scale.pageIndex];
        const aspect = layout ? layout.height / layout.width : 1;
        const spec = textDrawSpec(livePayload.text, livePayload.hw === 1);
        const metrics = measureInkText(spec.glyphs, { family: spec.family, style: spec.style });
        const y = scale.payload.y + (metrics.topInset * (scale.payload.size - size)) / aspect;
        void this.opts.store.update(scale.annotation.id, {
            payload: { ...livePayload, size, y: Math.min(1, Math.max(0, y)) },
        });
    }

    private endTextScale(): void {
        this.finishUndoBatch();
    }

    private startUndoBatch(): void {
        this.openBatch ??= this.opts.store.beginBatch();
    }

    private finishUndoBatch(): void {
        if (this.openBatch === null) {
            return;
        }
        this.opts.store.endBatch(this.openBatch);
        this.openBatch = null;
    }

    /** Two-finger pinch: claimed while a text note is selected; never steals a handle drag. */
    private canPinch(): boolean {
        return (
            useViewerStore.getState().tool === 'text' &&
            !this.opts.isReadOnly() &&
            this.selectedText !== null &&
            this.textScale?.anchor == null
        );
    }

    /** Two-finger pinch: claimed (returns true) while a text note is selected with the text tool. */
    private onPinch(factor: number): boolean {
        if (!this.canPinch()) {
            return false;
        }
        let scale = this.textScale;
        if (scale?.anchor) {
            return false;
        }
        if (!scale) {
            const selection = this.getTextSelection();
            const live = selection ? this.opts.store.get(selection.id) : undefined;
            if (!selection || !live || !isTextPayload(live.payload)) {
                return false;
            }
            scale = {
                annotation: live,
                payload: live.payload,
                pageIndex: selection.pageIndex,
                startSize: live.payload.size,
                anchor: null,
                handleDist: 1,
                factor: 1,
                committed: null,
                lastCommitAt: 0,
            };
            this.textScale = scale;
        }
        scale.factor *= factor;
        this.commitTextSize(scale, scale.startSize * scale.factor, false);
        return true;
    }

    private onPinchEnd(): void {
        const scale = this.textScale;
        if (!scale || scale.anchor) {
            return;
        }
        this.textScale = null;
        this.commitTextSize(scale, scale.startSize * scale.factor, true);
        this.endTextScale();
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
        const livePayload = this.liveTextPayload(drag.annotation.id, drag.payload);
        const next = {
            x: Math.min(1, Math.max(0, drag.payload.x + (point.nx - drag.startNx))),
            y: Math.min(1, Math.max(0, drag.payload.y + (point.ny - drag.startNy))),
        };
        if (drag.committed && drag.committed.x === next.x && drag.committed.y === next.y) {
            return;
        }
        if (!drag.committed) {
            this.startUndoBatch();
        }
        drag.committed = next;
        drag.lastCommitAt = now;
        void this.opts.store.update(drag.annotation.id, { payload: { ...livePayload, ...next } });
    }

    // ---- internals ------------------------------------------------------

    private liveTextPayload(id: string, fallback: TextPayload): TextPayload {
        const live = this.opts.store.get(id);
        return live && isTextPayload(live.payload) ? live.payload : fallback;
    }

    private pressureOf(e: PointerEvent): number {
        // Mouse reports 0.5 while down; pens report real pressure (0 on some
        // hover/misfires — clamp into a sane inking range).
        return e.pressure > 0 ? Math.min(1, e.pressure) : 0.5;
    }

    private findTextAt(pageIndex: number, nx: number, ny: number): Annotation | null {
        const canvases = this.opts.registry.get(pageIndex);
        const layout = this.opts.getLayout().layouts[pageIndex];
        const pageWpx = canvases?.committed.width || layout?.width || 1000;
        const pageHpx = canvases?.committed.height || layout?.height || 1400;
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

        const selection = this.getTextSelection();
        if (selection && selection.pageIndex === pageIndex) {
            const layout = this.opts.getLayout().layouts[pageIndex];
            // Bitmap px per CSS px, so the chrome keeps its size at any zoom.
            const pxPerCss = layout ? width / (layout.width * this.opts.getView().scale) : 1;
            const pad = SELECTION_PAD_CSS * pxPerCss;
            const [minX, minY, maxX, maxY] = selection.bounds;
            const x = minX * width - pad;
            const y = minY * height - pad;
            const w = (maxX - minX) * width + 2 * pad;
            const h = (maxY - minY) * height + 2 * pad;
            ctx.save();
            ctx.strokeStyle = '#4338ca';
            ctx.lineWidth = Math.max(1, pxPerCss);
            ctx.setLineDash([4 * pxPerCss, 3 * pxPerCss]);
            ctx.strokeRect(x, y, w, h);
            ctx.setLineDash([]);
            const handle = RESIZE_HANDLE_CSS * pxPerCss;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x + w - handle / 2, y + h - handle / 2, handle, handle);
            ctx.strokeRect(x + w - handle / 2, y + h - handle / 2, handle, handle);
            ctx.restore();
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
