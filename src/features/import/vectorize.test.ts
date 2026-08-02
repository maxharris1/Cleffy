import { describe, expect, it } from 'vitest';

import type { RleMask } from '@/features/import/importTypes';
import { thinGrid, traceSkeletonPaths, vectorizeMask } from '@/features/import/vectorize';
import { strokeBbox } from '@/features/viewer/geometry';

/** Build an RLE mask from ASCII art ('#' = ink). */
const maskFromAscii = (rows: string[], x = 0, y = 0): { mask: RleMask; area: number } => {
    const h = rows.length;
    const w = Math.max(...rows.map((r) => r.length));
    const runs: number[] = [];
    let area = 0;
    rows.forEach((row, r) => {
        let start = -1;
        for (let c = 0; c <= row.length; c++) {
            const on = row[c] === '#';
            if (on && start < 0) {
                start = c;
            } else if (!on && start >= 0) {
                runs.push(r, start, c - start);
                area += c - start;
                start = -1;
            }
        }
    });
    return { mask: { x, y, w, h, runs: Int32Array.from(runs) }, area };
};

const bar = (w: number, h: number): string[] => Array.from({ length: h }, () => '#'.repeat(w));

const gridOf = (mask: RleMask): Uint8Array => {
    const grid = new Uint8Array(mask.w * mask.h);
    for (let i = 0; i < mask.runs.length; i += 3) {
        const row = mask.runs[i] ?? 0;
        const start = mask.runs[i + 1] ?? 0;
        const len = mask.runs[i + 2] ?? 0;
        for (let c = start; c < start + len; c++) {
            grid[row * mask.w + c] = 1;
        }
    }
    return grid;
};

describe('thinGrid', () => {
    it('reduces a thick bar to a ~1px skeleton spanning its length', () => {
        const { mask } = maskFromAscii(bar(16, 4));
        const grid = thinGrid(gridOf(mask), 16, 4);
        const on = grid.reduce<number>((sum, v) => sum + v, 0);
        expect(on).toBeGreaterThanOrEqual(10);
        expect(on).toBeLessThanOrEqual(20); // far below the 64 source pixels
    });
});

describe('traceSkeletonPaths', () => {
    it('walks an open curve end to end as one path', () => {
        const { mask } = maskFromAscii(bar(16, 4));
        const grid = thinGrid(gridOf(mask), 16, 4);
        const paths = traceSkeletonPaths(grid, 16, 4);
        expect(paths).toHaveLength(1);
    });

    it('closes cycles back onto their start', () => {
        const ring = ['########', '########', '##....##', '##....##', '##....##', '########', '########'];
        const { mask } = maskFromAscii(ring);
        const grid = thinGrid(gridOf(mask), mask.w, mask.h);
        const paths = traceSkeletonPaths(grid, mask.w, mask.h);
        expect(paths).toHaveLength(1);
        const path = paths[0] ?? [];
        const first = path[0];
        const last = path[path.length - 1];
        expect(first).toEqual(last);
    });
});

describe('vectorizeMask', () => {
    it('turns an L-shaped bracket into one stroke spanning both arms', () => {
        const art = [
            '####............',
            '####............',
            '####............',
            '####............',
            '####............',
            '####............',
            '################',
            '################',
        ];
        const { mask, area } = maskFromAscii(art, 100, 200);
        const payloads = vectorizeMask(mask, area, 3, 2048, 2650);
        expect(payloads).toHaveLength(1);
        const [minX, minY, maxX, maxY] = strokeBbox(payloads[0]?.pts ?? []);
        // Spans from the top of the vertical arm to the right end of the horizontal arm.
        expect(minX).toBeCloseTo(100 / 2048, 2);
        expect(maxX).toBeGreaterThan(112 / 2048);
        expect(minY).toBeLessThan(203 / 2650);
        expect(maxY).toBeGreaterThan(205 / 2650);
    });

    it('splits a T-junction into multiple strokes', () => {
        const art = [
            '################',
            '################',
            '.......##.......',
            '.......##.......',
            '.......##.......',
            '.......##.......',
            '.......##.......',
            '.......##.......',
        ];
        const { mask, area } = maskFromAscii(art);
        const payloads = vectorizeMask(mask, area, 2, 2048, 2650);
        expect(payloads.length).toBeGreaterThanOrEqual(2);
    });

    it('derives stroke width from ink thickness', () => {
        const { mask, area } = maskFromAscii(bar(40, 4));
        const payloads = vectorizeMask(mask, area, 4, 2048, 2650);
        const w = payloads[0]?.w ?? 0;
        // area/skeletonLength ≈ 160/40 ≈ 4px → w ≈ 4/2048.
        expect(w * 2048).toBeGreaterThan(2.5);
        expect(w * 2048).toBeLessThan(6);
    });

    it('emits a short dot stroke for blobs too small to skeletonize', () => {
        const { mask, area } = maskFromAscii(bar(3, 3), 50, 60);
        const payloads = vectorizeMask(mask, area, 3, 2048, 2650);
        expect(payloads).toHaveLength(1);
        expect(payloads[0]?.pts).toHaveLength(6); // two points
    });

    it('decimates long paths', () => {
        const { mask, area } = maskFromAscii(bar(200, 3));
        const payloads = vectorizeMask(mask, area, 3, 2048, 2650);
        const pts = payloads[0]?.pts ?? [];
        expect(pts.length % 3).toBe(0);
        expect(pts.length / 3).toBeLessThan(120); // raw skeleton would be ~200 points
    });
});
