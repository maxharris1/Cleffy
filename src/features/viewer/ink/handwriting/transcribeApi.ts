import { z } from 'zod';

import type { EncodedImage } from '@/features/import/pageRaster';
import type { StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import { renderGroupJpeg } from '@/features/viewer/ink/handwriting/inkRaster';
import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';

/**
 * Client for the transcribe-ink edge function (analyzeApi precedent: raw
 * fetch so structured error bodies are readable). EVERY failure — offline,
 * auth, rate limit, AI down, malformed response — resolves to null and the
 * handwriting simply stays ink. This is a metered call (the owner's
 * vision_reads); the controller only reaches for it on a writing line the
 * on-device reader refused, never for digits or dynamics.
 */

const transcribeResponseSchema = z.object({
    ok: z.literal(true),
    page: z.number(),
    text: z.string().nullable(),
});

/** Transcribe one grouped writing line; null = leave the ink. */
export type TranscribeInkFn = (group: StrokeGroup) => Promise<string | null>;

export interface TranscribeInkDeps {
    render?: (group: StrokeGroup) => Promise<EncodedImage>;
    fetchImpl?: typeof fetch;
    isOnline?: () => boolean;
}

const defaultIsOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Build the transcription fn for a cloud document the caller can write on. */
export const makeTranscribeInkFn = (docId: string, deps: TranscribeInkDeps = {}): TranscribeInkFn => {
    const render = deps.render ?? renderGroupJpeg;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const isOnline = deps.isOnline ?? defaultIsOnline;
    return async (group): Promise<string | null> => {
        if (!isOnline()) {
            return null;
        }
        try {
            const supabase = getSupabase();
            const { data: sessionData } = await supabase.auth.getSession();
            const accessToken = sessionData.session?.access_token;
            if (!accessToken) {
                return null;
            }
            const image = await render(group);
            const { url: projectUrl, anonKey } = requireSupabaseConfig();
            const response = await fetchImpl(`${projectUrl}/functions/v1/transcribe-ink`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    apikey: anonKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ documentId: docId, page: group.page, image }),
            });
            if (!response.ok) {
                return null;
            }
            const parsed = transcribeResponseSchema.safeParse(await response.json());
            if (!parsed.success) {
                console.warn('Ignoring malformed transcribe-ink response', parsed.error.issues[0]?.message);
                return null;
            }
            const text = parsed.data.text?.trim() ?? '';
            return text === '' ? null : text;
        } catch (err) {
            console.warn('Handwriting transcription unavailable; ink stays', err);
            return null;
        }
    };
};
