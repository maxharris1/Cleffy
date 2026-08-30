import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, imagefromIndexUrl, serviceClient, tryDownloadPdf } from '../_shared/imslp.ts';
import { LICENSE_TTL_MS } from '../_shared/imslpLicense.ts';
import { enforce, refund } from '../_shared/quota.ts';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // owner_id is selected so the import can be metered without a second auth
    // round-trip: the document_role check above already proved the caller IS the
    // owner, so this row's owner_id is the caller's user id.
    const { data: doc, error: docError } = await userClient
        .from('documents')
        .select('id, storage_path, owner_id')
        .eq('id', documentId)
        .maybeSingle();
    if (docError || !doc) {
        return jsonResponse({ error: 'Document not found or not accessible' }, 403);
    }
    if (doc.storage_path !== `${documentId}/original.pdf`) {
        return jsonResponse({ error: 'Unexpected storage path' }, 400);
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // License backstop, checked BEFORE the quota so a restricted file never
    // costs a smart_imports credit. The edition picker is the primary gate;
    // this catches direct calls. Missing or stale cache rows fail open — every
    // UI path warms the cache through imslp-work first.
    const { data: licenseRow } = await admin
        .from('imslp_file_licenses')
        .select('restriction, downloadable, fetched_at')
        .eq('filename', filename)
        .maybeSingle();
    if (
        licenseRow &&
        licenseRow.downloadable === false &&
        Date.now() - new Date(licenseRow.fetched_at as string).getTime() < LICENSE_TTL_MS
    ) {
        const restriction = typeof licenseRow.restriction === 'string' ? licenseRow.restriction : null;
        return jsonResponse(
            {
                ok: false,
                code: 'non_pd',
                message: restriction
                    ? `IMSLP lists this edition as copyright-restricted (${restriction}); it can't be imported automatically.`
                    : "IMSLP lists this edition as copyright-restricted; it can't be imported automatically.",
                openUrl: imagefromIndexUrl(filename),
                filename,
            },
            // 409 signals hybrid fallback to the client, like download failures.
            409,
        );
    }

    // Metered as smart_imports, and gated BEFORE the IMSLP fetch — the expensive
    // part. Every failure path below refunds, so a teacher is only charged for an
    // import that actually landed in Storage.
    const gate = await enforce(admin, doc.owner_id, 'smart_imports');
    if (!gate.ok) {
        return jsonResponse(gate.body, gate.status);
    }

    // Only what was actually spent can be given back. On an unlimited plan the
    // gate short-circuits without touching the counter, and refunding anyway
    // would decrement a row left over from this teacher's free-tier days —
    // restoring an allowance they already spent.
    const giveBack = async (): Promise<void> => {
        if (gate.consumed) {
            await refund(admin, doc.owner_id, 'smart_imports');
        }
    };

    try {
        const result = await tryDownloadPdf(filename);
        if (!result.ok) {
            await giveBack();
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

        const { error: uploadError } = await userClient.storage.from('scores').upload(doc.storage_path, result.bytes, {
            contentType: 'application/pdf',
            upsert: true,
        });
        if (uploadError) {
            await giveBack();
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
        await giveBack();
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP download failed' }, 502);
    }
});
