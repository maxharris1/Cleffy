import { parseLimitResponse } from '@/features/billing/limitErrors';
import type { EraId, RelaxedConstraint, SearchFilters, SearchSort } from '@/features/imslp/searchFacets';
import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';

export interface ImslpSearchHit {
    title: string;
    pageid: number;
    snippet: string;
    composer: string | null;
    imslpUrl: string;
}

export interface ImslpSearchOptions {
    limit?: number;
    offset?: number;
    filters?: SearchFilters;
    sort?: SearchSort;
    /** Cancels the request (the panel aborts superseded searches). */
    signal?: AbortSignal;
}

export interface ImslpPeriod {
    eraIds: EraId[];
    source: 'query' | 'chip' | 'both';
}

export interface ImslpSearchResponse {
    results: ImslpSearchHit[];
    /** True when a hard filter matched too little and was relaxed to a boost. */
    filterRelaxed: boolean;
    relaxed: RelaxedConstraint[];
    total: number;
    hasMore: boolean;
    indexReady: boolean;
    period: ImslpPeriod | null;
    mode?: 'browse' | 'search';
    notReady?: string[];
}

export type ImslpEditionLicense = 'pd' | 'cc' | 'non-pd' | 'unknown';

export interface ImslpEdition {
    filename: string;
    size: number | null;
    mime: string | null;
    openUrl: string;
    /** License fields are optional so older function responses still parse. */
    license?: ImslpEditionLicense;
    /** Verbatim IMSLP tag, e.g. "Creative Commons Attribution 4.0". */
    licenseLabel?: string | null;
    /** Verbatim regional flag, e.g. "Non-PD US". */
    restriction?: string | null;
    /** Server verdict: Cleffy can fetch this file directly. */
    downloadable?: boolean;
    /** The license lookup itself failed (IMSLP unreachable) — not importable, check on IMSLP. */
    licenseCheck?: 'unavailable';
    /** Official IMSLP publisher name from the work page's `{{P}}` template. */
    publisher?: string | null;
    /** Publication year when the publisher template states one. */
    year?: number | null;
    /** Plate number when the publisher template states one. */
    plate?: string | null;
    /** IMSLP tagged this file's publisher line with `{{Urtext}}`. */
    urtext?: boolean;
    /** The IMSLP file block names an arranger. */
    arrangement?: boolean;
    /** IMSLP file description, e.g. "Complete Score". */
    description?: string | null;
}

export interface ImslpWorkDetail {
    title: string;
    composer: string | null;
    imslpUrl: string;
    editions: ImslpEdition[];
}

const FALLBACK_CODES = [
    'bot_check',
    'disclaimer',
    'not_pdf',
    'too_large',
    'upstream',
    'forbidden',
    'timeout',
    'non_pd',
    'license_unknown',
] as const;
type FallbackCode = (typeof FALLBACK_CODES)[number];

export type ImslpDownloadFallback = {
    ok: false;
    code: FallbackCode;
    message: string;
    openUrl: string;
    filename: string;
};

const functionErrorMessage = async (error: { message: string; context?: Response }): Promise<string> => {
    const res = error.context;
    if (res) {
        try {
            const body = (await res.json()) as { error?: string; message?: string };
            if (body.message) {
                return body.message;
            }
            if (body.error) {
                return body.error;
            }
        } catch {
            // ignore
        }
    }
    return error.message;
};

const messageFromJsonBody = async (res: Response): Promise<string> => {
    try {
        const body = (await res.json()) as { error?: string; message?: string };
        return body.message || body.error || `Request failed (${res.status})`;
    } catch {
        return `Request failed (${res.status})`;
    }
};

const parseDownloadFallback = (body: unknown): ImslpDownloadFallback | null => {
    if (!body || typeof body !== 'object') {
        return null;
    }
    const record = body as Record<string, unknown>;
    if (record['ok'] !== false) {
        return null;
    }
    const code = record['code'];
    if (typeof code !== 'string' || !FALLBACK_CODES.includes(code as FallbackCode)) {
        return null;
    }
    const message = record['message'];
    const openUrl = record['openUrl'];
    const filename = record['filename'];
    if (typeof message !== 'string' || typeof openUrl !== 'string' || typeof filename !== 'string') {
        return null;
    }
    return { ok: false, code: code as FallbackCode, message, openUrl, filename };
};

