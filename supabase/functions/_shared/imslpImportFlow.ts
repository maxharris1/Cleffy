/**
 * The order of operations behind imslp-download, once the caller is
 * authenticated and the request is well-formed.
 *
 * The order is the point, so it lives here — import-free, with every side
 * effect injected — where vitest can pin it, rather than inline in Deno.serve:
 *
 * 1. A cached license refusal answers at once: no pacing slot, no IMSLP
 *    request, no credit.
 * 2. Creating a new score: refuse a taken id or a full cloud-score cap before
 *    any IMSLP request either (the row itself is only written in step 7).
 * 3. Deployment-wide pacing, BEFORE the first live IMSLP request of the
 *    invocation — the license parse included. While IMSLP's Retry-After holds
 *    the shared key closed, an uncached file is queued here rather than sent
 *    to the host that is throttling us.
 * 4. The live license parse (cache miss). IMSLP answering 429 backs the whole
 *    deployment off and queues this caller; an unreachable API is "couldn't
 *    check", not "not licensed".
 * 5. The smart_imports quota, before the fetch it pays for. From here every
 *    failure gives the credit back.
 * 6. The PDF fetch (one shared budget, imslpDownload.ts). 429 → back off.
 * 7. Creating a new score: only now is the documents row written, as the
 *    caller (RLS and the score-cap trigger apply), so a queued or failed import
 *    never leaves an empty score in anyone's library — the client holds no row
 *    while it waits.
 * 8. Upload as the caller, then provenance under the service role. A failure
 *    after step 7 removes the PDF and the row this invocation created; for a
 *    row the client created (older clients) it removes the PDF and the client
 *    rolls its own row back.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it).
 */

export interface FlowResponse {
    status: number;
    body: unknown;
}

/** A fresh imslp_file_licenses row. */
export interface CachedClearance {
    downloadable: boolean;
    restriction: string | null;
    licenseLabel: string | null;
    /** The work page the file was verified on. */
    workTitle: string | null;
}

export type LiveLicense =
    | { kind: 'found'; downloadable: boolean; restriction: string | null; licenseLabel: string | null }
    /** The work page parsed, but this file is not on it. */
    | { kind: 'not_listed' }
    /** Timeout / API error: the license could not be checked. */
    | { kind: 'unavailable' }
    /** IMSLP answered 429. */
    | { kind: 'rate_limited'; retryAfterSec: number | null };

/** Structurally DownloadResult (imslpDownload.ts). */
export type FetchedPdf =
    | { ok: true; bytes: Uint8Array; filename: string }
    | {
          ok: false;
          code: string;
          message: string;
          openUrl: string;
          filename: string;
          retryAfterSec?: number | null;
      };

export type QuotaGate = { ok: true; consumed: boolean } | { ok: false; status: number; body: unknown };

export type PacingGate = { ok: true } | { ok: false; status: number; body: unknown };

export interface ImslpImportRequest {
    /** Canonical IMSLP filename. */
    filename: string;
    /** Work title the client sent ('' when absent). */
    workTitle: string;
    documentId: string;
    storagePath: string;
    /** ImagefromIndex URL for the open-on-IMSLP fallback. */
    openUrl: string;
    /**
     * The title for a score this invocation creates once the PDF is in hand.
     * Null when the client already created the row (clients from before the
     * pacing queue), which is then left for the client to roll back.
     */
    createTitle: string | null;
}

export interface ImslpImportDeps {
    cachedClearance(): Promise<CachedClearance | null>;
    /** Creating only: a refusal (id taken, score cap full) to return before any IMSLP request, or null. */
    precheckCreate(): Promise<FlowResponse | null>;
    /** Consume a deployment-wide pacing slot. */
    pace(): Promise<PacingGate>;
    liveLicense(workTitle: string): Promise<LiveLicense>;
    /** IMSLP said 429: close the shared pacing key for its Retry-After and return the queued answer. */
    backOff(retryAfterSec: number | null): Promise<FlowResponse>;
    enforceQuota(): Promise<QuotaGate>;
    refundQuota(): Promise<void>;
    downloadPdf(): Promise<FetchedPdf>;
    /** Insert the documents row as the caller; a refusal to return, or null on success. */
    createDocument(title: string): Promise<FlowResponse | null>;
    deleteDocument(): Promise<void>;
    /** Upload as the caller; an error message, or null on success. */
    uploadPdf(bytes: Uint8Array): Promise<string | null>;
    removePdf(): Promise<void>;
    /** Fetch the credits and write documents.source_*; an error message, or null on success. */
    recordProvenance(workTitle: string, licenseLabel: string | null): Promise<string | null>;
}

const LICENSE_UNKNOWN_MESSAGE =
    "IMSLP didn't confirm a public-domain or Creative Commons license for this edition; it can't be imported automatically.";
const LICENSE_UNCHECKED_MESSAGE =
    "Cleffy couldn't reach IMSLP to check this edition's license, so it wasn't imported. Try again in a minute — or open it on IMSLP.";

