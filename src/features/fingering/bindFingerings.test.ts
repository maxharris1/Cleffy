import { describe, expect, it } from 'vitest';

import { bindRegionDigits, collectRegionDigits } from '@/features/fingering/bindFingerings';
import { emptyRegion, type RecognizedNote, type RecognizedRegion } from '@/features/fingering/model';
import type { Annotation } from '@/types/models';

const ASPECT = 0.75; // portrait page

const textAnnotation = (id: string, text: string, x: number, y: number, size = 0.018): Annotation => ({
    id,
    docId: 'doc',
    page: 0,
    kind: 'text',
    color: '#dc2626',
    payload: { x, y, text, size },
    createdBy: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const note = (overrides: Partial<RecognizedNote>): RecognizedNote => ({
    id: overrides.id ?? crypto.randomUUID(),
    midi: 60,
    name: 'C4',
    staff: 'upper',
    bbox: { x: 0.2, y: 0.3, w: 0.015, h: 0.008 },
    eventIndex: 0,
    annotatedFinger: null,
    fingerSource: null,
    confidence: 'high',
    ...overrides,
});

const regionWith = (notes: RecognizedNote[]): RecognizedRegion => ({
    ...emptyRegion('doc', 0, { x: 0.1, y: 0.25, w: 0.4, h: 0.15 }),
    notes,
    source: 'vision',
});

describe('collectRegionDigits', () => {
    it('finds single 1-5 digit text annotations in (and just outside) the rect', () => {
        const annotations = [
            textAnnotation('d3', '3', 0.2, 0.28),
            textAnnotation('word', 'cresc.', 0.2, 0.3),
            textAnnotation('run', '34323', 0.25, 0.3),
            textAnnotation('far', '2', 0.9, 0.9),
        ];
        const digits = collectRegionDigits(annotations, { x: 0.1, y: 0.25, w: 0.4, h: 0.15 }, ASPECT);
        expect(digits.map((d) => d.annotationId)).toEqual(['d3']);
        expect(digits[0]?.finger).toBe(3);
    });
});

describe('bindRegionDigits', () => {
    it('binds a digit to the nearest note and fills a missing finger', () => {
        const region = regionWith([
            note({ id: 'n1', bbox: { x: 0.2, y: 0.3, w: 0.015, h: 0.008 } }),
            note({ id: 'n2', midi: 64, bbox: { x: 0.3, y: 0.3, w: 0.015, h: 0.008 } }),
        ]);
        const bound = bindRegionDigits(region, [textAnnotation('d', '2', 0.2, 0.27)], ASPECT);
        expect(bound.notes.find((n) => n.id === 'n1')?.annotatedFinger).toBe(2);
        expect(bound.notes.find((n) => n.id === 'n1')?.fingerSource).toBe('client-text');
        expect(bound.notes.find((n) => n.id === 'n2')?.annotatedFinger).toBeNull();
    });

    it('ignores digits farther than 1.5× the median notehead width', () => {
        const region = regionWith([note({ id: 'n1', bbox: { x: 0.2, y: 0.3, w: 0.01, h: 0.008 } })]);
        const bound = bindRegionDigits(region, [textAnnotation('d', '4', 0.4, 0.3)], ASPECT);
        expect(bound.notes[0]?.annotatedFinger).toBeNull();
    });

    it('prefers the staff matching the digit side on a tie', () => {
        const region = regionWith([
            note({ id: 'up', staff: 'upper', bbox: { x: 0.2, y: 0.32, w: 0.015, h: 0.008 } }),
            note({ id: 'down', staff: 'lower', midi: 48, bbox: { x: 0.2, y: 0.36, w: 0.015, h: 0.008 } }),
        ]);
        // Digit above both noteheads → upper-staff note wins the tie on x.
        const above = bindRegionDigits(region, [textAnnotation('d', '1', 0.2, 0.28)], ASPECT);
        expect(above.notes.find((n) => n.id === 'up')?.annotatedFinger).toBe(1);
        expect(above.notes.find((n) => n.id === 'down')?.annotatedFinger).toBeNull();
        // Digit below both → lower-staff note wins.
        const below = bindRegionDigits(region, [textAnnotation('d', '5', 0.2, 0.4)], ASPECT);
        expect(below.notes.find((n) => n.id === 'down')?.annotatedFinger).toBe(5);
    });

    it('binds one digit per note and one note per digit, greedily by distance', () => {
        const region = regionWith([
            note({ id: 'n1', bbox: { x: 0.2, y: 0.3, w: 0.015, h: 0.008 } }),
            note({ id: 'n2', midi: 62, bbox: { x: 0.215, y: 0.3, w: 0.015, h: 0.008 } }),
        ]);
        const bound = bindRegionDigits(
            region,
            [textAnnotation('d1', '1', 0.2, 0.27), textAnnotation('d2', '2', 0.215, 0.27)],
            ASPECT,
        );
        expect(bound.notes.find((n) => n.id === 'n1')?.annotatedFinger).toBe(1);
        expect(bound.notes.find((n) => n.id === 'n2')?.annotatedFinger).toBe(2);
    });

    describe('merge with vision-attached fingers', () => {
        it('keeps a high-confidence vision finger over a disagreeing digit', () => {
            const region = regionWith([
                note({ id: 'n1', annotatedFinger: 3, fingerSource: 'vision', fingerConfidence: 'high' }),
            ]);
            const bound = bindRegionDigits(region, [textAnnotation('d', '2', 0.2, 0.27)], ASPECT);
            expect(bound.notes[0]?.annotatedFinger).toBe(3);
            expect(bound.notes[0]?.fingerSource).toBe('vision');
        });

        it('lets an unambiguous digit override a low-confidence vision finger', () => {
            const region = regionWith([
                note({ id: 'n1', annotatedFinger: 3, fingerSource: 'vision', fingerConfidence: 'low' }),
            ]);
            const bound = bindRegionDigits(region, [textAnnotation('d', '2', 0.2, 0.27)], ASPECT);
            expect(bound.notes[0]?.annotatedFinger).toBe(2);
            expect(bound.notes[0]?.fingerSource).toBe('client-text');
        });

        it('flags an ambiguous disagreement low-confidence instead of guessing', () => {
            const region = regionWith([
                note({
                    id: 'n1',
                    annotatedFinger: 3,
                    fingerSource: 'vision',
                    fingerConfidence: 'medium',
                    bbox: { x: 0.2, y: 0.3, w: 0.015, h: 0.008 },
                }),
                note({ id: 'n2', midi: 62, bbox: { x: 0.21, y: 0.3, w: 0.015, h: 0.008 } }),
            ]);
            const bound = bindRegionDigits(region, [textAnnotation('d', '2', 0.2, 0.27)], ASPECT);
            const n1 = bound.notes.find((n) => n.id === 'n1');
            expect(n1?.annotatedFinger).toBe(3);
            expect(n1?.confidence).toBe('low');
        });

        it('upgrades finger confidence when the digit agrees with vision', () => {
            const region = regionWith([
                note({ id: 'n1', annotatedFinger: 2, fingerSource: 'vision', fingerConfidence: 'medium' }),
            ]);
            const bound = bindRegionDigits(region, [textAnnotation('d', '2', 0.2, 0.27)], ASPECT);
            expect(bound.notes[0]?.fingerConfidence).toBe('high');
        });
    });
});
