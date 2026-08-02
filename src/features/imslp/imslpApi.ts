import type { SearchFilters, SearchSort } from '@/features/imslp/searchFacets';
import { getSupabase } from '@/lib/supabase';

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

export const searchImslp = async (
    q: string,
    options: ImslpSearchOptions | number = 100,
): Promise<ImslpSearchHit[]> => {
    const opts: ImslpSearchOptions = typeof options === 'number' ? { limit: options } : options;
    const limit = opts.limit ?? 100;
    const { data, error } = await getSupabase().functions.invoke<{ results: ImslpSearchHit[] }>(
        'imslp-search',
        {
            body: {
                q,
                limit,
                filters: opts.filters,
                sort: opts.sort,
            },
        },
    );
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
 * Proxy download. Uses authenticated fetch (not functions.invoke) because the
 * edge returns raw application/pdf bytes on success and JSON only on 409 fallback.
 */
export const downloadImslpPdf = async (
    filename: string,
    acceptedDisclaimer: boolean,
): Promise<{ ok: true; bytes: ArrayBuffer; filename: string } | ImslpDownloadFallback> => {
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }

    const projectUrl = import.meta.env.VITE_SUPABASE_URL as string;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    const response = await fetch(`${projectUrl}/functions/v1/imslp-download`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filename, acceptedDisclaimer }),
    });

    const contentType = response.headers.get('Content-Type') ?? '';
    if (response.ok && contentType.includes('application/pdf')) {
        return { ok: true, bytes: await response.arrayBuffer(), filename };
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

    throw new Error(await messageFromJsonBody(response));
};
