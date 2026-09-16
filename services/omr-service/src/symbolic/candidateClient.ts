import { assertFetchAllowed, imslpWikitextUrl, type TextFetcher } from './http.js';
import { harvestImslpWikitext } from './imslp.js';
import { discoverCandidates } from './discover.js';
import { harvestMutopiaFtp } from './mutopia.js';
import type { RankedCandidate, WorkKey } from './types.js';

export const DEFAULT_SYMBOLIC_TIMEOUT_MS = 20_000;

export interface SymbolicJobClient {
    discover: (workKey: WorkKey, meta: { imslpPageTitle?: string }) => Promise<RankedCandidate[]>;
    fetchBytes: (url: string) => Promise<Buffer>;
}

export interface BytesFetcher {
    fetchBytes: (url: string, signal?: AbortSignal) => Promise<Buffer>;
}

export const createNetworkBytesFetcher = (fetchImpl: typeof fetch = fetch): BytesFetcher => ({
    async fetchBytes(url: string, signal?: AbortSignal): Promise<Buffer> {
        assertFetchAllowed(url);
        const res = await fetchImpl(url, {
            headers: { 'User-Agent': 'cleffy-symbolic/1 (https://github.com/maxharris1/Cleffy)' },
            redirect: 'follow',
            signal,
        });
        if (!res.ok) {
            throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
        }
        return Buffer.from(await res.arrayBuffer());
    },
});

const parseImslpWikitextPayload = (raw: string): string => {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && 'parse' in parsed) {
            const parse = (parsed as { parse?: { wikitext?: string } }).parse;
            if (typeof parse?.wikitext === 'string') {
                return parse.wikitext;
            }
        }
    } catch {
        // plain wikitext
    }
    return raw;
};

/**
 * Mutopia index + optional IMSLP harvest, then byte fetch. All network
 * calls share `timeoutMs` via AbortSignal.
 *
 * The index comes from the FTP directory listing for this work's composer and
 * catalogue, not from piece-list.html: that page stopped embedding ftp:// links,
 * so parsing it yields zero candidates and every job falls through to OMR.
 */
export const createNetworkSymbolicClient = (
    text: TextFetcher,
    bytes: BytesFetcher,
    timeoutMs: number = DEFAULT_SYMBOLIC_TIMEOUT_MS,
): SymbolicJobClient => ({
    discover: async (workKey, meta) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const index = await Promise.race([
            harvestMutopiaFtp((url) => text.fetchText(url), workKey),
            abortError(signal, 'mutopia index'),
        ]);
        let imslpFiles: ReturnType<typeof harvestImslpWikitext> = [];
        if (meta.imslpPageTitle) {
            try {
                const raw = await Promise.race([
                    text.fetchText(imslpWikitextUrl(meta.imslpPageTitle)),
                    abortError(signal, 'imslp wikitext'),
                ]);
                imslpFiles = harvestImslpWikitext(parseImslpWikitextPayload(raw));
            } catch {
                // imslp.org/api.php answers 500 often enough that failing the whole
                // discovery here would drop the Mutopia candidates already in hand.
            }
        }
        return discoverCandidates({
            workKey,
            mutopiaIndex: index,
            imslpFiles,
            ...(meta.imslpPageTitle !== undefined ? { imslpPageTitle: meta.imslpPageTitle } : {}),
        });
    },
    fetchBytes: (url) => bytes.fetchBytes(url, AbortSignal.timeout(timeoutMs)),
});

const abortError = (signal: AbortSignal, label: string): Promise<never> =>
    new Promise((_, reject) => {
        const fail = (): void => reject(new Error(`timeout ${label}`));
        if (signal.aborted) {
            fail();
            return;
        }
        signal.addEventListener('abort', fail, { once: true });
    });
