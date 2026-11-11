import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureEntries } from '../../scripts/imslp-popular-titles-fixture.mjs';
import { POPULAR_WORKS } from '../../supabase/functions/_shared/popularWorks';

/**
 * POPULAR_WORKS titles must be exact IMSLP page titles: `imslp-work` resolves
 * them verbatim, the corpus seed looks licences up under them, and IA record
 * ids encode them. IMSLP renames pages, so the fixture is a snapshot of
 * `action=query&redirects=1` for every title, refreshed with
 * `node --experimental-strip-types scripts/imslp-popular-titles-fixture.mjs`.
 * Without the fixture (fresh clone, no network run yet) the check is skipped.
 */
const FIXTURE = resolve(process.cwd(), 'tests/imslp/fixtures/popular-titles.json');

type Entry = { exists: boolean; resolvedTo: string | null };

describe('POPULAR_WORKS titles vs IMSLP', () => {
    const present = existsSync(FIXTURE);
    const fixture = present ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { titles: Record<string, Entry> }) : null;

    it.skipIf(!present)('every popular title is a live IMSLP page under exactly that title (cached fixture)', () => {
        const titles = [...new Set(POPULAR_WORKS.map((w) => w.title))];
        const stale: string[] = [];
        for (const title of titles) {
            const entry = fixture!.titles[title];
            if (!entry) {
                stale.push(`${title} → not in fixture (refresh it)`);
            } else if (!entry.exists) {
                stale.push(`${title} → missing on IMSLP`);
            } else if (entry.resolvedTo !== title) {
                stale.push(`${title} → redirects to ${entry.resolvedTo}`);
            }
        }
        expect(stale, stale.join('\n')).toEqual([]);
    });

    it('reads existence, normalisation and redirects out of a batched query response', () => {
        const response = {
            query: {
                normalized: [
                    {
                        from: 'für Elise, WoO 59 (Beethoven, Ludwig van)',
                        to: 'Für Elise, WoO 59 (Beethoven, Ludwig van)',
                    },
                ],
                redirects: [
                    {
                        from: 'Swan Lake, Op.20 (Tchaikovsky, Pyotr)',
                        to: 'Swan Lake (ballet), Op.20 (Tchaikovsky, Pyotr)',
                    },
                ],
                pages: {
                    '14377': { pageid: 14377, ns: 0, title: 'Für Elise, WoO 59 (Beethoven, Ludwig van)' },
                    '111081': { pageid: 111081, ns: 0, title: 'Swan Lake (ballet), Op.20 (Tchaikovsky, Pyotr)' },
                    '-1': { ns: 0, title: 'Nothing (Nobody, Anon)', missing: '' },
                },
            },
        };
        expect(
            fixtureEntries(
                [
                    'für Elise, WoO 59 (Beethoven, Ludwig van)',
                    'Swan Lake, Op.20 (Tchaikovsky, Pyotr)',
                    'Nothing (Nobody, Anon)',
                ],
                response,
            ),
        ).toEqual({
            'für Elise, WoO 59 (Beethoven, Ludwig van)': {
                exists: true,
                resolvedTo: 'Für Elise, WoO 59 (Beethoven, Ludwig van)',
            },
            'Swan Lake, Op.20 (Tchaikovsky, Pyotr)': {
                exists: true,
                resolvedTo: 'Swan Lake (ballet), Op.20 (Tchaikovsky, Pyotr)',
            },
            'Nothing (Nobody, Anon)': { exists: false, resolvedTo: null },
        });
    });
});
