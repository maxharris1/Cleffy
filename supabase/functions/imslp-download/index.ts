import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    checkRateLimit,
    clientKey,
    fetchWorkPageHtml,
    imagefromIndexUrl,
    mwFetch,
    serviceClient,
    tryDownloadPdf,
} from '../_shared/imslp.ts';
import {
    IMSLP_GLOBAL_DOWNLOAD_KEY,
    downloadQueued,
    gateGlobalImslpDownload,
    imslpBackoffSec,
    readGlobalDownloadGateConfig,
} from '../_shared/imslpDownloadGate.ts';
import { fileCreditsFor, type ImslpFileCredits } from '../_shared/imslpFileBlocks.ts';
import {
    LICENSE_TTL_MS,
    canonicalImslpFilename,
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
} from '../_shared/imslpLicense.ts';
import { buildImslpProvenance } from '../_shared/imslpProvenance.ts';
import { wikitextFromMwPage } from '../_shared/imslpWorkPage.ts';
import { enforce, refund } from '../_shared/quota.ts';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who IMSLP credits for this file, read from the work page's file block — one
 * MediaWiki call, after the PDF is already stored. Best-effort and single-try:
 * a slow API must not hold up (or fail) an import whose license is already
 * verified, so a miss records the composer and license without these credits.
 */
const fetchFileCredits = async (workTitle: string, filename: string): Promise<ImslpFileCredits | null> => {
    try {
        const data = (await mwFetch(
            { action: 'query', titles: workTitle, prop: 'revisions', rvprop: 'content', redirects: '1' },
            { attempts: 1, timeoutMs: 8_000 },
        )) as { query?: { pages?: Record<string, { revisions?: Array<{ '*'?: string }> }> } };
        const page = Object.values(data.query?.pages ?? {})[0];
        return page ? fileCreditsFor(wikitextFromMwPage(page), filename) : null;
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

    const rate = await checkRateLimit(`download:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body: { filename?: string; acceptedDisclaimer?: boolean; documentId?: string; workTitle?: string };
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

    const canonicalFilename = canonicalImslpFilename(filename);
    const workTitle = typeof body.workTitle === 'string' ? body.workTitle.trim() : '';

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

    const licenseConflict = (code: 'non_pd' | 'license_unknown', restriction: string | null) =>
        jsonResponse(
            {
                ok: false,
                code,
                message:
                    code === 'non_pd'
                        ? restriction
                            ? `IMSLP lists this edition as copyright-restricted (${restriction}); it can't be imported automatically.`
                            : "IMSLP lists this edition as copyright-restricted; it can't be imported automatically."
                        : "IMSLP didn't confirm a public-domain or Creative Commons license for this edition; it can't be imported automatically.",
                openUrl: imagefromIndexUrl(canonicalFilename),
                filename: canonicalFilename,
            },
            409,
        );

    // License backstop, checked BEFORE the quota so a restricted file never
    // costs a smart_imports credit. Cache miss or stale row live-parses the
    // work page; unknown or restricted fails closed and never fetches the PDF.
    // What it verified (the work page the file is listed on, IMSLP's license
    // tag) is also what the document's provenance records.
    const { data: licenseRow } = await admin
        .from('imslp_file_licenses')
        .select('restriction, downloadable, fetched_at, license_label, work_title')
        .eq('filename', canonicalFilename)
        .maybeSingle();
    const fresh =
        licenseRow && Date.now() - new Date(licenseRow.fetched_at as string).getTime() < LICENSE_TTL_MS
            ? licenseRow
            : null;
    if (fresh && fresh.downloadable === false) {
        const restriction = typeof fresh.restriction === 'string' ? fresh.restriction : null;
        return licenseConflict('non_pd', restriction);
    }
    let verifiedTitle: string;
    let licenseLabel: string | null;
    if (fresh && fresh.downloadable === true) {
        verifiedTitle = typeof fresh.work_title === 'string' && fresh.work_title ? fresh.work_title : workTitle;
        licenseLabel = typeof fresh.license_label === 'string' ? fresh.license_label : null;
    } else {
        if (!workTitle) {
            return licenseConflict('license_unknown', null);
        }
        const html = await fetchWorkPageHtml(workTitle);
        if (!html) {
            return licenseConflict('license_unknown', null);
        }
        const parsed = parseWorkPageLicenses(html);
        const license = parsed.get(canonicalFilename);
        if (license) {
            try {
                await admin.from('imslp_file_licenses').upsert({
                    filename: canonicalFilename,
                    work_title: workTitle,
                    license: classifyLicense(license.licenseLabel),
                    license_label: license.licenseLabel,
                    restriction: license.restriction,
                    eu_hosted: license.euHosted,
                    downloadable: isDownloadable(license),
                    fetched_at: new Date().toISOString(),
                });
            } catch {
                // cache write is best-effort
            }
        }
        if (!license) {
            return licenseConflict('license_unknown', null);
        }
        if (!isDownloadable(license)) {
            return licenseConflict('non_pd', license.restriction);
        }
        verifiedTitle = workTitle;
        licenseLabel = license.licenseLabel;
    }
    if (!verifiedTitle) {
        // A cached clearance with no work page to point at cannot carry its
        // attribution; refuse rather than import a score whose source is unknown.
        return licenseConflict('license_unknown', null);
    }

    // Deployment-wide pacing of live IMSLP fetches (imslpDownloadGate.ts).
    // Checked after the license (a refused file spends no slot) and before the
    // quota, so a queued caller is neither charged nor holds the invocation
    // open: the client waits retryAfterSec and asks again.
    const pacing = await gateGlobalImslpDownload(checkRateLimit, readGlobalDownloadGateConfig(Deno.env.get));
    if (!pacing.ok) {
        return jsonResponse(pacing.body, pacing.status);
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
        const result = await tryDownloadPdf(canonicalFilename);
        if (!result.ok) {
            await giveBack();
            if (result.code === 'rate_limited') {
                // IMSLP is throttling our egress IP. Close the shared pacing key
                // for as long as it asked, so no other import tries meanwhile,
                // and queue this caller behind it like any paced request.
                const backoff = imslpBackoffSec(result.retryAfterSec);
                const { error: blockError } = await admin.rpc('edge_rate_block', {
                    p_key: IMSLP_GLOBAL_DOWNLOAD_KEY,
                    p_seconds: backoff,
                });
                if (blockError) {
                    console.error(`imslp-download: could not record IMSLP back-off: ${blockError.message}`);
                }
                const queued = downloadQueued(backoff);
                return jsonResponse(queued.body, queued.status);
            }
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

        // Provenance: where the score came from, its license and who IMSLP
        // credits. Written with the service role (clients cannot set or change
        // these columns — documents_guard_provenance). A CC-BY score must not
        // exist in a library without its attribution, so a failed write fails
        // the import: the stored PDF is removed and the credit refunded, and the
        // client rolls the document row back as for any failed import.
        const credits = await fetchFileCredits(verifiedTitle, canonicalFilename);
        const provenance = buildImslpProvenance({
            workTitle: verifiedTitle,
            filename: canonicalFilename,
            licenseLabel,
            credits,
        });
        const { error: provenanceError } = await admin.from('documents').update(provenance).eq('id', documentId);
        if (provenanceError) {
            await userClient.storage
                .from('scores')
                .remove([doc.storage_path])
                .catch(() => undefined);
            await giveBack();
            return jsonResponse({ error: `Could not record the score's source: ${provenanceError.message}` }, 502);
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
