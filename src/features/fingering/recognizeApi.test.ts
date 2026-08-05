import { describe, expect, it } from 'vitest';

import { recognizeResponseSchema, regionFromResponse } from '@/features/fingering/recognizeApi';

const validResponse = {
    ok: true as const,
    page: 2,
    keySignature: -2,
    clefUpper: 'treble' as const,
    clefLower: 'bass' as const,
    events: [
        {
            index: 0,
            notes: [
                {
                    name: 'Bb3',
                    midi: 58,
                    staff: 'lower' as const,
                    x: 0.5,
                    y: 0.5,
                    w: 0.1,
                    h: 0.05,
                    finger: 2,
                    fingerConfidence: 'high' as const,
                    confidence: 'high' as const,
                },
                {
                    name: 'D4',
                    midi: 62,
                    staff: 'upper' as const,
                    x: 0.52,
                    y: 0.2,
                    w: 0.1,
                    h: 0.05,
                    finger: null,
                    fingerConfidence: 'low' as const,
                    confidence: 'medium' as const,
                },
            ],
        },
    ],
};

describe('recognizeResponseSchema', () => {
    it('accepts the edge function shape and rejects malformed payloads', () => {
        expect(recognizeResponseSchema.safeParse(validResponse).success).toBe(true);
        expect(recognizeResponseSchema.safeParse({ ...validResponse, ok: false }).success).toBe(false);
        expect(
            recognizeResponseSchema.safeParse({
                ...validResponse,
                events: [{ index: 0, notes: [{ midi: 60 }] }],
            }).success,
        ).toBe(false);
    });
});

describe('regionFromResponse', () => {
    const selection = { x: 0.1, y: 0.3, w: 0.4, h: 0.2 };
    const crop = { x: 0.08, y: 0.28, w: 0.44, h: 0.24 };

    it('maps region-image fractions back to page coordinates through the crop rect', () => {
        const region = regionFromResponse('doc-1', selection, crop, validResponse);
        const bb = region.notes[0]?.bbox;
        expect(bb?.x).toBeCloseTo(0.08 + 0.5 * 0.44);
        expect(bb?.y).toBeCloseTo(0.28 + 0.5 * 0.24);
        expect(bb?.w).toBeCloseTo(0.1 * 0.44);
        expect(bb?.h).toBeCloseTo(0.05 * 0.24);
    });

    it('carries fingers with source vision and respells names from midi + key', () => {
        const region = regionFromResponse('doc-1', selection, crop, validResponse);
        expect(region.source).toBe('vision');
        expect(region.keySignature).toBe(-2);
        const fingered = region.notes[0];
        expect(fingered?.annotatedFinger).toBe(2);
        expect(fingered?.fingerSource).toBe('vision');
        expect(fingered?.fingerConfidence).toBe('high');
        expect(fingered?.name).toBe('Bb3'); // flat spelling in a flat key
        const bare = region.notes[1];
        expect(bare?.annotatedFinger).toBeNull();
        expect(bare?.fingerSource).toBeNull();
        expect(bare?.fingerConfidence).toBeUndefined();
    });

    it('groups notes by the reported event index', () => {
        const twoEvents = {
            ...validResponse,
            events: [
                { index: 0, notes: [validResponse.events[0]!.notes[0]!] },
                { index: 1, notes: [validResponse.events[0]!.notes[1]!] },
            ],
        };
        const region = regionFromResponse('doc-1', selection, crop, twoEvents);
        expect(region.notes.map((n) => n.eventIndex)).toEqual([0, 1]);
    });
});
