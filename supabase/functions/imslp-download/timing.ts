import type { DownloadPhase } from '../_shared/imslpDownload.ts';
import type { ImslpImportDeps } from '../_shared/imslpImportFlow.ts';
import type { PdfCacheDeps } from '../_shared/imslpPdfCache.ts';
import type { RequestTiming, TelemetryFields } from '../_shared/serverTiming.ts';

export type ImslpDownloadSpan =
    | 'rl_ip'
    | 'auth'
    | 'elig_rl_del'
    | 'cache_read_claim'
    | 'lic_cache'
    | 'lic_live'
    | 'precheck_pace_quota'
    | DownloadPhase
    | 'imslp_credits'
    | 'hash_upload_pub'
    | 'db_doc_write'
    | 'cache_release';

export type ImslpDownloadTiming = RequestTiming<ImslpDownloadSpan>;

const IMPORT_SPANS: Partial<Record<keyof ImslpImportDeps, ImslpDownloadSpan>> = {
    cachedClearance: 'lic_cache',
    liveLicense: 'lic_live',
    precheckCreate: 'precheck_pace_quota',
    pace: 'precheck_pace_quota',
    enforceQuota: 'precheck_pace_quota',
    createDocument: 'db_doc_write',
    recordProvenance: 'db_doc_write',
};

const CACHE_SPANS: Record<keyof PdfCacheDeps, ImslpDownloadSpan> = {
    read: 'cache_read_claim',
    claim: 'cache_read_claim',
    upload: 'hash_upload_pub',
    publish: 'hash_upload_pub',
    release: 'cache_release',
};

type AsyncFn = (...args: unknown[]) => Promise<unknown>;

const timed = <D extends object>(
    timing: ImslpDownloadTiming,
    spans: Partial<Record<keyof D, ImslpDownloadSpan>>,
    deps: D,
): D => {
    const out = { ...deps } as Record<string, unknown>;
    for (const [key, span] of Object.entries(spans) as Array<[string, ImslpDownloadSpan]>) {
        const fn = (deps as Record<string, AsyncFn>)[key]!;
        out[key] = (...args: unknown[]) => timing.time(span, () => fn.apply(deps, args));
    }
    return out as D;
};

export interface ImslpDownloadFields extends TelemetryFields {
    cacheHit: boolean | null;
    licenseHit: boolean | null;
    tier: string | null;
    byteLength: number | null;
}

export const downloadFields = (fields: TelemetryFields): ImslpDownloadFields =>
    Object.assign(fields, { cacheHit: null, licenseHit: null, tier: null, byteLength: null });

export const timedCacheDeps = (timing: ImslpDownloadTiming, deps: PdfCacheDeps): PdfCacheDeps =>
    timed(timing, CACHE_SPANS, deps);

export const timedImportDeps = (
    timing: ImslpDownloadTiming,
    fields: ImslpDownloadFields,
    deps: ImslpImportDeps,
): ImslpImportDeps => {
    const wrapped = timed(timing, IMPORT_SPANS, deps);
    return {
        ...wrapped,
        cachedClearance: async () => {
            const clearance = await wrapped.cachedClearance();
            fields.licenseHit = clearance !== null;
            return clearance;
        },
        downloadPdf: async () => {
            const result = await wrapped.downloadPdf();
            if (result.ok) {
                fields.byteLength = 'shared' in result ? result.shared.byteLength : result.bytes.byteLength;
            }
            return result;
        },
    };
};
