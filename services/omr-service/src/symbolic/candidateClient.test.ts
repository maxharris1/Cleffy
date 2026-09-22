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
            expect.arrayContaining([
                expect.objectContaining({ url: expect.stringContaining('elise_format0.mid') }),
            ]),
        );
        expect(seen).toEqual(['https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/']);
    });
});
