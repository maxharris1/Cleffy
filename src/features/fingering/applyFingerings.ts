import { MAX_TEXT_SIZE, MIN_TEXT_SIZE } from '@/features/import/textFit';
import type { FingeringSequence, Hand, RecognizedNote, RecognizedRegion } from '@/features/fingering/model';
import { annotationBboxNorm } from '@/features/viewer/ink/hitTest';
import type { Annotation, TextPayload } from '@/types/models';

/**
 * Turn suggested fingerings into proposed text annotations placed by their
 * noteheads — RH digits above, LH digits below, chord digits stacked outward
 * in pitch order. Proposals are ordinary 1-char `text` annotations (distinct
 * teal color + `sf` provenance flag), so they sync, erase, undo, and export
 * exactly like handwriting; the caller previews them via the store's
 * history-overlay and commits with createMany as one undo batch.
 */

/** Teal — deliberately NOT in STROKE_COLORS so it never collides with ink. */
export const SUGGESTED_FINGERING_COLOR = '#0d9488';

/** Digit cap height ≈ 1.2 × notehead height (fontPx ≈ cap / 0.7). */
const CAP_PER_NOTEHEAD = 1.2 / 0.7;
/** Gap between a notehead (or the previous digit) and the digit, in notehead heights. */
const GAP_FACTOR = 0.4;
/** Nudge step away from the staff when a digit collides, in line heights. */
const NUDGE_FACTOR = 0.8;
const MAX_NUDGES = 3;

interface Placement {
    note: RecognizedNote;
    hand: Hand;
    finger: number;
    /** 0 = nearest the staff within its chord stack. */
    rank: number;
}

export interface FingeringProposalsInput {
    region: RecognizedRegion;
    sequences: Record<Hand, FingeringSequence | null>;
    /** Committed annotations near the region (collision targets). */
    existing: readonly Annotation[];
    /** Page width / height in base units (converts width scalars to y). */
    aspect: number;
    docId: string;
}

export const buildFingeringProposals = ({
    region,
    sequences,
    existing,
    aspect,
    docId,
}: FingeringProposalsInput): Annotation[] => {
    const notesById = new Map(region.notes.map((n) => [n.id, n]));

    // Collect placements: suggested fingers for notes that (a) have a page
    // anchor and (b) don't already carry a digit read off the page.
    const placements: Placement[] = [];
    for (const hand of ['L', 'R'] as const) {
        for (const event of sequences[hand]?.events ?? []) {
            const eventNotes = event.notes
                .map((n) => ({ fingered: n, note: notesById.get(n.noteId) }))
                .filter(
                    (x): x is { fingered: (typeof event.notes)[number]; note: RecognizedNote } =>
                        x.note !== undefined &&
                        x.fingered.finger !== null &&
                        x.note.bbox.w > 0 &&
                        // Already marked on the page — don't double-mark.
                        x.note.fingerSource !== 'vision' &&
                        x.note.fingerSource !== 'client-text',
                );
            // Stack outward from the staff: RH highest-first above, LH lowest-first below.
            const ordered = [...eventNotes].sort((a, b) =>
                hand === 'R' ? b.note.midi - a.note.midi : a.note.midi - b.note.midi,
            );
            ordered.forEach(({ fingered, note }, rank) => {
                placements.push({ note, hand, finger: fingered.finger as number, rank });
            });
        }
    }

    const now = new Date().toISOString();
    const proposals: Annotation[] = [];
    const placedBoxes: Array<[number, number, number, number]> = [];
    const existingBoxes = existing
        .filter((a) => a.kind === 'text')
        .map((a) => annotationBboxNorm(a, aspect));

    for (const placement of placements) {
        const { note, hand, finger, rank } = placement;
        const size = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, (CAP_PER_NOTEHEAD * note.bbox.h) / aspect));
        const lineH = size * 1.25 * aspect;
        const gap = GAP_FACTOR * note.bbox.h;
        const x = note.bbox.x + note.bbox.w / 2 - 0.3 * size; // center the ~0.6·size digit
        const away = (steps: number): number =>
            hand === 'R'
                ? note.bbox.y - gap - lineH - (rank + steps) * lineH * 1.1
                : note.bbox.y + note.bbox.h + gap + (rank + steps) * lineH * 1.1;

        let y = away(0);
        for (let nudge = 0; nudge < MAX_NUDGES; nudge++) {
            const box: [number, number, number, number] = [x, y, x + 0.6 * size, y + lineH];
            const collides = [...existingBoxes, ...placedBoxes].some(
                ([minX, minY, maxX, maxY]) => box[0] <= maxX && box[2] >= minX && box[1] <= maxY && box[3] >= minY,
            );
            if (!collides) {
                break;
            }
            y = hand === 'R' ? y - NUDGE_FACTOR * lineH : y + NUDGE_FACTOR * lineH;
        }
        placedBoxes.push([x, y, x + 0.6 * size, y + lineH]);

        const payload: TextPayload = {
            x: Math.min(1, Math.max(0, x)),
            y: Math.min(1, Math.max(0, y)),
            text: String(finger),
            size,
            sf: 1,
        };
        proposals.push({
            id: crypto.randomUUID(),
            docId,
            page: region.page,
            kind: 'text',
            color: SUGGESTED_FINGERING_COLOR,
            payload,
            createdBy: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            seq: 0,
        });
    }
    return proposals;
};

/** True when a region can host proposals at all (vision anchors present). */
export const canPlaceProposals = (region: RecognizedRegion): boolean =>
    region.notes.some((n) => n.bbox.w > 0);
