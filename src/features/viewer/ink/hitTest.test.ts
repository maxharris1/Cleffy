import { describe, expect, it } from 'vitest';

import { measureInkText, SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import { annotationBboxNorm, annotationsInRect, hitTestAnnotation, hitTestPage } from '@/features/viewer/ink/hitTest';
import { MUSIC_FONT_FAMILY, textBoundsNorm } from '@/features/viewer/ink/musicFont';
import type { Annotation, TextPayload } from '@/types/models';

const PAGE_W = 1000;
const PAGE_H = 1400;

const stroke = (id: string, pts: number[], w = 0.005): Annotation => ({
    id,
    docId: 'd',
    page: 0,
    kind: 'stroke',
    color: '#000',
    payload: { pts, w },
    createdBy: null,
    createdAt: `2026-01-01T00:00:0${id.length}Z`,
    updatedAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
    seq: 0,
});

describe('hitTestAnnotation', () => {
    // Horizontal line from (0.1, 0.5) to (0.5, 0.5).
    const line = stroke('s1', [0.1, 0.5, 0.5, 0.3, 0.5, 0.5, 0.5, 0.5, 0.5]);

    it('hits a point on the stroke', () => {
        expect(hitTestAnnotation(line, 0.3, 0.5, 5, PAGE_W, PAGE_H)).toBe(true);
    });

    it('hits within the pick radius of the stroke edge', () => {
        // 10px below the line: 0.5 + 10/1400
        expect(hitTestAnnotation(line, 0.3, 0.5 + 10 / PAGE_H, 12, PAGE_W, PAGE_H)).toBe(true);
    });

    it('misses far from the stroke', () => {
        expect(hitTestAnnotation(line, 0.3, 0.8, 12, PAGE_W, PAGE_H)).toBe(false);
        expect(hitTestAnnotation(line, 0.9, 0.5, 12, PAGE_W, PAGE_H)).toBe(false);
    });

    it('hits a single-point dot', () => {
        const dot = stroke('s2', [0.2, 0.2, 0.5]);
        expect(hitTestAnnotation(dot, 0.2, 0.2, 5, PAGE_W, PAGE_H)).toBe(true);
        expect(hitTestAnnotation(dot, 0.25, 0.2, 5, PAGE_W, PAGE_H)).toBe(false);
    });

    it('hits a text annotation by its box', () => {
        const text: Annotation = {
            ...stroke('t1', []),
            kind: 'text',
            payload: { x: 0.1, y: 0.1, text: 'forte', size: 0.02 },
        };
        expect(hitTestAnnotation(text, 0.12, 0.11, 4, PAGE_W, PAGE_H)).toBe(true);
        expect(hitTestAnnotation(text, 0.5, 0.5, 4, PAGE_W, PAGE_H)).toBe(false);
    });
});

describe('hitTestPage', () => {
    it('returns newest-first hits', () => {
        const older = stroke('a', [0.1, 0.5, 0.5, 0.5, 0.5, 0.5]);
        const newer = { ...stroke('bb', [0.1, 0.5, 0.5, 0.5, 0.5, 0.5]), createdAt: '2026-02-01T00:00:00Z' };
        const hits = hitTestPage([older, newer], 0.3, 0.5, 6, PAGE_W, PAGE_H);
        expect(hits.map((h) => h.id)).toEqual(['bb', 'a']);
    });
});

const ASPECT = PAGE_W / PAGE_H;

const text = (id: string, x: number, y: number, content = '3', size = 0.02): Annotation => ({
    ...stroke(id, []),
    kind: 'text',
    payload: { x, y, text: content, size },
});

describe('annotationBboxNorm', () => {
    it('sizes text by its measured glyph bounds (width against page width, height via aspect)', () => {
        const [minX, minY, maxX, maxY] = annotationBboxNorm(text('t', 0.1, 0.2, 'ab', 0.02), ASPECT);
        const m = measureInkText('ab', { family: SYSTEM_FONT_FAMILY, style: 'normal' });
        expect(minX).toBe(0.1);
        // The box starts at the glyphs' visual top, below the 'top' baseline anchor.
        expect(minY).toBeCloseTo(0.2 + m.topInset * 0.02 * ASPECT);
        expect(maxX).toBeCloseTo(0.1 + m.widthRatio * 0.02);
        expect(maxY).toBeCloseTo(0.2 + (m.topInset + m.heightRatio) * 0.02 * ASPECT);
    });

    it('gives a converted music glyph the box of that glyph, not of its em', () => {
        const HW = PAGE_H / PAGE_W;
        const accent: TextPayload = { x: 0.3, y: 0.5, text: '\uE4A0', size: 0.1, hw: 1 };
        const m = measureInkText('\uE4A0', { family: MUSIC_FONT_FAMILY, style: 'normal' });
        const [minX, minY, maxX, maxY] = textBoundsNorm(accent, HW);
        expect(maxX - minX).toBeCloseTo(m.widthRatio * 0.1);
        expect(maxY - minY).toBeCloseTo((m.heightRatio * 0.1) / HW);
        // Hit inside the glyph box, but not a whole em below the anchor.
        const annotation: Annotation = { ...text('acc', 0.3, 0.5), payload: accent };
        expect(hitTestAnnotation(annotation, (minX + maxX) / 2, (minY + maxY) / 2, 0, PAGE_W, PAGE_H)).toBe(true);
        expect(hitTestAnnotation(annotation, 0.31, 0.5 + (1.2 * 0.1) / HW, 0, PAGE_W, PAGE_H)).toBe(false);
    });

    it('stacks multi-line text one line pitch apart', () => {
        const HW = PAGE_H / PAGE_W;
        const one = textBoundsNorm({ x: 0, y: 0, text: 'a', size: 0.02 }, HW);
        const two = textBoundsNorm({ x: 0, y: 0, text: 'a\na', size: 0.02 }, HW);
        expect(two[3] - one[3]).toBeCloseTo((1.25 * 0.02) / HW);
    });

    it('inflates stroke bboxes by half the stroke width per axis', () => {
        const [minX, minY, maxX, maxY] = annotationBboxNorm(
            stroke('s', [0.3, 0.4, 0.5, 0.35, 0.45, 0.5], 0.01),
            ASPECT,
        );
        expect(minX).toBeCloseTo(0.3 - 0.005);
        expect(maxX).toBeCloseTo(0.35 + 0.005);
        expect(minY).toBeCloseTo(0.4 - 0.005 * ASPECT);
        expect(maxY).toBeCloseTo(0.45 + 0.005 * ASPECT);
    });
});

describe('annotationsInRect', () => {
    it('returns annotations whose bbox intersects the rect, including edge touches', () => {
        const inside = text('inside', 0.2, 0.2);
        const outside = text('outside', 0.8, 0.8);
        // Text starting exactly at the rect's right edge — touching counts.
        const touching = text('touching', 0.4, 0.2);
        const hits = annotationsInRect([inside, outside, touching], { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, ASPECT);
        expect(hits.map((h) => h.id)).toEqual(['inside', 'touching']);
    });

    it('catches strokes that only clip a corner of the rect', () => {
        const s = stroke('s', [0.05, 0.05, 0.5, 0.12, 0.12, 0.5]);
        expect(annotationsInRect([s], { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, ASPECT)).toHaveLength(1);
        expect(annotationsInRect([s], { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, ASPECT)).toHaveLength(0);
    });
});
