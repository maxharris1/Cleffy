import { describe, expect, it } from 'vitest';

import {
    assertFetchAllowed,
    IMSLP_MIN_INTERVAL_MS,
    isMuseScoreUrl,
    rateLimitedFetcher,
    type TextFetcher,
} from './http.js';

describe('symbolic HTTP', () => {
    it('refuses MuseScore.com', () => {
        expect(isMuseScoreUrl('https://musescore.com/user/x/scores/1')).toBe(true);
        expect(() => assertFetchAllowed('https://musescore.com/score.xml')).toThrow(/never fetched/);
    });

    it('spaces IMSLP MediaWiki calls by at least 1.4s', async () => {
        let now = 10_000;
        const sleeps: number[] = [];
        const hits: string[] = [];
        const inner: TextFetcher = {
            fetchText: async (url) => {
                hits.push(url);
                return 'ok';
            },
        };
        const fetcher = rateLimitedFetcher(inner, {
            now: () => now,
            sleep: async (ms) => {
                sleeps.push(ms);
                now += ms;
            },
        });
        await fetcher.fetchText('https://imslp.org/api.php?page=A');
        expect(sleeps).toEqual([]);
        now += 200;
        await fetcher.fetchText('https://imslp.org/api.php?page=B');
        expect(sleeps[0]).toBeGreaterThanOrEqual(IMSLP_MIN_INTERVAL_MS - 200);
        await fetcher.fetchText('https://www.mutopiaproject.org/piece-list.html');
        expect(hits).toHaveLength(3);
        expect(sleeps).toHaveLength(1);
    });
});