/** Completed searches, so repeated queries don't re-fan-out against IMSLP. */
const SEARCH_CACHE = new Map<string, { at: number; response: ImslpSearchResponse }>();
const SEARCH_CACHE_MAX = 30;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_TIMEOUT_MS = 15_000;

const searchCacheKey = (
    q: string,
    limit: number,
    offset: number,
    filters: SearchFilters | undefined,
    sort: SearchSort | undefined,
) =>
    JSON.stringify([
        q.trim().toLowerCase(),
        limit,
        offset,
        filters?.composerCategories ?? [],
        filters?.instruments ?? [],
        filters?.forms ?? [],
        filters?.keys ?? [],
        filters?.eras ?? [],
        filters?.ignoreQueryPeriod === true,
        sort ?? 'relevance',
    ]);

export const searchImslp = async (
    q: string,
    options: ImslpSearchOptions | number = 100,
): Promise<ImslpSearchResponse> => {
    const opts: ImslpSearchOptions = typeof options === 'number' ? { limit: options } : options;
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const key = searchCacheKey(q, limit, offset, opts.filters, opts.sort);
    const cached = SEARCH_CACHE.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
        // Re-insert to keep recently used entries alive under the size cap.
        SEARCH_CACHE.delete(key);
        SEARCH_CACHE.set(key, cached);
        return cached.response;
    }

    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }
    const { url: projectUrl, anonKey } = requireSupabaseConfig();

    const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const response = await fetch(`${projectUrl}/functions/v1/imslp-search`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q, limit, offset, filters: opts.filters, sort: opts.sort }),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!response.ok) {
        throw new Error(await messageFromJsonBody(response));
    }
    const body = (await response.json()) as {
        results?: ImslpSearchHit[];
        filterRelaxed?: boolean;
        relaxed?: RelaxedConstraint[];
        total?: number;
        hasMore?: boolean;
        indexReady?: boolean;
        period?: ImslpPeriod | null;
        mode?: 'browse' | 'search';
        notReady?: string[];
    };
    const relaxed = Array.isArray(body.relaxed)
        ? body.relaxed.filter((v): v is RelaxedConstraint => v === 'instrument' || v === 'era')
        : [];
    const result: ImslpSearchResponse = {
        results: body.results ?? [],
        filterRelaxed: body.filterRelaxed === true || relaxed.length > 0,
        relaxed,
        total: typeof body.total === 'number' ? body.total : (body.results?.length ?? 0),
        hasMore: body.hasMore === true,
        indexReady: body.indexReady !== false,
        period: body.period ?? null,
        mode: body.mode,
        notReady: Array.isArray(body.notReady) ? body.notReady : [],
    };
    if (result.indexReady) {
        SEARCH_CACHE.set(key, { at: Date.now(), response: result });
        if (SEARCH_CACHE.size > SEARCH_CACHE_MAX) {
            const oldest = SEARCH_CACHE.keys().next().value;
            if (oldest !== undefined) {
                SEARCH_CACHE.delete(oldest);
            }
        }
    }
    return result;
};

export const fetchImslpWork = async (title: string): Promise<ImslpWorkDetail> => {
    const { data, error } = await getSupabase().functions.invoke<ImslpWorkDetail>('imslp-work', {
        body: { title },
    });
    if (error) {
        throw new Error(await functionErrorMessage(error));
    }
    if (!data) {
        throw new Error('Empty response from IMSLP work lookup');
    }
    return data;
};

/**
 * Where a live IMSLP download is, as the panel shows it. `queued` is reported
 * only after the server actually turned a request away for pacing and a real
 * wait is under way; `downloading` when the retry goes out. A first-try
 * success reports neither.
 */
export type ImslpDownloadStage = 'queued' | 'downloading';

