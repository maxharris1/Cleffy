import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { discoverCandidates } from './discover.js';
import { harvestImslpWikitext } from './imslp.js';
import { lookupMutopia, parseMutopiaHtml } from './mutopia.js';
import { workKeyFromMutopiaPath, workKeyFromText } from './workKey.js';

/**
 * Same 16 slugs as `BENCH_SUITE` in `src/eval/bench.ts`. Listed here so this
 * file does not import the bench runner (which pulls Audiveris / zip deps).
 */
const PIN_SLUGS = [
    'czerny-op821-01',
    'bach-prelude-bwv939',
    'bach-air-anh131',
    'bach-invention-01',
    'bach-invention-08',
    'bach-prelude-bwv999',
    'wtk1-prelude1',
    'anna-magdalena-04',
    'anna-magdalena-05',
    'anna-magdalena-07',
    'burgmuller-op100-02',
    'schumann-op68-01',
    'schumann-op68-05',
    'gymnopedie-2',
    'fur-elise-mutopia',
    'chopin-prelude-4',
] as const;

const pinUrls = (slug: (typeof PIN_SLUGS)[number]): string[] => {
    const entry = loadCorpusEntry(slug);
    const urls = [entry.pdf.url];
    if (entry.reference.source === 'mutopia') {
        urls.push(entry.reference.url);
    }
    return urls;
};

/** Compact CGI-table fixture covering the 16 bench pins plus a guitar decoy. */
const mutopiaFixtureHtml = (): string => {
    const rows: string[] = [
        '<table><tr><th>Composer</th><th>Title</th><th>Instrument</th><th>Files</th></tr>',
    ];
    for (const slug of PIN_SLUGS) {
        const entry = loadCorpusEntry(slug);
        const midi = entry.reference.source === 'mutopia' ? entry.reference.url : '';
        const ly = midi.replace(/\.mid$/i, '.ly');
        rows.push(
            `<tr><td>${entry.title}</td><td>${entry.title}</td><td>Piano</td><td>` +
                `<a href="${entry.pdf.url}">pdf</a> ` +
                (midi !== '' ? `<a href="${midi}">mid</a> ` : '') +
                `<a href="${ly}">ly</a>` +
                `</td></tr>`,
        );
    }
    rows.push(
        '<tr><td>MozartWA</td><td>Ah vous dirai-je (guitar)</td><td>Guitar</td><td>' +
            '<a href="https://www.mutopiaproject.org/ftp/MozartWA/K265/k265-guitar/k265-guitar.mid">mid</a>' +
            '</td></tr>',
    );
    rows.push('</table>');
    return rows.join('\n');
};

const SCHUMANN_WIKITEXT = `
{{File
|File Name 1=2._Soldatenmarsch.mxl
|File Description 1=Piano (No. 2)
|File Name 2=8._Wilder_Reiter.mxl
|File Description 2=Piano
|File Name 3=Melodie_recording.mp3
|File Description 3=Audio performance
|File Name 4=schumann-op68-01-melodie.mid
|File Description 4=Synthesized MIDI
}}
`;

const BWV999_WIKITEXT = `
{{File
|File Name 1=Prelude_BWV999_lute_cello_duo.mxl
|File Description 1=Arrangement for lute and cello duo
|File Name 2=BWV999-WIMA.mid
|File Description 2=Synthesized MIDI
|File Name 3=Gnossienne_quintet.mscz
|File Description 3=Quintet scoring
}}
`;

describe('Mutopia index + lookup', () => {
    it('resolves every pin URL in eval/corpus via the index fixture', () => {
        const index = parseMutopiaHtml(mutopiaFixtureHtml());
        const missing: string[] = [];
        for (const slug of PIN_SLUGS) {
            const entry = loadCorpusEntry(slug);
            const key =
                workKeyFromMutopiaPath(entry.pdf.url) ??
                workKeyFromText(entry.title) ??
                workKeyFromMutopiaPath(entry.reference.source === 'mutopia' ? entry.reference.url : '');
            expect(key, `${slug} workKey`).toBeTruthy();
            if (!key) {
                continue;
            }
            const piece = index.find((p) => p.files.some((f) => pinUrls(slug).includes(f.url)));
            if (!piece) {
                missing.push(`${slug} (piece missing from index)`);
                continue;
            }
            for (const url of pinUrls(slug)) {
                if (!piece.files.some((f) => f.url === url)) {
                    missing.push(`${slug} ${url}`);
                }
            }
            const found = lookupMutopia(index, key);
            const midi = entry.reference.source === 'mutopia' ? entry.reference.url : '';
            expect(found.some((c) => c.url === midi), `${slug} midi lookup`).toBe(true);
            expect(found.some((c) => c.format === 'ly'), `${slug} has .ly`).toBe(true);
            expect(found.some((c) => c.url.endsWith('.pdf')), `${slug} pdf not a candidate`).toBe(false);
        }
        expect(missing, missing.join('\n')).toEqual([]);
    });

    it('keeps Mutopia .pdf URLs on the index and off the ranked candidate list', () => {
        const index = parseMutopiaHtml(mutopiaFixtureHtml());
        expect(index.some((p) => p.files.some((f) => f.filename.toLowerCase().endsWith('.pdf')))).toBe(true);
        for (const piece of index) {
            const key = piece.workKey;
            if (!key) {
                continue;
            }
            const ranked = lookupMutopia(index, key);
            expect(ranked.some((c) => c.url.toLowerCase().endsWith('.pdf'))).toBe(false);
        }
    });

    it('drops non-piano Mutopia rows (guitar decoy)', () => {
        const index = parseMutopiaHtml(mutopiaFixtureHtml());
        expect(index.some((p) => p.files.some((f) => f.url.includes('k265-guitar')))).toBe(false);
    });
});

describe('IMSLP harvest + discover', () => {
    it('does not propose Schumann 2._Soldatenmarsch.mxl for schumann-op68-01', () => {
        const entry = loadCorpusEntry('schumann-op68-01');
        const workKey = workKeyFromText(entry.title);
        expect(workKey).toMatchObject({
            composerId: 'schumann',
            catalogType: 'Op',
            catalogN: 68,
            movementIndex: 1,
        });
        const harvested = harvestImslpWikitext(SCHUMANN_WIKITEXT);
        expect(harvested.some((f) => f.name === '2._Soldatenmarsch.mxl')).toBe(true);
        expect(harvested.some((f) => f.name.endsWith('.mp3'))).toBe(false);
        const ranked = discoverCandidates({
            workKey: workKey!,
            imslpPageTitle: entry.title,
            mutopiaIndex: parseMutopiaHtml(mutopiaFixtureHtml()),
            imslpFiles: harvested,
        });
        expect(ranked.some((c) => c.url.includes('2._Soldatenmarsch'))).toBe(false);
        expect(ranked.some((c) => c.url.includes('schumann-op68-01'))).toBe(true);
    });

    it('skips the BWV 999 lute/cello duo .mxl as an arrangement', () => {
        const harvested = harvestImslpWikitext(BWV999_WIKITEXT);
        expect(harvested.some((f) => f.name.includes('duo'))).toBe(false);
        expect(harvested.some((f) => f.name.endsWith('.mscz'))).toBe(false);
        expect(harvested.some((f) => f.name.endsWith('.mid'))).toBe(true);
    });
});
