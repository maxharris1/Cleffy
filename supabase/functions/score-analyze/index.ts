import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey } from '../_shared/rateLimit.ts';

/**
 * Kick off play-along analysis for a document: verify the caller may request
 * it, mint a signed URL for the PDF, record a 'pending' score_analyses row,
 * and hand the job to the OMR service. The service writes every later state
 * (processing heartbeats, ready/failed) with its service-role key; this
 * function never waits for transcription.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matches the OMR service's own guard; keeps one scan from monopolizing it for an hour. */
const MAX_ANALYZABLE_PAGES = 60;

/** A pending/processing row older than this is considered lost (service died). */
const STALE_PROCESSING_MS = 20 * 60 * 1000;

/** Signed-URL TTL: must outlive the service's queue wait — it downloads at job start. */
const SIGNED_URL_TTL_SEC = 3600;

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`analyze:${clientKey(req)}`, 5, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body: { documentId?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    if (!documentId || !uuidRe.test(documentId)) {
        return jsonResponse({ error: 'documentId must be a UUID' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // User-scoped client: RLS decides who may request analyses, and the signed
    // URL is minted with the caller's own storage read access.
    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userError || !userId) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const { data: role, error: roleError } = await userClient.rpc('document_role', { doc: documentId });
    if (roleError || (role !== 'owner' && role !== 'editor')) {
        return jsonResponse({ error: 'Only owners and editors can generate play-along' }, 403);
    }

    const { data: doc, error: docError } = await userClient
        .from('documents')
        .select('id, storage_path, page_count')
        .eq('id', documentId)
        .maybeSingle();
    if (docError || !doc) {
        return jsonResponse({ error: 'Document not found or not accessible' }, 403);
    }

    const upsertRow = (patch: Record<string, unknown>) =>
        userClient.from('score_analyses').upsert(
            {
                document_id: documentId,
                created_by: userId,
                progress: null,
                error: null,
                score: null,
                ...patch,
            },
            { onConflict: 'document_id' },
        );

    if (doc.storage_path !== `${documentId}/original.pdf`) {
        return jsonResponse({ error: 'Document storage path is invalid' }, 400);
    }

    if (typeof doc.page_count !== 'number' || !Number.isFinite(doc.page_count) || doc.page_count < 1) {
        await upsertRow({ status: 'failed', error: 'page_count_unknown' });
        return jsonResponse({ ok: false, code: 'page_count_unknown' }, 400);
    }

    if (doc.page_count > MAX_ANALYZABLE_PAGES) {
        await upsertRow({ status: 'failed', error: 'too_large' });
        return jsonResponse({ ok: false, code: 'too_large', maxPages: MAX_ANALYZABLE_PAGES }, 400);
    }

    // Don't double-run a job that is plausibly still alive.
    const { data: existing } = await userClient
        .from('score_analyses')
        .select('status, updated_at')
        .eq('document_id', documentId)
        .maybeSingle();
    if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
        const age = Date.now() - new Date(existing.updated_at).getTime();
        if (age < STALE_PROCESSING_MS) {
            return jsonResponse({ ok: false, code: 'already_running' }, 409);
        }
    }

    const { data: signed, error: signError } = await userClient.storage
        .from('scores')
        .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SEC);
    if (signError || !signed?.signedUrl) {
        return jsonResponse({ error: 'Could not sign PDF URL' }, 502);
    }

    const { error: pendingError } = await upsertRow({ status: 'pending' });
    if (pendingError) {
        return jsonResponse({ error: 'Could not record analysis' }, 500);
    }

    const serviceUrl = Deno.env.get('OMR_SERVICE_URL');
    const serviceSecret = Deno.env.get('OMR_SERVICE_SECRET');
    if (!serviceUrl || !serviceSecret) {
        await upsertRow({ status: 'failed', error: 'service_unreachable' });
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    try {
        const res = await fetch(`${serviceUrl.replace(/\/$/, '')}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-omr-secret': serviceSecret },
            body: JSON.stringify({
                documentId,
                pdfSignedUrl: signed.signedUrl,
                pageCount: doc.page_count,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429) {
            await upsertRow({ status: 'failed', error: 'queue_full' });
            return jsonResponse({ ok: false, code: 'queue_full' }, 503);
        }
        if (!res.ok) {
            await upsertRow({ status: 'failed', error: 'service_unreachable' });
            return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
        }
    } catch {
        await upsertRow({ status: 'failed', error: 'service_unreachable' });
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    return jsonResponse({ ok: true, documentId, status: 'pending' }, 202);
});