/** Total time a client waits behind the deployment-wide IMSLP pacing before giving up. */
export const DOWNLOAD_QUEUE_MAX_WAIT_MS = 90_000;
/** A queued wait shorter than this is not worth announcing. */
export const DOWNLOAD_QUEUE_SIGNAL_MS = 2_000;
const DOWNLOAD_QUEUE_FALLBACK_RETRY_SEC = 5;
/**
 * Floor under each successive queued retry: 1 s, 2 s, 4 s, 8 s, then 15 s.
 * The server's retryAfterSec for a full one-second pacing window is 1, and
 * imslp-download also limits each user to 10 requests a minute — retrying
 * every second through a busy spell would trip that limit. This keeps a 90 s
 * wait to about eight requests a minute.
 */
const queuedRetryFloorMs = (retriesSoFar: number): number => Math.min(15_000, 1_000 * 2 ** retriesSoFar);

/**
 * One imslp-download call. The function's own IMSLP budget is 90 s plus the
 * license check and the Storage write; past this the platform has killed it
 * or the network has, and waiting longer only leaves the panel spinning.
 */
export const IMSLP_DOWNLOAD_TIMEOUT_MS = 150_000;

export const IMSLP_DOWNLOAD_BUSY_MESSAGE =
    'IMSLP downloads are busy right now. Wait a minute, then press Add again — or open the file on IMSLP and add the PDF yourself.';
/**
 * The function may still finish after the browser stops waiting, and then the
 * score lands in the library on its own — so the copy says so rather than
 * inviting a duplicate import straight away.
 */
export const IMSLP_DOWNLOAD_TIMEOUT_MESSAGE =
    'IMSLP took too long to send this score. If it arrives it will appear in your library; otherwise try again in a minute — or open the file on IMSLP and add the PDF yourself.';

/**
 * The import was cancelled while it waited in the pacing queue (the user
 * pressed Cancel or left the page). Nothing was created and nothing charged.
 */
export class ImslpImportCancelledError extends Error {
    constructor() {
        super('IMSLP import cancelled');
        this.name = 'ImslpImportCancelledError';
    }
}

export const isImslpImportCancelled = (err: unknown): err is ImslpImportCancelledError =>
    err instanceof ImslpImportCancelledError;

/** Sleep that a cancelled import cuts short. */
const waitFor = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new ImslpImportCancelledError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new ImslpImportCancelledError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });

/**
 * Answers the client waits out and retries: the deployment-wide pacing queue
 * (`download_queued`) and the per-user request limit (`caller_rate_limited`),
 * which a school's teachers queued together can reach — both are "not yet",
 * neither is a failure.
 */
const RETRY_LATER_CODES = new Set(['download_queued', 'caller_rate_limited']);

/** retryAfterSec of a 429 the client should wait out; null for any other answer. */
const queuedRetrySec = async (response: Response): Promise<number | null> => {
    if (response.status !== 429) {
        return null;
    }
    const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
    if (!body || typeof body !== 'object') {
        return null;
    }
    const record = body as { code?: unknown; retryAfterSec?: unknown };
    if (typeof record.code !== 'string' || !RETRY_LATER_CODES.has(record.code)) {
        return null;
    }
    return typeof record.retryAfterSec === 'number' && record.retryAfterSec > 0
        ? record.retryAfterSec
        : DOWNLOAD_QUEUE_FALLBACK_RETRY_SEC;
};

const isTimeout = (err: unknown): boolean =>
    (err instanceof DOMException || err instanceof Error) && (err.name === 'TimeoutError' || err.name === 'AbortError');

export interface ImslpImportRequest {
    /** IMSLP file name, e.g. "IMSLP51037-PMLP01458-Op.27-2.pdf". */
    filename: string;
    /** Id for the new score. The function creates the row once the PDF is fetched. */
    documentId: string;
    /** Title for the new score. */
    title: string;
    acceptedDisclaimer: boolean;
    /** The IMSLP work the file belongs to (license check + provenance). */
    workTitle?: string;
    onStage?: (stage: ImslpDownloadStage) => void;
    /**
     * Cancels a queued import. It takes effect between requests — while the
     * import waits for a pacing slot — and never aborts a request already
     * sent: the function would carry on regardless, and the score it stores
     * should then simply appear in the library rather than be orphaned.
     */
    signal?: AbortSignal;
    maxWaitMs?: number;
}

