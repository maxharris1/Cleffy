import { afterEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { PlayheadController, playheadRect } from '@/features/playback/PlayheadController';
import { measureIndexAtPagePoint } from '@/features/playback/scoreTime';
import { computeDocumentLayout } from '@/features/viewer/geometry';
import type { DocumentLayout, ObscuredEdges } from '@/features/viewer/geometry';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { useViewerStore } from '@/state/store';

describe('playheadRect', () => {
    it('sweeps linearly through a measure on the right system band', () => {
        // Middle of m1 (ticks 480–2400, x 0.24–0.58, system 0 on page 0).
        const rect = playheadRect(tinyScore, 480 + 960);
        expect(rect).not.toBeNull();
        expect(rect?.measureIndex).toBe(1);
        expect(rect?.pageIndex).toBe(0);
        expect(rect?.x).toBeCloseTo(0.24 + 0.5 * (0.58 - 0.24), 5);
        expect(rect?.y0).toBe(0.1);
        expect(rect?.y1).toBe(0.28);
    });

    it('crosses systems and pages with the measure map', () => {
        expect(playheadRect(tinyScore, 4320)?.pageIndex).toBe(0); // m3 → system 1
        expect(playheadRect(tinyScore, 4320)?.y0).toBe(0.4);
        expect(playheadRect(tinyScore, 8160)?.pageIndex).toBe(1); // m5 → page 1
        expect(playheadRect(tinyScore, 999999)?.measureIndex).toBe(8); // clamped to the last measure
    });

    it('hides on geometry-less measures', () => {
        const degraded = {
            ...tinyScore,
            measures: tinyScore.measures.map((m, i) => (i === 1 ? { ...m, sys: -1, page: -1 } : m)),
        };
        expect(playheadRect(degraded, 1000)).toBeNull();
        expect(playheadRect(degraded, 0)).not.toBeNull();
    });
});

describe('PlayheadController drawing', () => {
    const frames: FrameRequestCallback[] = [];
    const flushFrame = () => {
        const pending = frames.splice(0, frames.length);
        for (const callback of pending) {
            callback(0);
        }
    };

    const EMPTY_LAYOUT: DocumentLayout = { layouts: [], contentWidth: 0, contentHeight: 0 };
    const PAGED_LAYOUT = computeDocumentLayout([
        { width: 612, height: 792 },
        { width: 612, height: 792 },
    ]);

    const mount = (getLayout: () => DocumentLayout) => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', () => {});
        const lineEl = document.createElement('div');
        const highlightEl = document.createElement('div');
        const controller = new PlayheadController({
            // No engine yet: a freshly opened, never-played score sits at tick 0.
            getEngine: () => null,
            getScore: () => tinyScore,
            lineEl,
            highlightEl,
            getLayout,
            getRenderScale: () => 1,
            getViewportSize: () => ({ width: 800, height: 600 }),
        });
        return { controller, lineEl, highlightEl };
    };

    afterEach(() => {
        frames.length = 0;
        vi.unstubAllGlobals();
        useViewerStore.getState().resetPlayback();
    });

    it('shows the playhead and highlight on the opening measure without pressing play', () => {
        const { controller, lineEl, highlightEl } = mount(() => PAGED_LAYOUT);
        flushFrame();
        expect(lineEl.style.display).toBe('block');
        expect(highlightEl.style.display).toBe('block');
        expect(useViewerStore.getState().currentMeasureIndex).toBe(0);
        controller.destroy();
    });

    it('keeps retrying until the pages are measured (reopening a cached score)', () => {
        let layout = EMPTY_LAYOUT;
        const { controller, lineEl, highlightEl } = mount(() => layout);

        // The controller can start before the PDF has laid out: nothing to draw
        // on, and the tick never moves while paused.
        flushFrame();
        expect(lineEl.style.display).toBe('none');
        flushFrame();
        expect(lineEl.style.display).toBe('none');

        layout = PAGED_LAYOUT;
        flushFrame();
        expect(lineEl.style.display).toBe('block');
        expect(highlightEl.style.display).toBe('block');
        expect(Number.parseFloat(highlightEl.style.height)).toBeGreaterThan(0);
        controller.destroy();
    });
});

