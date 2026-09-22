import { assertFetchAllowed, type TextFetcher } from './http.js';
import { discoverCandidates } from './discover.js';
import { harvestMutopiaFtp } from './mutopia.js';
import { expandMutopiaMidiZips, wrapZipBytesFetcher } from './midiZip.js';
import { pianoMidiCandidates } from './pianoMidi.js';
import type { RankedCandidate, WorkKey } from './types.js';

export const DEFAULT_SYMBOLIC_TIMEOUT_MS = 120_000;

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

/**
 * Mutopia FTP (including `-mids.zip`) plus piano-midi.de via Wayback.
 * IMSLP wikitext harvest stays off so we never wait on imslp.org PDFs.
 */
export const createNetworkSymbolicClient = (
    text: TextFetcher,
    bytes: BytesFetcher,
    timeoutMs: number = DEFAULT_SYMBOLIC_TIMEOUT_MS,
): SymbolicJobClient => {
    const zipBytes = wrapZipBytesFetcher(bytes);
    return {
        discover: async (workKey, meta) => {
            const signal = AbortSignal.timeout(timeoutMs);
            const index = await Promise.race([
                harvestMutopiaFtp((url) => text.fetchText(url), workKey),
                abortError(signal, 'mutopia index'),
            ]);
            const ranked = discoverCandidates({
                workKey,
                mutopiaIndex: index,
                imslpFiles: [],
                ...(meta.imslpPageTitle !== undefined ? { imslpPageTitle: meta.imslpPageTitle } : {}),
            });
            const expanded = await expandMutopiaMidiZips(ranked, zipBytes);
            const extra = pianoMidiCandidates(workKey);
            const seen = new Set(expanded.map((c) => c.url));
            const out = [...expanded];
            for (const cand of extra) {
                if (!seen.has(cand.url)) {
                    seen.add(cand.url);
                    out.push(cand);
                }
            }
            return out;
        },
        fetchBytes: (url) => zipBytes.fetchBytes(url, AbortSignal.timeout(timeoutMs)),
    };
};

const abortError = (signal: AbortSignal, label: string): Promise<never> =>
    new Promise((_, reject) => {
        const fail = (): void => reject(new Error(`timeout ${label}`));
        if (signal.aborted) {
            fail();
            return;
        }
        signal.addEventListener('abort', fail, { once: true });
    });
