import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { measureIndexAtTick, xAtTickInMeasure } from '@/features/playback/scoreTime';
import { NO_OBSCURED, clampScroll, scrollForPagePoint, type ObscuredEdges } from '@/features/viewer/geometry';
import type { DocumentLayout } from '@/features/viewer/geometry';
import { prefersReducedMotion } from '@/lib/motion';
import { useViewerStore } from '@/state/store';
import type { ViewState } from '@/types/models';
import type { ScoreData } from '@/types/scoreData';

/**
 * The live position indicator: a vertical line sweeping through the current
 * measure plus a soft measure highlight, both absolutely positioned inside
 * PdfViewport's transformed wrapper (they inherit pan/zoom for free; the
 * wrapper's coordinate space is base units × renderScale). Runs its own rAF
 * loop with change detection — no React re-renders at frame rate; only the
 * measure NUMBER lands in zustand, and only when it changes. The loop runs
 * only while something can move: playback, a follow glide, or pages not yet
 * measured. Paused or idle it sleeps, and wake() — a seek (playheadEpoch), a
 * status or follow change, new page geometry from PdfViewport — draws again.
 *
 * Auto-follow: when the playhead's system drifts out of the comfortable
 * viewport band, the view glides so the system sits near the top. A user
 * pan/zoom mid-playback suspends following (the transport offers resume) —
 * suspension is triggered by GestureController callbacks, so the
 * controller's own setView writes can never suspend themselves.
 */

/** Pure position math, unit-tested separately from the DOM. */
export interface PlayheadRect {
    measureIndex: number;
    pageIndex: number;
    /** Normalized x of the sweeping line on its page. */
    x: number;
    /** Normalized measure bounds + system band on the page. */
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

export const playheadRect = (score: ScoreData, tick: number): PlayheadRect | null => {
    const measureIndex = measureIndexAtTick(score.measures, tick);
    const measure = score.measures[measureIndex];
    if (!measure || measure.sys < 0 || measure.page < 0) {
        return null;
    }
    const system = score.systems[measure.sys];
    if (!system) {
        return null;
    }
    return {
        measureIndex,
        pageIndex: measure.page,
        // Rides the engraved chord columns when the analysis provides them.
        x: xAtTickInMeasure(measure, tick),
        x0: measure.x0,
        x1: measure.x1,
        y0: system.y0,
        y1: system.y1,
    };
};

export interface PlayheadDeps {
    getEngine: () => PlaybackEngine | null;
    getScore: () => ScoreData | null;
    lineEl: HTMLElement;
    highlightEl: HTMLElement;
    getLayout: () => DocumentLayout;
    getRenderScale: () => number;
    getViewportSize: () => { width: number; height: number };
    /** Viewport strips under the toolbars: following keeps the system clear of them. */
    getObscured?: () => ObscuredEdges;
    /**
     * Something else places the view (stand mode shows one page whole): the
     * playhead still draws, but following leaves the view alone and a glide
     * under way stops.
     */
    isViewHeld?: () => boolean;
}

/** Viewport band the current system is kept inside while following. */
const FOLLOW_TOP_FRAC = 0.05;
const FOLLOW_BOTTOM_FRAC = 0.85;
/** Where the system lands after a follow scroll. */
const FOLLOW_ANCHOR_Y = 0.12;
const FOLLOW_ANIM_MS = 280;

export class PlayheadController {
    private readonly deps: PlayheadDeps;
    private rafId: number | null = null;
    private disposed = false;

    private lastTick = -1;
    private lastMeasureIndex = -2;
    private lastRenderScale = -1;
    private lastScore: ScoreData | null = null;
    private lastLayout: DocumentLayout | null = null;
    private forceFollow = false;

    private anim: { from: { x: number; y: number }; to: { x: number; y: number }; startedAt: number } | null = null;

    private unsubscribeStore: () => void;

    /** Pages had not been measured on the last draw: keep polling until they are. */
    private awaitingLayout = false;

