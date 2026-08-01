import { describe, expect, it } from 'vitest';

import { hitTestAnnotation, hitTestPage } from '@/features/viewer/ink/hitTest';
import type { Annotation } from '@/types/models';

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
