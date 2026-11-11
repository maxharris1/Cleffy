import { describe, expect, it } from 'vitest';

import { computeDocumentLayout, MIN_SCALE, pageFitView, pageRow } from '@/features/viewer/geometry';
import type { PageSize } from '@/types/models';

/** Float slack (px) for "on screen". */
const EPSILON = 1e-6;

const LARGE: PageSize = { width: 2000, height: 2800 };
const LETTER: PageSize = { width: 612, height: 792 };
const LANDSCAPE: PageSize = { width: 1400, height: 900 };

const DOCUMENTS: { name: string; pages: PageSize[] }[] = [
    { name: 'two large pages', pages: [LARGE, LARGE] },
    { name: 'five large pages', pages: [LARGE, LARGE, LARGE, LARGE, LARGE] },
    { name: 'letter pages', pages: [LETTER, LETTER, LETTER, LETTER] },
    { name: 'mixed sizes', pages: [LARGE, LETTER, LANDSCAPE, LARGE, LETTER] },
];

const LAYOUTS: { name: string; columns: 1 | 2; cover: boolean }[] = [
    { name: 'single', columns: 1, cover: false },
    { name: 'spread', columns: 2, cover: false },
    { name: 'cover spread', columns: 2, cover: true },
];

const VIEWPORTS = [
    { width: 800, height: 1000 },
    { width: 640, height: 360 },
    { width: 1366, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 240 },
];

const cases = DOCUMENTS.flatMap((doc) =>
    LAYOUTS.flatMap((l) => VIEWPORTS.map((vp) => ({ ...doc, ...l, vp, label: `${doc.name}, ${l.name}` }))),
);

describe('pageFitView keeps every shown page wholly on screen', () => {
    it.each(cases)('$label in $vp.width×$vp.height', ({ pages, columns, cover, vp }) => {
        const layout = computeDocumentLayout(pages, columns, cover);
        for (let index = 0; index < layout.layouts.length; index++) {
            const view = pageFitView(layout, index, vp.width, vp.height, columns);
            expect(view).not.toBeNull();
            const { first, last } = pageRow(layout.layouts, index);
            for (let shown = first; shown <= last; shown++) {
                const p = layout.layouts[shown]!;
                for (const [x, y] of [
                    [p.left, p.top],
                    [p.left + p.width, p.top],
                    [p.left, p.top + p.height],
                    [p.left + p.width, p.top + p.height],
                ] as const) {
                    const sx = x * view!.scale - view!.scrollX;
                    const sy = y * view!.scale - view!.scrollY;
                    expect(sx).toBeGreaterThanOrEqual(-EPSILON);
                    expect(sx).toBeLessThanOrEqual(vp.width + EPSILON);
                    expect(sy).toBeGreaterThanOrEqual(-EPSILON);
                    expect(sy).toBeLessThanOrEqual(vp.height + EPSILON);
                }
            }
        }
    });

    it('fits below the manual zoom floor where it must (two 2000×2800 pages in 800×1000)', () => {
        const layout = computeDocumentLayout([LARGE, LARGE], 2, false);
        const view = pageFitView(layout, 0, 800, 1000, 2)!;
        expect(view.scale).toBeLessThan(MIN_SCALE);
        expect(view.scale).toBeCloseTo((800 - 32) / 4016, 6);
    });
});
