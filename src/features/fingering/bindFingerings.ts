import type { Finger, RecognizedNote, RecognizedRegion } from '@/features/fingering/model';
import { inflateRect } from '@/features/fingering/selection';
import { annotationBboxNorm, annotationsInRect } from '@/features/viewer/ink/hitTest';
import { isTextPayload, type Annotation } from '@/types/models';

/**
 * The cheap non-AI path for reading fingerings off the page: app-native text
 * annotations that are single digits 1-5 inside the selection get spatially
 * bound to recognized noteheads. Vision reads the same digits from the
 * composited crop; mergeDigitBindings arbitrates the two.
 */

export interface RegionDigit {
    annotationId: string;
    finger: Finger;
    /** Center of the digit's text bbox, normalized page coords. */
    cx: number;
    cy: number;
}

const DIGIT_RE = /^[1-5]$/;
/** Digits often sit just outside the dragged rect — search a bit wider. */
const SEARCH_MARGIN = 0.03;

/** Single-digit (1-5) text annotations intersecting the region. */
export const collectRegionDigits = (
    annotations: Iterable<Annotation>,
    rect: RecognizedRegion['rect'],
    aspect: number,
): RegionDigit[] => {
    const searchRect = inflateRect(rect, SEARCH_MARGIN, SEARCH_MARGIN);
    const digits: RegionDigit[] = [];
    for (const annotation of annotationsInRect(annotations, searchRect, aspect)) {
        if (annotation.kind !== 'text' || !isTextPayload(annotation.payload)) {
            continue;
        }
        const text = annotation.payload.text.trim();
        if (!DIGIT_RE.test(text)) {
            continue;
        }
        const [minX, minY, maxX, maxY] = annotationBboxNorm(annotation, aspect);
        digits.push({
            annotationId: annotation.id,
            finger: Number(text) as Finger,
            cx: (minX + maxX) / 2,
            cy: (minY + maxY) / 2,
        });
    }
    return digits;
};

const xCenter = (n: RecognizedNote): number => n.bbox.x + n.bbox.w / 2;
const yCenter = (n: RecognizedNote): number => n.bbox.y + n.bbox.h / 2;

interface Candidate {
    digit: RegionDigit;
    note: RecognizedNote;
    score: number;
}

/**
 * Bind digits to notes and merge with any vision-attached fingerings.
 * Binding: greedy nearest x-center, one digit per note and vice versa, within
 * 1.5 × the median notehead width; a digit above a notehead prefers
 * upper-staff notes and below prefers lower-staff (matches how RH fingerings
 * sit above the system and LH below). Merge: vision keeps high-confidence
 * attachments; client fills gaps; on a medium/low-confidence disagreement an
 * UNAMBIGUOUS client binding wins, otherwise vision stays and the note is
 * flagged low-confidence for the review UI.
 */
export const bindRegionDigits = (
    region: RecognizedRegion,
    annotations: Iterable<Annotation>,
    aspect: number,
): RecognizedRegion => {
    const digits = collectRegionDigits(annotations, region.rect, aspect);
    const measurable = region.notes.filter((n) => n.bbox.w > 0);
    if (digits.length === 0 || measurable.length === 0) {
        return region;
    }

    const widths = measurable.map((n) => n.bbox.w).sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)] ?? 0.015;
    const threshold = 1.5 * median;

    const candidates: Candidate[] = [];
    const eligibleNotesPerDigit = new Map<string, number>();
    for (const digit of digits) {
        for (const note of measurable) {
            const dx = Math.abs(digit.cx - xCenter(note));
            if (dx > threshold) {
                continue;
            }
            const staffMatch = digit.cy <= yCenter(note) ? note.staff === 'upper' : note.staff === 'lower';
            candidates.push({ digit, note, score: dx + (staffMatch ? 0 : threshold / 2) });
            eligibleNotesPerDigit.set(digit.annotationId, (eligibleNotesPerDigit.get(digit.annotationId) ?? 0) + 1);
        }
    }
    candidates.sort(
        (a, b) => a.score - b.score || a.digit.cx - b.digit.cx || a.note.midi - b.note.midi,
    );

    const usedDigits = new Set<string>();
    const usedNotes = new Set<string>();
    const boundByNote = new Map<string, RegionDigit>();
    for (const { digit, note } of candidates) {
        if (usedDigits.has(digit.annotationId) || usedNotes.has(note.id)) {
            continue;
        }
        usedDigits.add(digit.annotationId);
        usedNotes.add(note.id);
        boundByNote.set(note.id, digit);
    }

    const notes = region.notes.map((note): RecognizedNote => {
        const digit = boundByNote.get(note.id);
        if (!digit) {
            return note;
        }
        if (note.annotatedFinger === null) {
            return { ...note, annotatedFinger: digit.finger, fingerSource: 'client-text' };
        }
        if (note.annotatedFinger === digit.finger) {
            // Agreement — the digit corroborates vision.
            return note.fingerConfidence === 'high' ? note : { ...note, fingerConfidence: 'high' };
        }
        // Disagreement. Vision high-confidence wins; otherwise an unambiguous
        // client binding (single eligible note) wins; otherwise flag for review.
        if (note.fingerSource === 'vision' && note.fingerConfidence !== 'high') {
            if ((eligibleNotesPerDigit.get(digit.annotationId) ?? 0) === 1) {
                return { ...note, annotatedFinger: digit.finger, fingerSource: 'client-text' };
            }
            return { ...note, confidence: 'low' };
        }
        return note;
    });

    return { ...region, notes };
};
