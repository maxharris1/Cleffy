import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import {
    checkRateLimit,
    clientKey,
    fetchWorkPage,
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
import { runImslpImport, type FlowResponse, type LiveLicense } from '../_shared/imslpImportFlow.ts';
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
 * Per-address guard, ahead of authentication. Generous on purpose: a school or
 * conservatoire puts every teacher behind one NAT address, and their queued
 * retries all land here. The real per-caller limit is per user, below.
 */
const PER_ADDRESS_LIMIT = 60;
/**
 * Per signed-in user. A queued import retries at most about eight times a
 * minute (imslpApi.ts backs off 1, 2, 4, 8, 15 s…), so one import stays inside
 * this; a caller who still hits it is told to wait (`caller_rate_limited` with
 * retryAfterSec), which current clients wait out like the pacing queue.
 */
const PER_USER_LIMIT = 10;

/**
 * One try for the license parse on a cache miss: a retry inside the same
 * invocation would be a second request to an API that may be throttling us,
 * and a 429 has to reach the flow so the deployment backs off.
 */
const LICENSE_PARSE_OPTIONS = { attempts: 1, timeoutMs: 15_000 };

/** Longest stored score title (the browser derives it from the IMSLP work title). */
const MAX_TITLE_LENGTH = 300;

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

/** The score-cap trigger's refusal (P0001 'limit_reached', payload in DETAIL) as the 402 clients already read. */
const scoreCapRefusal = (details: string | null | undefined): FlowResponse => {
    let payload: unknown;
    try {
        payload = details ? JSON.parse(details) : null;
    } catch {
        payload = null;
    }
    const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    return {
        status: 402,
        body: {
            code: 'limit_reached',
            metric: 'cloud_scores',
            limit: typeof record['limit'] === 'number' ? record['limit'] : 0,
            tier: typeof record['tier'] === 'string' ? record['tier'] : 'free',
        },
    };
};

const respond = (flow: FlowResponse): Response => jsonResponse(flow.body, flow.status);

/**
 * A 5xx is a failure on our side (Storage, the provenance write, an exception
 * the flow caught after undoing its work and refunding the credit): reported
 * as structured JSON (and to Sentry when configured). 4xx answers — license
 * refusals, queueing, the open-on-IMSLP fallbacks, quota — are the product
 * working and are not errors.
 */
const reportFailure = (flow: FlowResponse, context: Record<string, unknown>): void => {
    if (flow.status < 500) {
        return;
    }
    const body = flow.body as { error?: unknown } | null;
    const message = typeof body?.error === 'string' ? body.error : `imslp-download answered ${flow.status}`;
    logError('imslp-download', new Error(message), { code: 'download_failed', status: flow.status, ...context });
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const addressRate = await checkRateLimit(`download:${clientKey(req)}`, PER_ADDRESS_LIMIT, 60_000);
    if (!addressRate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: addressRate.retryAfterSec }, 429);
    }

    // The caller's id is established with the Auth server (requireUser): a
    // new score is created as this user, and the per-caller limit keys on it.
    const auth = await requireUser(req);
    if (!auth.ok) {
        return auth.response;
    }
    const { userClient, userId } = auth.caller;

    const userRate = await checkRateLimit(`download:user:${userId}`, PER_USER_LIMIT, 60_000);
    if (!userRate.ok) {
        return jsonResponse(
            {
                ok: false,
                code: 'caller_rate_limited',
                error: 'Too many IMSLP imports at once — waiting a moment before trying again',
                retryAfterSec: userRate.retryAfterSec,
            },
            429,
        );
    }

    let body: {
        filename?: string;
        acceptedDisclaimer?: boolean;
        documentId?: string;
        workTitle?: string;
        create?: boolean;
        title?: string;
    };
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
    const storagePath = `${documentId}/original.pdf`;

    // Current clients ask the function to create the score (`create: true`)
    // once the PDF is in hand, so nothing sits in the library while an import
    // is queued. Clients from before the pacing queue created the row first;
    // that path is kept, owner-checked, until they have all updated.
    const creating = body.create === true;
    const createTitle = creating
        ? (typeof body.title === 'string' ? body.title : '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) ||
          canonicalFilename.replace(/\.pdf$/i, '')
        : null;

    if (!creating) {
        const { data: role, error: roleError } = await userClient.rpc('document_role', { doc: documentId });
        if (roleError || role !== 'owner') {
            return jsonResponse({ error: 'Only the document owner can import a score PDF' }, 403);
        }
        const { data: doc, error: docError } = await userClient
            .from('documents')
            .select('id, storage_path, owner_id')
            .eq('id', documentId)
            .maybeSingle();
        if (docError || !doc || doc.owner_id !== userId) {
            return jsonResponse({ error: 'Document not found or not accessible' }, 403);
        }
        if (doc.storage_path !== storagePath) {
            return jsonResponse({ error: 'Unexpected storage path' }, 400);
        }
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    const flow = await runImslpImport(
        {
            filename: canonicalFilename,
            workTitle,
            documentId,
            storagePath,
            openUrl: imagefromIndexUrl(canonicalFilename),
            createTitle,
        },
        {
            // License backstop, read BEFORE any pacing slot or quota is spent.
            // What it verified (the work page the file is listed on, IMSLP's
            // license tag) is also what the document's provenance records.
            cachedClearance: async () => {
                const { data: row } = await admin
                    .from('imslp_file_licenses')
                    .select('restriction, downloadable, fetched_at, license_label, work_title')
                    .eq('filename', canonicalFilename)
                    .maybeSingle();
                if (!row || Date.now() - new Date(row.fetched_at as string).getTime() >= LICENSE_TTL_MS) {
                    return null;
                }
                if (typeof row.downloadable !== 'boolean') {
                    return null;
                }
                return {
                    downloadable: row.downloadable,
                    restriction: typeof row.restriction === 'string' ? row.restriction : null,
                    licenseLabel: typeof row.license_label === 'string' ? row.license_label : null,
                    workTitle: typeof row.work_title === 'string' && row.work_title ? row.work_title : null,
                };
            },

            precheckCreate: async () => {
                const { data: existing, error: existingError } = await admin
                    .from('documents')
                    .select('id')
                    .eq('id', documentId)
                    .maybeSingle();
                if (existingError) {
                    return { status: 502, body: { error: 'Could not check the library' } };
                }
                if (existing) {
                    return { status: 409, body: { error: 'That score id is already in use' } };
                }
                // UX pre-check of the cloud-score cap so a full library costs no
                // IMSLP request; the documents_enforce_score_cap trigger on the
                // insert below remains the enforcement.
                const { data: ent } = await admin.rpc('get_entitlements', { p_user: userId });
                const entitlements = ent as { tier?: unknown; limits?: { cloud_scores?: unknown } } | null;
                const limit = entitlements?.limits?.cloud_scores;
                if (typeof limit === 'number' && limit >= 0) {
                    const { count, error: countError } = await admin
                        .from('documents')
                        .select('id', { count: 'exact', head: true })
                        .eq('owner_id', userId)
                        .is('archived_at', null);
                    if (!countError && count !== null && count >= limit) {
                        return {
                            status: 402,
                            body: {
                                code: 'limit_reached',
                                metric: 'cloud_scores',
                                limit,
                                tier: typeof entitlements?.tier === 'string' ? entitlements.tier : 'free',
                            },
                        };
                    }
                }
                return null;
            },

            // Deployment-wide pacing of live IMSLP requests (imslpDownloadGate.ts).
            pace: () => gateGlobalImslpDownload(checkRateLimit, readGlobalDownloadGateConfig(Deno.env.get)),

            liveLicense: async (title): Promise<LiveLicense> => {
                const page = await fetchWorkPage(title, LICENSE_PARSE_OPTIONS);
                if (!page.ok) {
                    return page.reason === 'rate_limited'
                        ? { kind: 'rate_limited', retryAfterSec: page.retryAfterSec }
                        : { kind: 'unavailable' };
                }
                const license = parseWorkPageLicenses(page.html).get(canonicalFilename);
                if (!license) {
                    return { kind: 'not_listed' };
                }
                try {
                    await admin.from('imslp_file_licenses').upsert({
                        filename: canonicalFilename,
                        work_title: title,
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
                return {
                    kind: 'found',
                    downloadable: isDownloadable(license),
                    restriction: license.restriction,
                    licenseLabel: license.licenseLabel,
                };
            },

            // IMSLP is throttling our egress IP. Close the shared pacing key for
            // as long as it asked, so no other import tries meanwhile, and queue
            // this caller behind it like any paced request.
            backOff: async (retryAfterSec) => {
                const backoff = imslpBackoffSec(retryAfterSec);
                const { error: blockError } = await admin.rpc('edge_rate_block', {
                    p_key: IMSLP_GLOBAL_DOWNLOAD_KEY,
                    p_seconds: backoff,
                });
                if (blockError) {
                    console.error(`imslp-download: could not record IMSLP back-off: ${blockError.message}`);
                }
                return downloadQueued(backoff);
            },

            // Metered as smart_imports, gated before the IMSLP fetch it pays for.
            enforceQuota: async () => {
                const gate = await enforce(admin, userId, 'smart_imports');
                return gate.ok
                    ? { ok: true, consumed: gate.consumed }
                    : { ok: false, status: gate.status, body: gate.body };
            },
            refundQuota: () => refund(admin, userId, 'smart_imports'),

            downloadPdf: () => tryDownloadPdf(canonicalFilename),

            // As the caller, so the documents_insert policy and the score-cap
            // trigger judge it exactly as they judge an upload.
            createDocument: async (title) => {
                const { error } = await userClient
                    .from('documents')
                    .insert({ id: documentId, owner_id: userId, title, storage_path: storagePath });
                if (!error) {
                    return null;
                }
                if (error.message === 'limit_reached') {
                    return scoreCapRefusal(error.details);
                }
                if (error.code === '23505') {
                    return { status: 409, body: { error: 'That score id is already in use' } };
                }
                if (error.code === '42501') {
                    return { status: 403, body: { error: 'This account cannot add scores' } };
                }
                return { status: 502, body: { error: `Could not create the score: ${error.message}` } };
            },
            // Cleanup of a row and file this invocation created. Service role
            // so a cleanup is never refused, scoped to that exact row and path.
            deleteDocument: async () => {
                const { error } = await admin.from('documents').delete().eq('id', documentId).eq('owner_id', userId);
                if (error) {
                    console.error(`imslp-download: could not remove a failed import's score: ${error.message}`);
                }
            },

            // User-scoped client: Storage RLS requires owner for insert/update —
            // never upload with the service role (that would let any
            // SELECT-capable member overwrite).
            uploadPdf: async (bytes) => {
                const { error } = await userClient.storage.from('scores').upload(storagePath, bytes, {
                    contentType: 'application/pdf',
                    upsert: true,
                });
                return error ? error.message : null;
            },
            removePdf: async () => {
                const { error } = await admin.storage.from('scores').remove([storagePath]);
                if (error) {
                    console.error(`imslp-download: could not remove a failed import's PDF: ${error.message}`);
                }
            },

            // Provenance: where the score came from, its license and who IMSLP
            // credits. Written with the service role (clients cannot set or
            // change these columns — documents_guard_provenance).
            recordProvenance: async (title, licenseLabel) => {
                const credits = await fetchFileCredits(title, canonicalFilename);
                const provenance = buildImslpProvenance({
                    workTitle: title,
                    filename: canonicalFilename,
                    licenseLabel,
                    credits,
                });
                const { error } = await admin.from('documents').update(provenance).eq('id', documentId);
                return error ? error.message : null;
            },
        },
    );
    reportFailure(flow, { documentId, creating });
    return respond(flow);
});
