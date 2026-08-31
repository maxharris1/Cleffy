import { parseLimitResponse } from '@/features/billing/limitErrors';
import type { SearchFilters, SearchSort } from '@/features/imslp/searchFacets';
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
    filters?: SearchFilters;
    sort?: SearchSort;
    /** Cancels the request (the panel aborts superseded searches). */
    signal?: AbortSignal;
}

export interface ImslpSearchResponse {
    results: ImslpSearchHit[];
    /** True when the instrument filter matched too little and was relaxed to a boost. */
    filterRelaxed: boolean;
    /** False when chip browse ran against an incomplete category index. */
    indexReady?: boolean;
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
}

export interface ImslpWorkDetail {
    title: string;
    composer: string | null;
    imslpUrl: string;
    editions: ImslpEdition[];
}

const FALLBACK_CODES = ['bot_check', 'disclaimer', 'not_pdf', 'too_large', 'upstream', 'non_pd'] as const;
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

const searchCacheKey = (q: string, limit: number, filters: SearchFilters | undefined, sort: SearchSort | undefined) =>
    JSON.stringify([
        q.trim().toLowerCase(),
        limit,
        filters?.composerCategory ?? null,
        filters?.instrument ?? null,
        filters?.form ?? null,
        filters?.key ?? null,
        filters?.era ?? null,
        sort ?? 'relevance',
    ]);

export const searchImslp = async (
    q: string,
    options: ImslpSearchOptions | number = 100,
): Promise<ImslpSearchResponse> => {
    const opts: ImslpSearchOptions = typeof options === 'number' ? { limit: options } : options;
    const limit = opts.limit ?? 100;

    const key = searchCacheKey(q, limit, opts.filters, opts.sort);
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
        body: JSON.stringify({ q, limit, filters: opts.filters, sort: opts.sort }),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!response.ok) {
        throw new Error(await messageFromJsonBody(response));
    }
    const body = (await response.json()) as {
        results?: ImslpSearchHit[];
        filterRelaxed?: boolean;
        indexReady?: boolean;
    };
    const result: ImslpSearchResponse = {
        results: body.results ?? [],
        filterRelaxed: body.filterRelaxed === true,
        indexReady: body.indexReady !== false,
    };
    SEARCH_CACHE.set(key, { at: Date.now(), response: result });
    if (SEARCH_CACHE.size > SEARCH_CACHE_MAX) {
        const oldest = SEARCH_CACHE.keys().next().value;
        if (oldest !== undefined) {
            SEARCH_CACHE.delete(oldest);
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
 * Ask the Edge Function to fetch an IMSLP PDF and write it into the private
 * `scores` bucket for an already-created document. Returns JSON only — never
 * proxies PDF bytes through the browser (Free-plan egress).
 */
export const importImslpPdfToStorage = async (
    filename: string,
    documentId: string,
    acceptedDisclaimer: boolean,
): Promise<{ ok: true; filename: string; byteLength: number; storagePath: string } | ImslpDownloadFallback> => {
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }

    const { url: projectUrl, anonKey } = requireSupabaseConfig();
    const response = await fetch(`${projectUrl}/functions/v1/imslp-download`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename, documentId, acceptedDisclaimer }),
    });

    // Smart-import quota exhausted. Surfaced as the same typed error the other
    // metered features raise, so one notice component renders all of them.
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
