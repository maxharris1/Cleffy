import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    checkRateLimit,
    clientKey,
    fetchWorkPageHtml,
    imagefromIndexUrl,
    serviceClient,
    tryDownloadPdf,
    workPageUrl,
} from '../_shared/imslp.ts';
import { gateGlobalImslpDownload, readGlobalDownloadGateConfig } from '../_shared/imslpDownloadGate.ts';
import {
    LICENSE_TTL_MS,
    canonicalImslpFilename,
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
} from '../_shared/imslpLicense.ts';
import { STORE_ROW_SELECT, loadStoreRowsForCatalogTitle } from '../_shared/catalogTitleLookup.ts';
import { matchStoreRow, pdObjectPath, type PdPdfStoreRow } from '../_shared/pdPdfCatalog.ts';
import { enforce, refund } from '../_shared/quota.ts';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const edgePdfFetchEnabled = (): boolean => Deno.env.get('IMSLP_EDGE_PDF_FETCH') === '1';

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

    let body: {
        filename?: string;
        acceptedDisclaimer?: boolean;
        documentId?: string;
        workTitle?: string;
        pdfSha256?: string;
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
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return jsonResponse({ error: 'Invalid filename' }, 400);
    }

    const canonicalFilename = canonicalImslpFilename(filename);
    const workTitle = typeof body.workTitle === 'string' ? body.workTitle.trim() : '';
    const pdfSha256 = typeof body.pdfSha256 === 'string' ? body.pdfSha256.trim().toLowerCase() : '';

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

    const missOpenUrl = workTitle ? workPageUrl(workTitle) : imagefromIndexUrl(canonicalFilename);
    const handoff = (message: string) =>
        jsonResponse(
            {
                ok: false,
                code: 'upstream',
                message,
                openUrl: missOpenUrl,
                filename: canonicalFilename,
            },
            409,
        );

    const loadStoreRows = async (): Promise<PdPdfStoreRow[]> => {
        if (pdfSha256) {
            const { data } = await admin
                .from('pd_pdf_store')
                .select(STORE_ROW_SELECT)
                .eq('pdf_sha256', pdfSha256)
                .limit(1);
            return (data ?? []) as PdPdfStoreRow[];
        }
        if (workTitle) {
            return loadStoreRowsForCatalogTitle(admin, workTitle);
        }
        const { data } = await admin.from('pd_pdf_store').select(STORE_ROW_SELECT).eq('filename', filename);
        return (data ?? []) as PdPdfStoreRow[];
    };

    const storeRows = await loadStoreRows();
    const catalogRow = matchStoreRow(storeRows, {
        pdfSha256: pdfSha256 || undefined,
        filename,
        workTitle: workTitle || undefined,
    });

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
                openUrl: missOpenUrl,
                filename: canonicalFilename,
            },
            409,
        );

    if (!catalogRow) {
        if (!edgePdfFetchEnabled()) {
            return handoff(
                "This score is not in Cleffy's library yet. Open it on IMSLP, save the PDF, then choose it here.",
            );
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

        // License backstop, checked BEFORE the quota so a restricted file never
        // costs a smart_imports credit. Cache miss or stale row live-parses the
        // work page; unknown or restricted fails closed and never fetches the PDF.
        const { data: licenseRow } = await admin
            .from('imslp_file_licenses')
            .select('restriction, downloadable, fetched_at')
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
        if (!fresh || fresh.downloadable !== true) {
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
        }
    }

    // Metered as smart_imports, and gated BEFORE the IMSLP fetch / Storage copy.
    // Every failure path below refunds, so a teacher is only charged for an
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

    // Deployment-wide pacing of live IMSLP fetches only. Catalog copies from
    // pd-pdfs skip this gate. Checked after the quota so a caller with no
    // smart_imports left cannot take the one slot for free; a queued caller is
    // refunded and does not hold the invocation open: the client retries after
    // retryAfterSec. Per-caller limiting above is unchanged.
    if (!catalogRow) {
        const pacing = await gateGlobalImslpDownload(checkRateLimit, readGlobalDownloadGateConfig(Deno.env.get));
        if (!pacing.ok) {
            await giveBack();
            return jsonResponse(pacing.body, pacing.status);
        }
    }

    const copyCatalog = async (row: PdPdfStoreRow): Promise<{ ok: true } | { ok: false; message: string }> => {
        const sourcePath = pdObjectPath(row.pdf_sha256, row.filename);
        const { error: copyError } = await admin.storage.from('pd-pdfs').copy(sourcePath, doc.storage_path, {
            destinationBucket: 'scores',
        });
        if (!copyError) {
            return { ok: true };
        }
        // Copy can fail when the destination exists or the Storage build lacks
        // cross-bucket copy. Fall back to a service-role download + owner upload
        // — still zero IMSLP bytes.
        const { data: blob, error: dlError } = await admin.storage.from('pd-pdfs').download(sourcePath);
        if (dlError || !blob) {
            return { ok: false, message: copyError.message };
        }
        const { error: uploadError } = await userClient.storage.from('scores').upload(doc.storage_path, blob, {
            contentType: 'application/pdf',
            upsert: true,
        });
        if (uploadError) {
            return { ok: false, message: uploadError.message };
        }
        return { ok: true };
    };

    try {
        if (catalogRow) {
            const copied = await copyCatalog(catalogRow);
            if (!copied.ok) {
                await giveBack();
                return jsonResponse({ error: `Catalog copy failed: ${copied.message}` }, 502);
            }
            return jsonResponse({
                ok: true,
                documentId,
                storagePath: doc.storage_path,
                filename: catalogRow.filename,
                byteLength: catalogRow.byte_length,
                source: 'catalog',
            });
        }

        const result = await tryDownloadPdf(canonicalFilename);
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

        return jsonResponse({
            ok: true,
            documentId,
            storagePath: doc.storage_path,
            filename: result.filename,
            byteLength: result.bytes.byteLength,
            source: 'imslp',
        });
    } catch (err) {
        await giveBack();
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP download failed' }, 502);
    }
});