describe('PlayheadController follow scroll', () => {
    const frames: FrameRequestCallback[] = [];
    const flushFrame = () => {
        const pending = frames.splice(0, frames.length);
        for (const callback of pending) {
            callback(0);
        }
    };
    const LAYOUT = computeDocumentLayout([
        { width: 612, height: 792 },
        { width: 612, height: 792 },
    ]);
    const VIEWPORT = { width: 800, height: 600 };
    const LAST_TICK = 999999;

    /** Follow the measure at `tick` from the top of the score; returns the settled view. */
    const followTo = (tick: number, obscured?: ObscuredEdges) => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', () => {});
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        useViewerStore.getState().setView({ scale: 1, scrollX: 0, scrollY: 0 });
        const controller = new PlayheadController({
            getEngine: () => ({ getPositionTicks: () => tick }) as unknown as PlaybackEngine,
            getScore: () => tinyScore,
            lineEl: document.createElement('div'),
            highlightEl: document.createElement('div'),
            getLayout: () => LAYOUT,
            getRenderScale: () => 1,
            getViewportSize: () => VIEWPORT,
            ...(obscured ? { getObscured: () => obscured } : {}),
        });
        flushFrame();
        now = 10_000;
        flushFrame();
        controller.destroy();
        return useViewerStore.getState().view;
    };

    afterEach(() => {
        frames.length = 0;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        useViewerStore.getState().resetPlayback();
        useViewerStore.getState().setView({ scale: 1, scrollX: 0, scrollY: 0 });
    });

    it('scrolls the last systems clear of a bottom toolbar, past the unobscured scroll limit', () => {
        const rect = playheadRect(tinyScore, LAST_TICK)!;
        const page = LAYOUT.layouts[rect.pageIndex]!;
        const systemTop = page.top + rect.y0 * page.height;
        const unobscuredMax = LAYOUT.contentHeight - VIEWPORT.height;

        // Without the toolbar the follow target is clamped at the end of the content.
        expect(followTo(LAST_TICK).scrollY).toBeCloseTo(unobscuredMax, 5);

        // A 200px phone toolbar lets the view scroll 200px further, and the
        // system lands near the top of the strip the toolbar leaves visible.
        const view = followTo(LAST_TICK, { top: 0, bottom: 200 });
        expect(view.scrollY).toBeGreaterThan(unobscuredMax);
        expect(systemTop - view.scrollY).toBeCloseTo(400 * 0.12, 5);
    });

    it('keeps the opening system below a top toolbar instead of snapping the view back to 0', () => {
        const rect = playheadRect(tinyScore, 0)!;
        const page = LAYOUT.layouts[rect.pageIndex]!;
        const systemTop = page.top + rect.y0 * page.height;
        const view = followTo(0, { top: 80, bottom: 0 });
        // Anchored below the toolbar: 80px + 12% of the 520px left visible,
        // which takes a negative scroll offset clampScroll allows only when told
        // about the toolbar.
        expect(view.scrollY).toBeLessThan(0);
        expect(systemTop - view.scrollY).toBeCloseTo(80 + 520 * 0.12, 5);
    });
});

describe('measureIndexAtPagePoint (tap-to-seek)', () => {
    it('hits the measure under the point', () => {
        // Inside m1: system 0 band y 0.1–0.28, x 0.24–0.58.
        expect(measureIndexAtPagePoint(tinyScore, 0, 0.4, 0.2)).toBe(1);
        // Inside m7: page 1, system 3 band y 0.4–0.58, x 0.08–0.5.
        expect(measureIndexAtPagePoint(tinyScore, 1, 0.3, 0.5)).toBe(7);
    });

    it('misses between systems, off-page, and outside measure spans', () => {
        expect(measureIndexAtPagePoint(tinyScore, 0, 0.4, 0.35)).toBe(-1); // gap between systems
        expect(measureIndexAtPagePoint(tinyScore, 1, 0.4, 0.2)).not.toBe(1); // page 1, not page 0's m1
        expect(measureIndexAtPagePoint(tinyScore, 0, 0.02, 0.2)).toBe(-1); // left margin
        expect(measureIndexAtPagePoint(tinyScore, 5, 0.5, 0.5)).toBe(-1); // no such page
    });
});
