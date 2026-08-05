import { z } from 'zod';

import {
    clampMidi,
    midiToName,
    type Clef,
    type Finger,
    type NormRect,
    type RecognizedNote,
    type RecognizedRegion,
} from '@/features/fingering/model';
import type { RegionImages } from '@/features/fingering/regionCrop';
import { getSupabase } from '@/lib/supabase';

/**
 * Client for the analyze-notes edge function. Raw fetch (analyzeApi
 * precedent) so structured error bodies are readable. EVERY failure — auth,
 * rate limit, AI down, malformed response — resolves to null: the flow
 * degrades to manual note entry.
 */

const confidenceSchema = z.enum(['high', 'medium', 'low']);

const recognizeResponseSchema = z.object({
    ok: z.literal(true),
    page: z.number(),
    keySignature: z.number(),
    clefUpper: z.enum(['treble', 'bass', 'alto', 'tenor', 'none']),
    clefLower: z.enum(['treble', 'bass', 'none']),
    events: z.array(
        z.object({
            index: z.number(),
            notes: z.array(
                z.object({
                    name: z.string(),
                    midi: z.number(),
                    staff: z.enum(['upper', 'lower']),
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                    finger: z.number().nullable(),
                    fingerConfidence: confidenceSchema,
                    confidence: confidenceSchema,
                }),
            ),
        }),
    ),
});

export type RecognizeResponse = z.infer<typeof recognizeResponseSchema>;

export { recognizeResponseSchema };

/**
 * Map the edge function's reading into the domain model. Notehead bboxes come
 * back as fractions of the REGION image — convert to page coords through the
 * crop rect that image actually covered. Pure — unit-tested directly.
 */
export const regionFromResponse = (
    docId: string,
    selectionRect: NormRect,
    cropRect: NormRect,
    data: RecognizeResponse,
): RecognizedRegion => {
    const notes: RecognizedNote[] = [];
    for (const event of data.events) {
        for (const note of event.notes) {
            const midi = clampMidi(note.midi);
            const finger =
                note.finger !== null && note.finger >= 1 && note.finger <= 5
                    ? (Math.round(note.finger) as Finger)
                    : null;
            notes.push({
                id: crypto.randomUUID(),
                midi,
                // Respell locally so display is always consistent with midi.
                name: midiToName(midi, data.keySignature),
                staff: note.staff,
                bbox: {
                    x: cropRect.x + note.x * cropRect.w,
                    y: cropRect.y + note.y * cropRect.h,
                    w: note.w * cropRect.w,
                    h: note.h * cropRect.h,
                },
                eventIndex: event.index,
                annotatedFinger: finger,
                fingerSource: finger !== null ? 'vision' : null,
                fingerConfidence: finger !== null ? note.fingerConfidence : undefined,
                confidence: note.confidence,
            });
        }
    }
    return {
        docId,
        page: data.page,
        rect: selectionRect,
        keySignature: data.keySignature,
        clefs: { upper: data.clefUpper as Clef, lower: data.clefLower as Clef },
        notes,
        handOf: { upper: 'R', lower: 'L' },
        source: 'vision',
    };
};

export type RecognizeNotesFn = (
    pageIndex: number,
    rect: NormRect,
    images: RegionImages,
    signal?: AbortSignal,
) => Promise<RecognizedRegion | null>;

/** Build the recognition fn for a cloud document the caller is a member of. */
export const makeRecognizeNotesFn = (docId: string): RecognizeNotesFn => {
    return async (pageIndex, rect, images, signal): Promise<RecognizedRegion | null> => {
        try {
            const supabase = getSupabase();
            const { data: sessionData } = await supabase.auth.getSession();
            const accessToken = sessionData.session?.access_token;
            if (!accessToken) {
                return null;
            }

            const projectUrl = import.meta.env.VITE_SUPABASE_URL as string;
            const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
            const response = await fetch(`${projectUrl}/functions/v1/analyze-notes`, {
                method: 'POST',
                signal,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    apikey: anonKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    documentId: docId,
                    page: pageIndex,
                    region: rect,
                    regionImage: images.regionImage,
                    contextImage: images.contextImage,
                }),
            });
            if (!response.ok) {
                return null;
            }
            const parsed = recognizeResponseSchema.safeParse(await response.json());
            if (!parsed.success) {
                console.warn('Ignoring malformed analyze-notes response', parsed.error.issues[0]?.message);
                return null;
            }
            return regionFromResponse(docId, rect, images.cropRect, parsed.data);
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                throw err;
            }
            console.warn('Note recognition unavailable', err);
            return null;
        }
    };
};
