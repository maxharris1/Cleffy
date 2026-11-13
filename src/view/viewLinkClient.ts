/**
 * The /v viewer's only network code. Everything goes to `/api/view` on this
 * origin as a POST with the token in the JSON body — never in a URL — with no
 * credentials, no Referer and no HTTP cache. The one exception is the
 * large-PDF fallback: a 60-second signed Storage URL, fetched once.
 */

export const VIEW_ENDPOINT = '/api/view';

/** A mark to draw. */
export interface ViewMark {
    id: string;
    page: number;
    kind: 'stroke' | 'highlight' | 'text';
    color: string;
    payload: unknown;
    seq: number;
    deleted: false;
}

/** An erased mark: the server sends which one and when, nothing of what it was. */
export interface ViewTombstone {
    id: string;
    seq: number;
    deleted: true;
}

export type ViewAnnotation = ViewMark | ViewTombstone;

export interface ViewPoll {
    doc: { pages: number | null; pdf_rev: number };
    pdf: 'proxy' | 'direct';
    annotations: ViewAnnotation[];
    max_seq: number;
    more: boolean;
}

type Failure =
    { kind: 'gone' } | { kind: 'unavailable' } | { kind: 'offline' } | { kind: 'busy'; retryAfterMs: number };

export type PollResult = { kind: 'ok'; poll: ViewPoll } | Failure;
export type PdfResult = { kind: 'ok'; bytes: ArrayBuffer; via: 'proxy' | 'direct' } | Failure;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const PRIVATE_INIT: RequestInit = {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
};

const post = (fetchImpl: FetchLike, body: Record<string, unknown>) =>
    fetchImpl(VIEW_ENDPOINT, {
        ...PRIVATE_INIT,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

/** What a non-2xx answer means to the viewer. */
const failureOf = (res: Response): Failure => {
    if (res.status === 410) {
        return { kind: 'gone' };
    }
    if (res.status === 404) {
        return { kind: 'unavailable' };
    }
    if (res.status === 429) {
        const seconds = Number(res.headers.get('Retry-After'));
        return { kind: 'busy', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000 };
    }
    return { kind: 'offline' };
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export const pollView = async (
    token: string,
    since: number,
    fetchImpl: FetchLike = defaultFetch,
): Promise<PollResult> => {
    try {
        const res = await post(fetchImpl, { token, since });
        if (!res.ok) {
            return failureOf(res);
        }
        return { kind: 'ok', poll: (await res.json()) as ViewPoll };
    } catch {
        return { kind: 'offline' };
    }
};

/**
 * The score's bytes. Proxy mode: the POST answers with the PDF. Direct mode
 * (over 4 MB): it answers with a signed https URL, fetched once.
 */
export const loadViewPdf = async (token: string, fetchImpl: FetchLike = defaultFetch): Promise<PdfResult> => {
    try {
        const res = await post(fetchImpl, { token, pdf: true });
        if (!res.ok) {
            return failureOf(res);
        }
        if ((res.headers.get('Content-Type') ?? '').startsWith('application/pdf')) {
            return { kind: 'ok', bytes: await res.arrayBuffer(), via: 'proxy' };
        }
        const body = (await res.json()) as { pdf?: string; url?: unknown };
        if (body.pdf !== 'direct' || typeof body.url !== 'string' || !body.url.startsWith('https://')) {
            return { kind: 'offline' };
        }
        const file = await fetchImpl(body.url, { ...PRIVATE_INIT, method: 'GET' });
        if (!file.ok) {
            return { kind: 'offline' };
        }
        return { kind: 'ok', bytes: await file.arrayBuffer(), via: 'direct' };
    } catch {
        return { kind: 'offline' };
    }
};

/**
 * Merge a poll's marks into what is known, by seq: a newer version replaces
 * an older one, and a tombstone replaces the mark it erased. Tombstones stay
 * in the map (id and seq only, nothing to draw) so a row older than the
 * erase can never bring the mark back. Returns a new map; visibleMarks()
 * gives what to draw.
 */
export const mergeAnnotations = (
    current: ReadonlyMap<string, ViewAnnotation>,
    incoming: readonly ViewAnnotation[],
): Map<string, ViewAnnotation> => {
    const next = new Map(current);
    for (const mark of incoming) {
        const existing = next.get(mark.id);
        if (existing && existing.seq >= mark.seq) {
            continue;
        }
        next.set(mark.id, mark.deleted ? { id: mark.id, seq: mark.seq, deleted: true } : mark);
    }
    return next;
};

/** The marks to draw, oldest first: everything in the map but the tombstones. */
export const visibleMarks = (known: ReadonlyMap<string, ViewAnnotation>): ViewMark[] =>
    [...known.values()].filter((mark): mark is ViewMark => !mark.deleted).sort((a, b) => a.seq - b.seq);
