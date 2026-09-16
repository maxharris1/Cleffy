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

        expect(candidates.map((c) => c.url)).toEqual([`${piece}fur_Elise_WoO59.ly`, `${piece}fur_Elise_WoO59.mid`]);
        expect(candidates.every((c) => c.source === 'mutopia')).toBe(true);
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

        expect(candidates.map((c) => c.url)).toEqual([`${piece}fur_Elise_WoO59.mid`]);
        expect(seen.some((url) => url.includes('imslp.org'))).toBe(true);
    });

    it('returns no candidates when the composer has no FTP directory for the catalogue', async () => {
        const seen: string[] = [];
        const client = createNetworkSymbolicClient(fetcherFor({}, seen), noBytes);

        await expect(client.discover(FUR_ELISE, {})).resolves.toEqual([]);
        expect(seen).toEqual(['https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/']);
    });
});
