import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { fractionWithinMeasure, measureIndexAtTick } from '@/features/playback/scoreTime';
import { clampScroll, scrollForPagePoint } from '@/features/viewer/geometry';
import type { DocumentLayout } from '@/features/viewer/geometry';
import { useViewerStore } from '@/state/store';
import type { ScoreData } from '@/types/scoreData';

/**
 * The live position indicator: a vertical line sweeping through the current
 * measure plus a soft measure highlight, both absolutely positioned inside
 * PdfViewport's transformed wrapper (they inherit pan/zoom for free; the
 * wrapper's coordinate space is base units × renderScale). Runs its own rAF
 * loop with change detection — no React re-renders at frame rate; only the
 * measure NUMBER lands in zustand, and only when it changes.
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
    const frac = fractionWithinMeasure(measure, tick);
    return {
        measureIndex,
        pageIndex: measure.page,
        x: measure.x0 + frac * (measure.x1 - measure.x0),
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
    private forceFollow = false;

    private anim: { from: { x: number; y: number }; to: { x: number; y: number }; startedAt: number } | null = null;

    private unsubscribeStore: () => void;

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
        });
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
        if (this.disposed) {
            return;
        }
        this.draw();
        this.stepFollowAnimation();
        this.rafId = requestAnimationFrame(this.frame);
    }

    private draw(): void {
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
        if (
            tick === this.lastTick &&
            renderScale === this.lastRenderScale &&
            score === this.lastScore &&
            !this.forceFollow
        ) {
            return;
        }
        this.lastTick = tick;
        this.lastRenderScale = renderScale;
        this.lastScore = score;

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
        const layout = this.deps.getLayout().layouts[rect.pageIndex];
        if (!layout) {
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

        const topPx = (pageLayout.top + rect.y0 * pageLayout.height) * view.scale - view.scrollY;
        const bottomPx = (pageLayout.top + rect.y1 * pageLayout.height) * view.scale - view.scrollY;
        const linePx = (pageLayout.left + rect.x * pageLayout.width) * view.scale - view.scrollX;
        const fits =
            topPx >= height * FOLLOW_TOP_FRAC &&
            bottomPx <= height * FOLLOW_BOTTOM_FRAC &&
            linePx >= width * 0.05 &&
            linePx <= width * 0.95;
        if (fits && !this.forceFollow) {
            return;
        }

        const target = clampScroll(
            scrollForPagePoint(view, pageLayout, rect.x0, rect.y0, width, height, 0.35, FOLLOW_ANCHOR_Y),
            layout,
            width,
            height,
        );
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
        const { from, to, startedAt } = this.anim;
        const t = Math.min(1, (performance.now() - startedAt) / FOLLOW_ANIM_MS);
        const ease = 1 - Math.pow(1 - t, 3);
        const store = useViewerStore.getState();
        store.setView({
            scale: store.view.scale,
            scrollX: from.x + (to.x - from.x) * ease,
            scrollY: from.y + (to.y - from.y) * ease,
        });
        if (t >= 1) {
            this.anim = null;
        }
    }
}