const licenseConflict = (
    request: ImslpImportRequest,
    code: 'non_pd' | 'license_unknown',
    restriction: string | null,
    unchecked = false,
): FlowResponse => ({
    status: 409,
    body: {
        ok: false,
        code,
        message:
            code === 'non_pd'
                ? restriction
                    ? `IMSLP lists this edition as copyright-restricted (${restriction}); it can't be imported automatically.`
                    : "IMSLP lists this edition as copyright-restricted; it can't be imported automatically."
                : unchecked
                  ? LICENSE_UNCHECKED_MESSAGE
                  : LICENSE_UNKNOWN_MESSAGE,
        openUrl: request.openUrl,
        filename: request.filename,
    },
});

const quietly = async (step: () => Promise<void>): Promise<void> => {
    try {
        await step();
    } catch {
        // cleanup is best-effort; the caller has already chosen its answer
    }
};

export const runImslpImport = async (request: ImslpImportRequest, deps: ImslpImportDeps): Promise<FlowResponse> => {
    const creating = request.createTitle !== null;

    // 1. Cached license.
    const cached = await deps.cachedClearance();
    if (cached && !cached.downloadable) {
        return licenseConflict(request, 'non_pd', cached.restriction);
    }
    let verifiedTitle: string | null = null;
    let licenseLabel: string | null = null;
    if (cached) {
        verifiedTitle = cached.workTitle || request.workTitle || null;
        licenseLabel = cached.licenseLabel;
        if (!verifiedTitle) {
            // A cached clearance with no work page to point at cannot carry its
            // attribution; refuse rather than import a score whose source is unknown.
            return licenseConflict(request, 'license_unknown', null);
        }
    } else if (!request.workTitle) {
        return licenseConflict(request, 'license_unknown', null);
    }

    // 2. A new score that could never be created is refused before IMSLP is asked.
    if (creating) {
        const refused = await deps.precheckCreate();
        if (refused) {
            return refused;
        }
    }

    // 3. Pacing, before the first live IMSLP request.
    const pacing = await deps.pace();
    if (!pacing.ok) {
        return { status: pacing.status, body: pacing.body };
    }

    // 4. Live license on a cache miss.
    if (!cached) {
        const live = await deps.liveLicense(request.workTitle);
        switch (live.kind) {
            case 'rate_limited':
                return deps.backOff(live.retryAfterSec);
            case 'unavailable':
                return licenseConflict(request, 'license_unknown', null, true);
            case 'not_listed':
                return licenseConflict(request, 'license_unknown', null);
            case 'found':
                if (!live.downloadable) {
                    return licenseConflict(request, 'non_pd', live.restriction);
                }
                verifiedTitle = request.workTitle;
                licenseLabel = live.licenseLabel;
                break;
            default: {
                const _exhaustive: never = live;
                return _exhaustive;
            }
        }
    }
    const title = verifiedTitle ?? request.workTitle;

    // 5. Quota. Only what was actually spent can be given back: on an unlimited
    // plan the gate short-circuits without touching the counter, and refunding
    // anyway would decrement a row left over from the caller's free-tier days.
    const gate = await deps.enforceQuota();
    if (!gate.ok) {
        return { status: gate.status, body: gate.body };
    }
    const giveBack = async (): Promise<void> => {
        if (gate.consumed) {
            await quietly(() => deps.refundQuota());
        }
    };

    let created = false;
    let uploaded = false;
    // The PDF goes first: Storage RLS authorizes removal through the row.
    const undo = async (): Promise<void> => {
        if (uploaded || created) {
            await quietly(() => deps.removePdf());
        }
        if (created) {
            await quietly(() => deps.deleteDocument());
        }
        await giveBack();
    };

    try {
        // 6. Fetch.
        const result = await deps.downloadPdf();
        if (!result.ok) {
            await giveBack();
            if (result.code === 'rate_limited') {
                return deps.backOff(result.retryAfterSec ?? null);
            }
            return {
                // 409 signals the open-on-IMSLP fallback to the client.
                status: 409,
                body: {
                    ok: false,
                    code: result.code,
                    message: result.message,
                    openUrl: result.openUrl,
                    filename: result.filename,
                },
            };
        }

        // 7. The row, only once there is a PDF to put in it.
        if (request.createTitle !== null) {
            const refused = await deps.createDocument(request.createTitle);
            if (refused) {
                await giveBack();
                return refused;
            }
            created = true;
        }

        // 8. Store, then record where it came from. A CC-BY score must not
        // exist in a library without its attribution, so a failed provenance
        // write fails the import.
        const uploadError = await deps.uploadPdf(result.bytes);
        if (uploadError) {
            await undo();
            return { status: 502, body: { error: `Storage upload failed: ${uploadError}` } };
        }
        uploaded = true;

        const provenanceError = await deps.recordProvenance(title, licenseLabel);
        if (provenanceError) {
            await undo();
            return { status: 502, body: { error: `Could not record the score's source: ${provenanceError}` } };
        }

        // Intentionally JSON-only — never proxy PDF bytes through the Edge
        // response (saves egress + keeps worker memory to one buffer).
        return {
            status: 200,
            body: {
                ok: true,
                documentId: request.documentId,
                storagePath: request.storagePath,
                filename: result.filename,
                byteLength: result.bytes.byteLength,
                created,
            },
        };
    } catch (err) {
        await undo();
        return { status: 502, body: { error: err instanceof Error ? err.message : 'IMSLP download failed' } };
    }
};
