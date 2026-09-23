export const IMSLP_MIN_INTERVAL_MS = 1400;

export interface TextFetcher {
    fetchText: (url: string) => Promise<string>;
}

export interface RateLimitClock {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

const defaultClock = (): RateLimitClock => ({
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

export const isMuseScoreUrl = (url: string): boolean => {
    try {
        return /(?:^|\.)musescore\.(?:com|org)$/i.test(new URL(url).hostname);
    } catch {
        return /musescore\.(com|org)/i.test(url);
    }
};

export const isImslpUrl = (url: string): boolean => {
    try {
        return /(?:^|\.)imslp\.org$/i.test(new URL(url).hostname);
    } catch {
        return /imslp\.org/i.test(url);
    }
};

export const assertFetchAllowed = (url: string): void => {
    if (isMuseScoreUrl(url)) {
        throw new Error('MuseScore.com is never fetched');
    }
};

const EVAL_UA = 'cleffy-symbolic/1 (https://github.com/maxharris1/Cleffy)';

export const createNetworkFetcher = (fetchImpl: typeof fetch = fetch): TextFetcher => ({
    async fetchText(url: string): Promise<string> {
        assertFetchAllowed(url);
        const res = await fetchImpl(url, {
            headers: { 'User-Agent': EVAL_UA },
            redirect: 'follow',
        });
        if (!res.ok) {
            throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
        }
        return res.text();
    },
});

/**
 * IMSLP MediaWiki calls are spaced >= 1.4 s. Mutopia is not delayed.
 * Inject `clock` so tests run offline without waiting.
 */
export const rateLimitedFetcher = (inner: TextFetcher, clock: RateLimitClock = defaultClock()): TextFetcher => {
    let lastImslpAt = Number.NEGATIVE_INFINITY;
    return {
        async fetchText(url: string): Promise<string> {
            assertFetchAllowed(url);
            if (isImslpUrl(url)) {
                const wait = IMSLP_MIN_INTERVAL_MS - (clock.now() - lastImslpAt);
                if (wait > 0) {
                    await clock.sleep(wait);
                }
            }
            const text = await inner.fetchText(url);
            if (isImslpUrl(url)) {
                lastImslpAt = clock.now();
            }
            return text;
        },
    };
};

export const imslpWikitextUrl = (pageTitle: string): string => {
    const u = new URL('https://imslp.org/api.php');
    u.searchParams.set('action', 'parse');
    u.searchParams.set('page', pageTitle);
    u.searchParams.set('prop', 'wikitext');
    u.searchParams.set('format', 'json');
    u.searchParams.set('formatversion', '2');
    return u.toString();
};

export const MUTOPIA_PIECE_LIST_URL = 'https://www.mutopiaproject.org/piece-list.html';
export const MUTOPIA_PIANO_CGI_URL =
    'https://www.mutopiaproject.org/cgibin/make-table.cgi?Instrument=Piano';
