import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, tryDownloadPdf } from '../_shared/imslp.ts';

const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`download:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body: { filename?: string; acceptedDisclaimer?: boolean; documentId?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const filename = typeof body.filename === 'string' ? body.filename.trim() : '';
    if (!filename || !filename.toLowerCase().endsWith('.pdf')) {
        return jsonResponse({ error: 'filename must be a .pdf' }, 400);
    }
    if (!body.acceptedDisclaimer) {
        return jsonResponse(
            {
                error: 'Copyright disclaimer must be accepted before download',
                code: 'disclaimer_required',
            },
            400,
        );
    }

    // Reject path traversal / unexpected characters in filenames.
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return jsonResponse({ error: 'Invalid filename' }, 400);
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

    // User-scoped client: Storage RLS requires owner for insert/update — never
    // upload with the service role (that would let any SELECT-capable member overwrite).
    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: role, error: roleError } = await userClient.rpc('document_role', { doc: documentId });
    if (roleError || role !== 'owner') {
        return jsonResponse({ error: 'Only the document owner can import a score PDF' }, 403);
    }

    const { data: doc, error: docError } = await userClient
        .from('documents')
        .select('id, storage_path')
        .eq('id', documentId)
        .maybeSingle();
    if (docError || !doc) {
        return jsonResponse({ error: 'Document not found or not accessible' }, 403);
    }
    if (doc.storage_path !== `${documentId}/original.pdf`) {
        return jsonResponse({ error: 'Unexpected storage path' }, 400);
    }

    try {
        const result = await tryDownloadPdf(filename);
        if (!result.ok) {
            return jsonResponse(
                {
                    ok: false,
                    code: result.code,
                    message: result.message,
                    openUrl: result.openUrl,
                    filename: result.filename,
                },
                // 409 signals hybrid fallback to the client.
                409,
            );
        }

        const { error: uploadError } = await userClient.storage
            .from('scores')
            .upload(doc.storage_path, result.bytes, {
                contentType: 'application/pdf',
                upsert: true,
            });
        if (uploadError) {
            return jsonResponse({ error: `Storage upload failed: ${uploadError.message}` }, 502);
        }

        // Intentionally JSON-only — never proxy PDF bytes through the Edge
        // response (saves egress + keeps worker memory to one buffer).
        return jsonResponse({
            ok: true,
            documentId,
            storagePath: doc.storage_path,
            filename: result.filename,
            byteLength: result.bytes.byteLength,
        });
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : 'IMSLP download failed' },
            502,
        );
    }
});
