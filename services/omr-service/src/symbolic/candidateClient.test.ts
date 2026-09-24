import { describe, expect, it } from 'vitest';

import { createNetworkSymbolicClient, type BytesFetcher } from './candidateClient.js';
import type { TextFetcher } from './http.js';
import type { WorkKey } from './types.js';

const FUR_ELISE: WorkKey = { composerId: 'beethoven', catalogType: 'WoO', catalogN: 59 };

const listing = (hrefs: readonly string[]): string =>
    `<html><body>${hrefs.map((h) => `<a href="${h}">${h}</a>`).join('')}</body></html>`;

const fetcherFor = (pages: Record<string, string>, seen: string[]): TextFetcher => ({
    fetchText: async (url) => {
        seen.push(url);
        const body = pages[url];
        if (body === undefined) {
            throw new Error(`GET ${url} failed: 404`);
        }
        return body;
    },
});

const noBytes: BytesFetcher = {
    fetchBytes: async () => {
        throw new Error('not used');
    },
};

describe('createNetworkSymbolicClient.discover', () => {
    it('indexes Mutopia from the FTP listing, never piece-list.html', async () => {
        const seen: string[] = [];
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/';
        const piece = `${dir}fur_Elise/`;
        const client = createNetworkSymbolicClient(
            fetcherFor(
                {
                    [dir]: listing(['fur_Elise/']),
                    [piece]: listing(['fur_Elise_WoO59.ly', 'fur_Elise_WoO59.mid', 'fur_Elise_WoO59-let.pdf']),
                },
                seen,
            ),
            noBytes,
        );

        const candidates = await client.discover(FUR_ELISE, {});

        expect(candidates.filter((c) => c.source === 'mutopia').map((c) => c.url)).toEqual([
            `${piece}fur_Elise_WoO59.ly`,
            `${piece}fur_Elise_WoO59.mid`,
        ]);
        expect(candidates.some((c) => c.url.includes('elise_format0.mid'))).toBe(true);
        expect(seen.some((url) => url.includes('piece-list.html'))).toBe(false);
    });

    it('keeps the Mutopia candidates when the IMSLP wikitext call fails', async () => {
        const seen: string[] = [];
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/';
        const piece = `${dir}fur_Elise/`;
        const client = createNetworkSymbolicClient(
            fetcherFor({ [dir]: listing(['fur_Elise/']), [piece]: listing(['fur_Elise_WoO59.mid']) }, seen),
            noBytes,
        );

        const candidates = await client.discover(FUR_ELISE, {
            imslpPageTitle: 'Für Elise, WoO 59 (Beethoven, Ludwig van)',
        });

        expect(candidates.filter((c) => c.source === 'mutopia').map((c) => c.url)).toEqual([
            `${piece}fur_Elise_WoO59.mid`,
        ]);
        expect(seen.some((url) => url.includes('imslp.org'))).toBe(false);
    });

    it('still returns piano-midi.de when Mutopia FTP has no files', async () => {
        const seen: string[] = [];
        const client = createNetworkSymbolicClient(fetcherFor({}, seen), noBytes);

        await expect(client.discover(FUR_ELISE, {})).resolves.toEqual(
            expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('elise_format0.mid') })]),
        );
        expect(seen).toEqual(['https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/']);
    });

    it('bounds a stalled -mids.zip download by the discover timeout and aborts the fetch', async () => {
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/';
        const piece = `${dir}fur_Elise/`;
        const signals: Array<AbortSignal | undefined> = [];
        const stalled: BytesFetcher = {
            fetchBytes: (_url, signal) => {
                signals.push(signal);
                return new Promise((_, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                });
            },
        };
        const client = createNetworkSymbolicClient(
            fetcherFor({ [dir]: listing(['fur_Elise/']), [piece]: listing(['fur_Elise_WoO59-mids.zip']) }, []),
            stalled,
            50,
        );

        const candidates = await client.discover(FUR_ELISE, {});

        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(true);
        expect(candidates.some((c) => c.url.includes('-mids.zip'))).toBe(false);
        expect(candidates.some((c) => c.url.includes('elise_format0.mid'))).toBe(true);
    });

    it('drops a zip whose fetcher ignores the abort signal and still returns the rest', async () => {
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/';
        const piece = `${dir}fur_Elise/`;
        const deaf: BytesFetcher = { fetchBytes: () => new Promise<Buffer>(() => undefined) };
        const client = createNetworkSymbolicClient(
            fetcherFor({ [dir]: listing(['fur_Elise/']), [piece]: listing(['fur_Elise_WoO59-mids.zip']) }, []),
            deaf,
            50,
        );

        const candidates = await client.discover(FUR_ELISE, {});

        expect(candidates.some((c) => c.url.includes('-mids.zip'))).toBe(false);
        expect(candidates.some((c) => c.url.includes('elise_format0.mid'))).toBe(true);
    });

    it('hands the Mutopia index fetches the discover signal so a timed-out harvest stops', async () => {
        const signals: Array<AbortSignal | undefined> = [];
        const stalled: TextFetcher = {
            fetchText: (_url, signal) => {
                signals.push(signal);
                return new Promise<string>(() => undefined);
            },
        };
        const client = createNetworkSymbolicClient(stalled, noBytes, 50);

        await expect(client.discover(FUR_ELISE, {})).rejects.toThrow(/timeout/);
        expect(signals[0]?.aborted).toBe(true);
    });
});
