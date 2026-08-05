import { describe, expect, it } from 'vitest';

import {
    buildFingeringProposals,
    canPlaceProposals,
    SUGGESTED_FINGERING_COLOR,
} from '@/features/fingering/applyFingerings';
import {
    emptyRegion,
    type FingeringSequence,
    type Hand,
    type RecognizedNote,
    type RecognizedRegion,
} from '@/features/fingering/model';
import { parseDbChange } from '@/sync/wire';
import { isTextPayload, type Annotation, type TextPayload } from '@/types/models';

const ASPECT = 0.75;

const note = (overrides: Partial<RecognizedNote>): RecognizedNote => ({
    id: overrides.id ?? crypto.randomUUID(),
    midi: 60,
    name: 'C4',
    staff: 'upper',
    bbox: { x: 0.3, y: 0.4, w: 0.015, h: 0.01 },
    eventIndex: 0,
    annotatedFinger: null,
    fingerSource: null,
    confidence: 'high',
    ...overrides,
});

const regionWith = (notes: RecognizedNote[]): RecognizedRegion => ({
    ...emptyRegion('doc-1', 2, { x: 0.2, y: 0.3, w: 0.4, h: 0.2 }),
    notes,
    source: 'vision',
});

const sequencesFor = (
    region: RecognizedRegion,
    fingers: Record<string, number>,
): Record<Hand, FingeringSequence | null> => {
    const result: Record<Hand, FingeringSequence | null> = { L: null, R: null };
    for (const hand of ['L', 'R'] as const) {
        const notes = region.notes.filter((n) => region.handOf[n.staff] === hand);
        if (notes.length === 0) {
            continue;
        }
        result[hand] = {
            hand,
            source: 'suggested',
            events: [
                {
                    index: 0,
                    hand,
                    notes: notes
                        .sort((a, b) => a.midi - b.midi)
                        .map((n) => ({
                            noteId: n.id,
                            midi: n.midi,
                            finger: (fingers[n.id] ?? null) as FingeringSequence['events'][number]['notes'][number]['finger'],
                        })),
                },
            ],
        };
    }
    return result;
};

const build = (region: RecognizedRegion, fingers: Record<string, number>, existing: Annotation[] = []) =>
    buildFingeringProposals({
        region,
        sequences: sequencesFor(region, fingers),
        existing,
        aspect: ASPECT,
        docId: 'doc-1',
    });

const payloadOf = (a: Annotation): TextPayload => {
    if (!isTextPayload(a.payload)) {
        throw new Error('expected text payload');
    }
    return a.payload;
};

describe('buildFingeringProposals', () => {
    it('places RH digits above the notehead and LH digits below, as teal sf-flagged text', () => {
        const region = regionWith([
            note({ id: 'r', staff: 'upper', bbox: { x: 0.3, y: 0.4, w: 0.015, h: 0.01 } }),
            note({ id: 'l', staff: 'lower', midi: 48, bbox: { x: 0.3, y: 0.6, w: 0.015, h: 0.01 } }),
        ]);
        const proposals = build(region, { r: 1, l: 5 });
        expect(proposals).toHaveLength(2);
        for (const proposal of proposals) {
            expect(proposal.kind).toBe('text');
            expect(proposal.color).toBe(SUGGESTED_FINGERING_COLOR);
            expect(proposal.page).toBe(2);
            expect(payloadOf(proposal).sf).toBe(1);
        }
        const rh = proposals.find((p) => payloadOf(p).text === '1');
        const lh = proposals.find((p) => payloadOf(p).text === '5');
        expect(rh && payloadOf(rh).y).toBeLessThan(0.4);
        expect(lh && payloadOf(lh).y).toBeGreaterThan(0.61);
        // Digit is horizontally centered on its notehead.
        expect(rh && payloadOf(rh).x + 0.3 * payloadOf(rh).size).toBeCloseTo(0.3 + 0.015 / 2, 5);
    });

    it('stacks chord digits outward from the staff in pitch order', () => {
        const region = regionWith([
            note({ id: 'low', midi: 60, bbox: { x: 0.3, y: 0.42, w: 0.015, h: 0.01 } }),
            note({ id: 'high', midi: 67, bbox: { x: 0.3, y: 0.4, w: 0.015, h: 0.01 } }),
        ]);
        const proposals = build(region, { low: 1, high: 5 });
        const lowDigit = proposals.find((p) => payloadOf(p).text === '1');
        const highDigit = proposals.find((p) => payloadOf(p).text === '5');
        // RH: the higher note's digit sits nearest the staff, lower stacked above.
        expect(highDigit && payloadOf(highDigit).y).toBeGreaterThan(lowDigit ? payloadOf(lowDigit).y : -1);
    });

    it('skips notes whose fingering is already written on the page, and unanchored notes', () => {
        const region = regionWith([
            note({ id: 'marked', annotatedFinger: 3, fingerSource: 'vision' }),
            note({ id: 'client', annotatedFinger: 2, fingerSource: 'client-text' }),
            note({ id: 'manual', bbox: { x: 0, y: 0, w: 0, h: 0 } }),
            note({ id: 'fresh', bbox: { x: 0.35, y: 0.4, w: 0.015, h: 0.01 } }),
        ]);
        const proposals = build(region, { marked: 3, client: 2, manual: 4, fresh: 1 });
        expect(proposals).toHaveLength(1);
        expect(payloadOf(proposals[0] as Annotation).text).toBe('1');
    });

    it('nudges away from a colliding existing text annotation', () => {
        const region = regionWith([note({ id: 'r' })]);
        const clean = build(region, { r: 2 });
        const cleanY = payloadOf(clean[0] as Annotation).y;
        const blocker: Annotation = {
            id: 'blocker',
            docId: 'doc-1',
            page: 2,
            kind: 'text',
            color: '#dc2626',
            payload: { x: 0.297, y: cleanY, text: '4', size: 0.02 },
            createdBy: null,
            createdAt: '2026-08-05T00:00:00.000Z',
            updatedAt: '2026-08-05T00:00:00.000Z',
            deletedAt: null,
            seq: 1,
        };
        const nudged = build(region, { r: 2 }, [blocker]);
        // RH digits nudge upward (smaller y), never fail.
        expect(payloadOf(nudged[0] as Annotation).y).toBeLessThan(cleanY);
        expect(nudged).toHaveLength(1);
    });

    it('produces payloads that survive the realtime wire schema with sf intact', () => {
        const region = regionWith([note({ id: 'r' })]);
        const proposal = build(region, { r: 3 })[0] as Annotation;
        const row = parseDbChange({
            operation: 'INSERT',
            schema: 'public',
            table: 'annotations',
            record: {
                id: proposal.id,
                document_id: 'doc-1',
                page: proposal.page,
                kind: proposal.kind,
                color: proposal.color,
                payload: proposal.payload,
                created_by: 'user-1',
                created_at: proposal.createdAt,
                updated_at: proposal.updatedAt,
                deleted_at: null,
                seq: 7,
            },
        });
        expect(row).not.toBeNull();
        expect((row?.payload as TextPayload).sf).toBe(1);
        expect((row?.payload as TextPayload).text).toBe('3');
    });
});

describe('canPlaceProposals', () => {
    it('requires at least one page-anchored note', () => {
        expect(canPlaceProposals(regionWith([note({})]))).toBe(true);
        expect(canPlaceProposals(regionWith([note({ bbox: { x: 0, y: 0, w: 0, h: 0 } })]))).toBe(false);
    });
});
