import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { geminiApiKey, geminiGenerateText } from '../_shared/gemini.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { enforce, refund } from '../_shared/quota.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import { cleanTranscription, TRANSCRIBE_PROMPT } from '../_shared/transcription.ts';

/**
 * Handwriting → print, text-note path: the writer's on-device reader refused
 * a grouped writing line, so the client sends a small raster of just that
 * ink and asks for a transcription. Plain text back; the client swaps the
 * strokes for one print note (or leaves the ink when we return nothing).
 *
 * Mirrors analyze-annotations: JWT required (config.toml), strict body
 * budgets, per-IP and per-user rate limits (fail closed), and `vision_reads`
 * metering. Only the document OWNER may call this (an editor's local Print
 * toggle must not auto-bill the teacher). Unreadable ink refunds the credit.
 * Never called for digits or dynamics — those never leave the device.
 *
 * Model: Gemini Flash-Lite via generativelanguage.googleapis.com, key from
 * GEMINI_API_KEY (fallbacks GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_API_KEY).
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transcriptions per user per hour / per IP per hour. */
const USER_LIMIT = 240;
const IP_LIMIT = 480;
const WINDOW_MS = 3_600_000;

/** Base64 length budget for the ink crop (≈ 190 KB binary — a line of handwriting, not a page). */
const MAX_IMAGE_B64 = 260_000;
const MAX_BODY_BYTES = 512 * 1024;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface TranscribeBody {
    documentId?: string;
    page?: number;
    image?: { mediaType?: string; dataBase64?: string };
}

const badImage = (img: TranscribeBody['image']): boolean =>
    !img ||
    typeof img.mediaType !== 'string' ||
    !IMAGE_TYPES.has(img.mediaType) ||
    typeof img.dataBase64 !== 'string' ||
    img.dataBase64.length === 0 ||
    img.dataBase64.length > MAX_IMAGE_B64;

/** Gateway already verified the JWT (`verify_jwt = true`); read `sub` for the user rate bucket. */
const userIdFromBearer = (authHeader: string): string | null => {
    const token = authHeader.slice('Bearer '.length).trim();
    const payload = token.split('.')[1];
    if (!payload) {
        return null;
    }
    try {
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
        const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
        const json = JSON.parse(atob(padded + pad)) as { sub?: unknown };
        return typeof json.sub === 'string' && json.sub.length > 0 ? json.sub : null;
    } catch {
        return null;
    }
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const contentLength = Number(req.headers.get('content-length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Request too large' }, 413);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const [ipRate, parsedBody] = await Promise.all([
        checkRateLimit(`transcribe-ip:${clientKey(req)}`, IP_LIMIT, WINDOW_MS),
        readCappedJson<TranscribeBody>(req, MAX_BODY_BYTES),
    ]);
    if (!ipRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: ipRate.retryAfterSec }, 429);
    }

    if (!parsedBody.ok) {
        return jsonResponse(
            parsedBody.status === 413 ? { error: 'Request too large' } : { error: 'Invalid JSON body' },
            parsedBody.status,
        );
    }
    const body = parsedBody.value;

    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    if (!documentId || !uuidRe.test(documentId)) {
        return jsonResponse({ error: 'documentId must be a UUID' }, 400);
    }
    const page = body.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
        return jsonResponse({ error: 'page must be a non-negative integer' }, 400);
    }
    if (badImage(body.image)) {
        return jsonResponse({ error: 'image missing or over budget' }, 400);
    }

    const userId = userIdFromBearer(authHeader);
    if (!userId) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // User-scoped client — RLS and document_role() decide access, never service role.
    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const [userRate, roleResult, docResult] = await Promise.all([
        checkRateLimit(`transcribe:${userId}`, USER_LIMIT, WINDOW_MS),
        userClient.rpc('document_role', { doc: documentId }),
        userClient.from('documents').select('owner_id').eq('id', documentId).maybeSingle(),
    ]);
    if (!userRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: userRate.retryAfterSec }, 429);
    }

    // Only the owner may fire the metered path — a student's Print toggle
    // must not drain the teacher's vision_reads on doodles.
    if (roleResult.error || roleResult.data !== 'owner') {
        return jsonResponse({ error: 'Only the score owner can transcribe handwriting' }, 403);
    }

    // The read bills the score's owner (teacher-pays) — members can read the row under RLS.
    if (docResult.error || !docResult.data) {
        return jsonResponse({ error: 'Not a member of this score' }, 403);
    }
    const ownerId = docResult.data.owner_id as string;

    const apiKey = geminiApiKey((name) => Deno.env.get(name));
    if (!apiKey) {
        // Not configured — the client quietly leaves the ink.
        return jsonResponse({ error: 'Transcription is not configured', code: 'ai_unavailable' }, 503);
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Transcription is not configured', code: 'ai_unavailable' }, 503);
    }

    // Meter last, right before the model call.
    const gate = await enforce(admin, ownerId, 'vision_reads');
    if (!gate.ok) {
        return jsonResponse(gate.body, gate.status);
    }
    const giveBack = async (): Promise<void> => {
        if (gate.consumed) {
            await refund(admin, ownerId, 'vision_reads');
        }
    };

    try {
        const { text: raw, model } = await geminiGenerateText({
            apiKey,
            image: { mimeType: body.image!.mediaType!, data: body.image!.dataBase64! },
            prompt: TRANSCRIBE_PROMPT,
            signal: AbortSignal.timeout(30_000),
        });
        const text = cleanTranscription(raw);
        if (text === null) {
            await giveBack();
        }
        return jsonResponse({ ok: true, page, text, model });
    } catch (err) {
        console.error('transcribe-ink model call failed', err);
        await giveBack();
        return jsonResponse({ error: 'Transcription unavailable', code: 'ai_unavailable' }, 502);
    }
});
