import { describe, expect, it } from 'vitest';

import type { DetectionRaster } from '@/features/import/importTypes';
import {
    buildInkMask,
    forEachRlePixel,
    MAX_CLUSTERS_PER_PAGE,
    rlePerimeter,
    segmentPage,
} from '@/features/import/segmentation';

type Rgb = [number, number, number];

const BLUE: Rgb = [37, 99, 235]; // teacher pen ≈ palette blue
const RED: Rgb = [220, 38, 38];
const BEIGE: Rgb = [245, 240, 225]; // yellowed paper, chroma 20
const BLACK: Rgb = [25, 25, 25]; // printed notation

const makeRaster = (width: number, height: number, bg: Rgb = [255, 255, 255]): DetectionRaster => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = bg[0];
        data[i * 4 + 1] = bg[1];
        data[i * 4 + 2] = bg[2];
        data[i * 4 + 3] = 255;
    }
    return { data, width, height };
};

const paintRect = (raster: DetectionRaster, x: number, y: number, w: number, h: number, color: Rgb): void => {
    for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
            const i = (py * raster.width + px) * 4;
            raster.data[i] = color[0];
            raster.data[i + 1] = color[1];
            raster.data[i + 2] = color[2];
            raster.data[i + 3] = 255;
        }
    }
};

describe('buildInkMask', () => {
    it('ignores paper, beige tint, and black print', () => {
        const raster = makeRaster(64, 64, BEIGE);
        paintRect(raster, 10, 10, 20, 20, BLACK);
        expect(buildInkMask(raster).inkCount).toBe(0);
    });

    it('classifies hue buckets', () => {
        const raster = makeRaster(8, 1);
        paintRect(raster, 0, 0, 1, 1, RED);
        paintRect(raster, 2, 0, 1, 1, [250, 230, 40]); // highlighter yellow
        paintRect(raster, 4, 0, 1, 1, [22, 163, 74]); // green
        paintRect(raster, 6, 0, 1, 1, BLUE);
        const { mask } = buildInkMask(raster);
        expect([mask[0], mask[2], mask[4], mask[6]]).toEqual([1, 2, 3, 4]);
        expect(mask[1]).toBe(0);
    });
});

