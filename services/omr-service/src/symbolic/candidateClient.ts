import { assertFetchAllowed, imslpWikitextUrl, MUTOPIA_PIECE_LIST_URL, type TextFetcher } from './http.js';
import { harvestImslpWikitext } from './imslp.js';
import { discoverCandidates } from './discover.js';
import { parseMutopiaHtml } from './mutopia.js';
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
 */
export const createNetworkSymbolicClient = (
    text: TextFetcher,
    bytes: BytesFetcher,
    timeoutMs: number = DEFAULT_SYMBOLIC_TIMEOUT_MS,
): SymbolicJobClient => ({
    discover: async (workKey, meta) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const html = await Promise.race([
            text.fetchText(MUTOPIA_PIECE_LIST_URL),
            abortError(signal, 'mutopia index'),
        ]);
        const index = parseMutopiaHtml(html);
        let imslpFiles: ReturnType<typeof harvestImslpWikitext> = [];
        if (meta.imslpPageTitle) {
            const raw = await Promise.race([
                text.fetchText(imslpWikitextUrl(meta.imslpPageTitle)),
                abortError(signal, 'imslp wikitext'),
            ]);
            imslpFiles = harvestImslpWikitext(parseImslpWikitextPayload(raw));
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
