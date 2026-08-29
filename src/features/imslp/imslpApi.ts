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
}

export interface ImslpEdition {
    filename: string;
    size: number | null;
    mime: string | null;
    openUrl: string;
}

export interface ImslpWorkDetail {
    title: string;
    composer: string | null;
    imslpUrl: string;
    editions: ImslpEdition[];
}

const FALLBACK_CODES = ['bot_check', 'disclaimer', 'not_pdf', 'too_large', 'upstream'] as const;
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

export const searchImslp = async (q: string, options: ImslpSearchOptions | number = 100): Promise<ImslpSearchHit[]> => {
    const opts: ImslpSearchOptions = typeof options === 'number' ? { limit: options } : options;
    const limit = opts.limit ?? 100;
    const { data, error } = await getSupabase().functions.invoke<{ results: ImslpSearchHit[] }>('imslp-search', {
        body: {
            q,
            limit,
            filters: opts.filters,
            sort: opts.sort,
        },
    });
    if (error) {
        throw new Error(await functionErrorMessage(error));
    }
    return data?.results ?? [];
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