    constructor(deps: PlayheadDeps) {
        this.deps = deps;
        this.frame = this.frame.bind(this);
        this.rafId = requestAnimationFrame(this.frame);
        // "Resume follow" is just a store write (the transport needs no handle
        // on this controller): suspended → on glides back to the playhead.
        this.unsubscribeStore = useViewerStore.subscribe((state, prev) => {
            if (state.followMode === 'on' && prev.followMode !== 'on') {
                this.forceFollow = true;
            }
            if (
                state.followMode !== prev.followMode ||
                state.playbackStatus !== prev.playbackStatus ||
                state.playheadEpoch !== prev.playheadEpoch
            ) {
                this.wake();
            }
        });
    }

    /** Draw on the next frame, restarting the loop if it is asleep. */
    wake(): void {
        if (!this.disposed && this.rafId === null) {
            this.rafId = requestAnimationFrame(this.frame);
        }
    }

    /** Playing, counting in, or loading samples: the tick can move by itself. */
    private isRunning(): boolean {
        const status = useViewerStore.getState().playbackStatus;
        return status === 'playing' || status === 'counting' || status === 'loading';
    }

    destroy(): void {
        this.disposed = true;
        this.unsubscribeStore();
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    /** Called from gesture callbacks — a real user pan/zoom suspends following. */
    notifyUserGesture(): void {
        this.anim = null;
        const { followMode, playbackStatus, setFollowMode } = useViewerStore.getState();
        if (followMode === 'on' && (playbackStatus === 'playing' || playbackStatus === 'counting')) {
            setFollowMode('suspended');
        }
    }

    private frame(): void {
        this.rafId = null;
        if (this.disposed) {
            return;
        }
        this.draw();
        this.stepFollowAnimation();
        if (this.isRunning() || this.anim !== null || this.awaitingLayout) {
            this.rafId = requestAnimationFrame(this.frame);
        }
    }

    private draw(): void {
        this.awaitingLayout = false;
        const score = this.deps.getScore();
        const { lineEl, highlightEl } = this.deps;
        if (!score) {
            if (this.lastScore) {
                lineEl.style.display = 'none';
                highlightEl.style.display = 'none';
                this.lastScore = null;
            }
            return;
        }
        const engine = this.deps.getEngine();
        const tick = engine ? engine.getPositionTicks() : 0;
        const renderScale = this.deps.getRenderScale();
        const layoutNow = this.deps.getLayout();
        // Page geometry is part of the frame's identity: a paused transport
        // holds one tick forever, so without this the overlays would stay
        // wherever (or hidden) they were when the pages first measured.
        if (
            tick === this.lastTick &&
            renderScale === this.lastRenderScale &&
            score === this.lastScore &&
            layoutNow === this.lastLayout &&
            !this.forceFollow
        ) {
            return;
        }
        this.lastTick = tick;
        this.lastRenderScale = renderScale;
        this.lastScore = score;
        this.lastLayout = layoutNow;

        const rect = playheadRect(score, tick);
        const measureIndex = rect ? rect.measureIndex : measureIndexAtTick(score.measures, tick);
        if (measureIndex !== this.lastMeasureIndex || this.forceFollow) {
            const store = useViewerStore.getState();
            store.setCurrentMeasureIndex(measureIndex >= 0 ? measureIndex : null);
            if (rect && store.followMode === 'on') {
                this.followTo(rect);
            }
            this.lastMeasureIndex = measureIndex;
            this.forceFollow = false;
        }

        if (!rect) {
            lineEl.style.display = 'none';
            highlightEl.style.display = 'none';
            return;
        }
        const layout = layoutNow.layouts[rect.pageIndex];
        this.awaitingLayout = !layout;
        if (!layout) {
            // Pages have not been measured yet (the controller can outrun the
            // PDF's first layout pass). Drop the memo so the next frame retries
            // instead of latching "hidden" until the tick moves.
            this.lastTick = -1;
            this.lastLayout = null;
            lineEl.style.display = 'none';
            highlightEl.style.display = 'none';
            return;
        }

        const x = (layout.left + rect.x * layout.width) * renderScale;
        const top = (layout.top + rect.y0 * layout.height) * renderScale;
        const height = (rect.y1 - rect.y0) * layout.height * renderScale;
        lineEl.style.display = 'block';
        lineEl.style.transform = `translate(${x - 1}px, ${top}px)`; // center the 2px line
        lineEl.style.height = `${height}px`;

        highlightEl.style.display = 'block';
        highlightEl.style.transform = `translate(${(layout.left + rect.x0 * layout.width) * renderScale}px, ${top}px)`;
        highlightEl.style.width = `${(rect.x1 - rect.x0) * layout.width * renderScale}px`;
        highlightEl.style.height = `${height}px`;
    }

    /** Glide the view so the playhead's system sits near the top of the viewport. */
    private followTo(rect: PlayheadRect): void {
        if (this.deps.isViewHeld?.()) {
            this.anim = null;
            return;
        }
        const layout = this.deps.getLayout();
        const pageLayout = layout.layouts[rect.pageIndex];
        if (!pageLayout) {
            return;
        }
        const { width, height } = this.deps.getViewportSize();
        if (width === 0 || height === 0) {
            return;
        }
        const store = useViewerStore.getState();
        const view = store.view;
        // The follow band is the part of the viewport no toolbar covers.
        const obscured = this.deps.getObscured?.() ?? NO_OBSCURED;
        const bandTop = Math.max(0, obscured.top);
        const bandHeight = Math.max(1, height - bandTop - Math.max(0, obscured.bottom));

        const topPx = (pageLayout.top + rect.y0 * pageLayout.height) * view.scale - view.scrollY;
        const bottomPx = (pageLayout.top + rect.y1 * pageLayout.height) * view.scale - view.scrollY;
        const linePx = (pageLayout.left + rect.x * pageLayout.width) * view.scale - view.scrollX;
        const fits =
            topPx >= bandTop + bandHeight * FOLLOW_TOP_FRAC &&
            bottomPx <= bandTop + bandHeight * FOLLOW_BOTTOM_FRAC &&
            linePx >= width * 0.05 &&
            linePx <= width * 0.95;
        if (fits && !this.forceFollow) {
            return;
        }

        const anchorY = (bandTop + bandHeight * FOLLOW_ANCHOR_Y) / height;
        const target = clampScroll(
            scrollForPagePoint(view, pageLayout, rect.x0, rect.y0, width, height, 0.35, anchorY),
            layout,
            width,
            height,
            obscured,
        );
        if (prefersReducedMotion()) {
            // No glide: the view jumps straight to the playhead's system.
            this.anim = null;
            store.setView({ scale: view.scale, scrollX: target.scrollX, scrollY: target.scrollY });
            return;
        }
        this.anim = {
            from: { x: view.scrollX, y: view.scrollY },
            to: { x: target.scrollX, y: target.scrollY },
            startedAt: performance.now(),
        };
    }

    private stepFollowAnimation(): void {
        if (!this.anim) {
            return;
        }
        if (this.deps.isViewHeld?.()) {
            this.anim = null;
            return;
        }
        const store = useViewerStore.getState();
        this.rebaseFollowAnimation(store.view);
        const { from, to, startedAt } = this.anim;
        const t = Math.min(1, (performance.now() - startedAt) / FOLLOW_ANIM_MS);
        const ease = 1 - Math.pow(1 - t, 3);
        store.setView({
            scale: store.view.scale,
            scrollX: from.x + (to.x - from.x) * ease,
            scrollY: from.y + (to.y - from.y) * ease,
        });
        if (t >= 1) {
            this.anim = null;
        }
    }

    /**
     * The scroll bounds moved under a glide (a notice over the score went
     * away, or pages were re-measured): head for the target they allow now,
     * from where the view is, instead of finishing at a stale one. The follow
     * write takes over the viewer's own settle into the new bounds, so this
     * glide must end inside them or the room the notice left stays blank.
     */
    private rebaseFollowAnimation(view: ViewState): void {
        const anim = this.anim;
        const { width, height } = this.deps.getViewportSize();
        if (!anim || width === 0 || height === 0) {
            return;
        }
        const target = clampScroll(
            { scale: view.scale, scrollX: anim.to.x, scrollY: anim.to.y },
            this.deps.getLayout(),
            width,
            height,
            this.deps.getObscured?.() ?? NO_OBSCURED,
        );
        if (Math.abs(target.scrollX - anim.to.x) < 0.5 && Math.abs(target.scrollY - anim.to.y) < 0.5) {
            return;
        }
        this.anim = {
            from: { x: view.scrollX, y: view.scrollY },
            to: { x: target.scrollX, y: target.scrollY },
            startedAt: performance.now(),
        };
    }
}