/**
 * Ask the Edge Function to fetch an IMSLP PDF, create the score and write the
 * PDF into the private `scores` bucket. Returns JSON only — never proxies PDF
 * bytes through the browser (Free-plan egress).
 *
 * The score row is created server-side only once the PDF is in hand, so a
 * queued wait, a closed tab or a lost connection never leaves an empty score
 * behind. IMSLP fetches are paced deployment-wide (imslpDownloadGate.ts): a
 * full slot answers 429 download_queued with retryAfterSec, and this waits it
 * out and retries — up to maxWaitMs — reporting `queued` through onStage
 * rather than failing. Each call is bounded by IMSLP_DOWNLOAD_TIMEOUT_MS.
 */
export const importImslpPdfToStorage = async ({
    filename,
    documentId,
    title,
    acceptedDisclaimer,
    workTitle,
    onStage,
    signal,
    maxWaitMs = DOWNLOAD_QUEUE_MAX_WAIT_MS,
}: ImslpImportRequest): Promise<
    { ok: true; filename: string; byteLength: number; storagePath: string } | ImslpDownloadFallback
> => {
    if (signal?.aborted) {
        throw new ImslpImportCancelledError();
    }
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }

    const { url: projectUrl, anonKey } = requireSupabaseConfig();
    const request = async (): Promise<Response> => {
        try {
            return await fetch(`${projectUrl}/functions/v1/imslp-download`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    apikey: anonKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    filename,
                    documentId,
                    acceptedDisclaimer,
                    workTitle,
                    create: true,
                    title,
                }),
                signal: AbortSignal.timeout(IMSLP_DOWNLOAD_TIMEOUT_MS),
            });
        } catch (err) {
            if (isTimeout(err)) {
                throw new Error(IMSLP_DOWNLOAD_TIMEOUT_MESSAGE, { cause: err });
            }
            throw err;
        }
    };

    let response = await request();
    let waitedMs = 0;
    let retries = 0;
    let queuedReported = false;
    for (;;) {
        const retrySec = await queuedRetrySec(response);
        if (retrySec === null) {
            break;
        }
        const retryMs = Math.max(retrySec * 1000, queuedRetryFloorMs(retries));
        retries += 1;
        if (waitedMs + retryMs > maxWaitMs) {
            throw new Error(IMSLP_DOWNLOAD_BUSY_MESSAGE);
        }
        if (!queuedReported && waitedMs + retryMs >= DOWNLOAD_QUEUE_SIGNAL_MS) {
            // Announce only once a real wait is under way: a one-second pacing
            // blip should read as "downloading", not as a queue.
            const head = Math.max(0, DOWNLOAD_QUEUE_SIGNAL_MS - waitedMs);
            await waitFor(head, signal);
            queuedReported = true;
            onStage?.('queued');
            await waitFor(retryMs - head, signal);
        } else {
            await waitFor(retryMs, signal);
        }
        waitedMs += retryMs;
        if (queuedReported) {
            onStage?.('downloading');
        }
        response = await request();
    }

    // Smart-import quota exhausted, or the cloud-score cap full. Surfaced as
    // the same typed error the other metered features raise, so one notice
    // component renders all of them.
    const limit = await parseLimitResponse(response);
    if (limit) {
        throw limit;
    }

    if (response.status === 409) {
        const body = await response.json().catch(() => null);
        const fallback = parseDownloadFallback(body);
        if (fallback) {
            return fallback;
        }
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
        const message =
            (typeof record?.['message'] === 'string' && record['message']) ||
            (typeof record?.['error'] === 'string' && record['error']) ||
            `Download failed (${response.status})`;
        throw new Error(message);
    }

    if (!response.ok) {
        throw new Error(await messageFromJsonBody(response));
    }

    const body = (await response.json()) as {
        ok?: boolean;
        filename?: string;
        byteLength?: number;
        storagePath?: string;
    };
    if (
        body.ok !== true ||
        typeof body.filename !== 'string' ||
        typeof body.byteLength !== 'number' ||
        typeof body.storagePath !== 'string'
    ) {
        throw new Error('Unexpected response from IMSLP import');
    }
    return {
        ok: true,
        filename: body.filename,
        byteLength: body.byteLength,
        storagePath: body.storagePath,
    };
};