describe('segmentPage', () => {
    it('finds a single glyph with correct bbox, color, and mask', () => {
        const raster = makeRaster(256, 256);
        paintRect(raster, 100, 50, 10, 14, BLUE);
        const { clusters, flags } = segmentPage(raster, 3);
        expect(flags).toEqual({ tooColorful: false, largeColorRegion: false, dense: false });
        expect(clusters).toHaveLength(1);
        const c = clusters[0];
        expect(c?.id).toBe('p3c0');
        expect(c?.bboxPx).toEqual({ x: 100, y: 50, w: 10, h: 14 });
        expect(c?.area).toBe(140);
        expect(c?.bucket).toBe('blue');
        expect(c?.meanColorHex).toBe('#2563eb');
        let pixels = 0;
        if (c) {
            forEachRlePixel(c.mask, () => pixels++);
        }
        expect(pixels).toBe(140);
    });

    it('rejects dust specks', () => {
        const raster = makeRaster(128, 128);
        paintRect(raster, 30, 30, 2, 2, BLUE); // 4 px < MIN_COMPONENT_AREA_PX
        expect(segmentPage(raster, 0).clusters).toHaveLength(0);
    });

    it('keeps thin dashes (1px wide but long)', () => {
        const raster = makeRaster(128, 128);
        paintRect(raster, 20, 60, 30, 2, RED);
        const { clusters } = segmentPage(raster, 0);
        expect(clusters).toHaveLength(1);
        expect(clusters[0]?.bucket).toBe('red');
    });

    it('merges nearby strokes of one glyph, keeps distant glyphs separate', () => {
        const raster = makeRaster(256, 128);
        // Two strokes 4px apart (within GLYPH_MERGE_GAP_PX=6) → one "5".
        paintRect(raster, 40, 40, 4, 16, BLUE);
        paintRect(raster, 48, 40, 4, 16, BLUE);
        // A distant glyph 40px away.
        paintRect(raster, 120, 40, 6, 16, BLUE);
        const { clusters } = segmentPage(raster, 0);
        expect(clusters).toHaveLength(2);
        expect(clusters[0]?.bboxPx).toEqual({ x: 40, y: 40, w: 12, h: 16 });
    });

    it('never merges different colors even when adjacent', () => {
        const raster = makeRaster(128, 128);
        paintRect(raster, 40, 40, 6, 12, BLUE);
        paintRect(raster, 48, 40, 6, 12, RED);
        const { clusters } = segmentPage(raster, 0);
        expect(clusters).toHaveLength(2);
    });

    it('groups a fingering run like "34323" and leaves isolated digits ungrouped', () => {
        const raster = makeRaster(512, 128);
        // Five digits, 10px wide, 8px gaps (> merge gap, < run gap of 1.2×10).
        for (let d = 0; d < 5; d++) {
            paintRect(raster, 100 + d * 18, 30, 10, 14, BLUE);
        }
        // An isolated digit far to the right on the same line.
        paintRect(raster, 400, 30, 10, 14, BLUE);
        const { clusters } = segmentPage(raster, 0);
        expect(clusters).toHaveLength(6);
        const runIds = new Set(clusters.map((c) => c.runId));
        const runMembers = clusters.filter((c) => c.runId !== null);
        expect(runMembers).toHaveLength(5);
        expect(runIds.size).toBe(2); // one shared run id + null
    });

    it('does not chain digits from different staff lines into one run', () => {
        const raster = makeRaster(256, 256);
        paintRect(raster, 100, 30, 10, 14, BLUE);
        paintRect(raster, 118, 90, 10, 14, BLUE); // same x-gap, different line
        const { clusters } = segmentPage(raster, 0);
        expect(clusters.every((c) => c.runId === null)).toBe(true);
    });

    it('discards huge color regions (stamps/plates) and flags them', () => {
        const raster = makeRaster(1024, 512);
        paintRect(raster, 50, 100, 900, 40, RED); // 900 > 0.35 × 1024
        paintRect(raster, 100, 300, 10, 14, BLUE);
        const { clusters, flags } = segmentPage(raster, 0);
        expect(flags.largeColorRegion).toBe(true);
        expect(clusters).toHaveLength(1);
        expect(clusters[0]?.bucket).toBe('blue');
    });

    it('bails out on photo-like pages (tooColorful)', () => {
        const raster = makeRaster(256, 256);
        paintRect(raster, 0, 0, 256, 32, BLUE); // 12.5% of the page
        const { clusters, flags } = segmentPage(raster, 0);
        expect(flags.tooColorful).toBe(true);
        expect(clusters).toHaveLength(0);
    });

    it('caps cluster count and flags dense pages', () => {
        const raster = makeRaster(1600, 800);
        for (let i = 0; i < MAX_CLUSTERS_PER_PAGE + 10; i++) {
            const x = 10 + (i % 40) * 38;
            const y = 10 + Math.floor(i / 40) * 40;
            paintRect(raster, x, y, 5, 6, BLUE);
        }
        const { clusters, flags } = segmentPage(raster, 0);
        expect(flags.dense).toBe(true);
        expect(clusters).toHaveLength(MAX_CLUSTERS_PER_PAGE);
    });
});

describe('rlePerimeter', () => {
    it('matches the analytic perimeter of a rectangle', () => {
        const raster = makeRaster(64, 64);
        paintRect(raster, 10, 10, 10, 2, BLUE);
        const { clusters } = segmentPage(raster, 0);
        expect(clusters[0] && rlePerimeter(clusters[0].mask)).toBe(24);
        // thickness = 2·area/perimeter = 2·20/24 ≈ 1.67 — the pen height.
        expect(clusters[0]?.thicknessPx).toBeCloseTo(1.67, 1);
    });
});
