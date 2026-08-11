import { describe, expect, it } from 'vitest';

import {
    ifrNotesFromSequences,
    irrationalFingeringRate,
    matchRate,
} from '@/features/fingering/engine/evalMetrics';
import { EVAL_FIXTURES } from '@/features/fingering/engine/fixtures/evalCases';
import { suggestForRegion } from '@/features/fingering/engine/suggest';
import { emptyRegion, type RecognizedNote, type RecognizedRegion } from '@/features/fingering/model';

const regionFromFixture = (notes: RecognizedNote[]): RecognizedRegion => ({
    ...emptyRegion('eval', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
    notes,
    source: 'omr',
});

describe('matchRate', () => {
    it('scores exact multi-truth agreement', () => {
        const predicted = [
            { noteId: 'a', finger: 1 as const },
            { noteId: 'b', finger: 3 as const },
        ];
        const truthA = [
            { noteId: 'a', finger: 1 as const },
            { noteId: 'b', finger: 2 as const },
        ];
        const truthB = [
            { noteId: 'a', finger: 1 as const },
            { noteId: 'b', finger: 3 as const },
        ];
        expect(matchRate(predicted, [truthA, truthB])).toBe(1);
        expect(matchRate(predicted, [truthA])).toBe(0.5);
    });
});

describe('eval fixtures', () => {
    for (const fixture of EVAL_FIXTURES) {
        it(`${fixture.id}: ${fixture.description}`, () => {
            const notes: RecognizedNote[] = fixture.notes.map((n) => ({
                id: n.id,
                midi: n.midi,
                name: `n${n.midi}`,
                staff: n.staff,
                bbox: { x: 0, y: 0, w: 0, h: 0 },
                eventIndex: n.eventIndex,
                annotatedFinger: null,
                fingerSource: null,
                confidence: 'high',
            }));
            const sequences = suggestForRegion(regionFromFixture(notes), false, 'standard');
            const ifrNotes = ifrNotesFromSequences(sequences);
            const ifr = irrationalFingeringRate(ifrNotes, 'standard');

            if (fixture.expectPlayable) {
                expect(ifr).toBe(0);
            } else {
                expect(ifr).toBeGreaterThan(0);
            }

            const withTruth = fixture.notes.filter((n) => n.truthFinger !== undefined);
            if (withTruth.length > 0) {
                const predicted = ifrNotes.map((n) => ({ noteId: n.noteId, finger: n.finger }));
                const truth = withTruth.map((n) => ({
                    noteId: n.id,
                    finger: n.truthFinger!,
                }));
                expect(matchRate(predicted, [truth])).toBe(1);
            }
        });
    }
});
