import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, serviceClient } from '../_shared/rateLimit.ts';

/**
 * Kick off play-along analysis.
 *
 * OMR_QUEUE_MODE=pull: auth + omr_enqueue_job RPC + fire-and-forget /poke.
 * OMR_QUEUE_MODE=push (default until cutover): mint signed URL + POST /jobs.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ANALYZABLE_PAGES = 60;
const STALE_PROCESSING_MS = 20 * 60 * 1000;
const SIGNED_URL_TTL_SEC = 3600;
const PER_USER_BACKLOG_CAP = 10;

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
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

    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await userClient.auth.getUser();
    const userId = userData?.user?.id;
    if (userError || !userId) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const rate = await checkRateLimit(`analyze:user:${userId}`, 20, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
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

    if (doc.storage_path !== `${documentId}/original.pdf`) {
        return jsonResponse({ error: 'Document storage path is invalid' }, 400);
    }

    const pageFail = await rejectBadPageCount(userClient, documentId, userId, doc.page_count);
    if (pageFail) {
        return pageFail;
    }

    const queueMode = (Deno.env.get('OMR_QUEUE_MODE') ?? 'push').toLowerCase();
    if (queueMode === 'pull') {
        return await handlePull(userId, documentId, doc.storage_path, doc.page_count as number);
    }
    return await handlePush(userClient, userId, documentId, doc.storage_path, doc.page_count as number);
});

type UserClient = ReturnType<typeof createClient>;

const rejectBadPageCount = async (
    userClient: UserClient,
    documentId: string,
    userId: string,
    pageCount: unknown,
): Promise<Response | null> => {
    if (typeof pageCount !== 'number' || !Number.isFinite(pageCount) || pageCount < 1) {
        await upsertAnalysis(userClient, documentId, userId, {
            status: 'failed',
            error: 'page_count_unknown',
        });
        return jsonResponse({ ok: false, code: 'page_count_unknown' }, 400);
    }
    if (pageCount > MAX_ANALYZABLE_PAGES) {
        await upsertAnalysis(userClient, documentId, userId, {
            status: 'failed',
            error: 'too_large',
        });
        return jsonResponse({ ok: false, code: 'too_large', maxPages: MAX_ANALYZABLE_PAGES }, 400);
    }
    return null;
};

const upsertAnalysis = (
    userClient: UserClient,
    documentId: string,
    userId: string,
    patch: Record<string, unknown>,
) =>
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

const handlePull = async (
    userId: string,
    documentId: string,
    storagePath: string,
    pageCount: number,
): Promise<Response> => {
    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    const { data, error } = await admin.rpc('omr_enqueue_job', {
        p_document_id: documentId,
        p_user_id: userId,
        p_storage_path: storagePath,
        p_page_count: pageCount,
        p_cap: PER_USER_BACKLOG_CAP,
    });
    if (error) {
        console.error('[score-analyze] enqueue', error.message);
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    const result = data as { ok?: boolean; code?: string } | null;
    if (!result?.ok) {
        const code = result?.code ?? 'service_unreachable';
        if (code === 'backlog_full') {
            return jsonResponse({ ok: false, code: 'backlog_full' }, 429);
        }
        if (code === 'already_running') {
            return jsonResponse({ ok: false, code: 'already_running' }, 409);
        }
        return jsonResponse({ ok: false, code }, 502);
    }

    void pokeWorker().catch(() => undefined);
    return jsonResponse({ ok: true, documentId, status: 'pending' }, 202);
};

const handlePush = async (
    userClient: UserClient,
    userId: string,
    documentId: string,
    storagePath: string,
    pageCount: number,
): Promise<Response> => {
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
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (signError || !signed?.signedUrl) {
        return jsonResponse({ error: 'Could not sign PDF URL' }, 502);
    }

    const { error: pendingError } = await upsertAnalysis(userClient, documentId, userId, { status: 'pending' });
    if (pendingError) {
        return jsonResponse({ error: 'Could not record analysis' }, 500);
    }

    const serviceUrl = Deno.env.get('OMR_SERVICE_URL');
    const serviceSecret = Deno.env.get('OMR_SERVICE_SECRET');
    if (!serviceUrl || !serviceSecret) {
        await upsertAnalysis(userClient, documentId, userId, { status: 'failed', error: 'service_unreachable' });
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    try {
        const res = await fetch(`${serviceUrl.replace(/\/$/, '')}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-omr-secret': serviceSecret },
            body: JSON.stringify({ documentId, pdfSignedUrl: signed.signedUrl, pageCount }),
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429) {
            await upsertAnalysis(userClient, documentId, userId, { status: 'failed', error: 'queue_full' });
            return jsonResponse({ ok: false, code: 'queue_full' }, 503);
        }
        if (!res.ok) {
            await upsertAnalysis(userClient, documentId, userId, { status: 'failed', error: 'service_unreachable' });
            return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
        }
    } catch {
        await upsertAnalysis(userClient, documentId, userId, { status: 'failed', error: 'service_unreachable' });
        return jsonResponse({ ok: false, code: 'service_unreachable' }, 502);
    }

    return jsonResponse({ ok: true, documentId, status: 'pending' }, 202);
};

const pokeWorker = async (): Promise<void> => {
    const serviceUrl = Deno.env.get('OMR_SERVICE_URL');
    const serviceSecret = Deno.env.get('OMR_SERVICE_SECRET');
    if (!serviceUrl || !serviceSecret) {
        return;
    }
    await fetch(`${serviceUrl.replace(/\/$/, '')}/poke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-omr-secret': serviceSecret },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
    });
};
