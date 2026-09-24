import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { discoverCandidates } from './discover.js';
import { harvestImslpWikitext } from './imslp.js';
import {
    harvestMutopiaFtp,
    lookupMutopia,
    mutopiaFtpCatalogDirs,
    mutopiaFtpComposerDir,
    mutopiaFtpTitleDirs,
    parseMutopiaHtml,
} from './mutopia.js';
import type { WorkKey } from './types.js';
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
    const rows: string[] = ['<table><tr><th>Composer</th><th>Title</th><th>Instrument</th><th>Files</th></tr>'];
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
            expect(
                found.some((c) => c.url === midi),
                `${slug} midi lookup`,
            ).toBe(true);
            expect(
                found.some((c) => c.format === 'ly'),
                `${slug} has .ly`,
            ).toBe(true);
            expect(
                found.some((c) => c.url.endsWith('.pdf')),
                `${slug} pdf not a candidate`,
            ).toBe(false);
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

    it('walks the FTP tree for the composers the corpus seed brings in (Schubert D., Debussy CD→L)', async () => {
        const listing = (base: string, names: string[]): string =>
            names.map((n) => `<a href="${base}${n}">${n}</a>`).join('\n');
        const pages: Record<string, string> = {
            'https://www.mutopiaproject.org/ftp/SchubertF/D899/': listing(
                'https://www.mutopiaproject.org/ftp/SchubertF/D899/',
                ['impromptu-3/'],
            ),
            'https://www.mutopiaproject.org/ftp/SchubertF/D899/impromptu-3/': listing(
                'https://www.mutopiaproject.org/ftp/SchubertF/D899/impromptu-3/',
                ['impromptu-3.ly', 'impromptu-3.mid', 'impromptu-3-let.pdf'],
            ),
            'https://www.mutopiaproject.org/ftp/DebussyC/L75/': listing(
                'https://www.mutopiaproject.org/ftp/DebussyC/L75/',
                ['clair-de-lune/'],
            ),
            'https://www.mutopiaproject.org/ftp/DebussyC/L75/clair-de-lune/': listing(
                'https://www.mutopiaproject.org/ftp/DebussyC/L75/clair-de-lune/',
                ['clair-de-lune.ly', 'clair-de-lune.mid'],
            ),
        };
        const fetched: string[] = [];
        const fetchText = async (url: string): Promise<string> => {
            fetched.push(url);
            const html = pages[url];
            if (html === undefined) {
                throw new Error(`404 ${url}`);
            }
            return html;
        };

        const schubert = workKeyFromText('4 Impromptus, D.899 (Schubert, Franz)');
        expect(schubert).toEqual({ composerId: 'schubert', catalogType: 'D', catalogN: 899 });
        const pieces = await harvestMutopiaFtp(fetchText, schubert!);
        expect(pieces).toHaveLength(1);
        expect(lookupMutopia(pieces, schubert!).map((c) => c.url)).toEqual([
            'https://www.mutopiaproject.org/ftp/SchubertF/D899/impromptu-3/impromptu-3.ly',
            'https://www.mutopiaproject.org/ftp/SchubertF/D899/impromptu-3/impromptu-3.mid',
        ]);

        const debussy = workKeyFromText('Suite bergamasque, CD 82 (Debussy, Claude)');
        expect(debussy).toEqual({ composerId: 'debussy', catalogType: 'CD', catalogN: 82 });
        expect(mutopiaFtpCatalogDirs(debussy!)).toEqual(['L75']);
        const clair = await harvestMutopiaFtp(fetchText, debussy!);
        expect(clair.flatMap((p) => p.files.map((f) => f.filename))).toEqual(['clair-de-lune.ly', 'clair-de-lune.mid']);

        expect(mutopiaFtpComposerDir('joplin')).toBe('JoplinS');
        expect(mutopiaFtpCatalogDirs({ composerId: 'liszt', catalogType: 'S', catalogN: 172 })).toEqual([
            'S.172',
            'S172',
        ]);
        expect(mutopiaFtpCatalogDirs({ composerId: 'haydn', catalogType: 'Hob', catalogN: 27 })).toEqual([
            'HOB-XVI-27',
        ]);
        expect(mutopiaFtpCatalogDirs({ composerId: 'field', catalogType: 'H', catalogN: 37 })).toEqual([
            'H37',
            'H.37',
        ]);
        expect(mutopiaFtpComposerDir('mussorgsky')).toBe('MussorgskyM');
        expect(
            mutopiaFtpTitleDirs({ composerId: 'satie', catalogType: 'No', catalogN: 0 }),
        ).toEqual(['gymnopedie_1', 'gymnopedie_2', 'gymnopedie_3']);
        expect(fetched.every((url) => url.startsWith('https://www.mutopiaproject.org/ftp/'))).toBe(true);
    });

    it('leaves guitar and tab transcriptions out of the candidate list', async () => {
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/';
        const pages: Record<string, string> = {
            [dir]: ['fur_Elise_WoO59/', 'fur-elise-guitar-duo/'].map((n) => `<a href="${dir}${n}">${n}</a>`).join('\n'),
            [`${dir}fur_Elise_WoO59/`]: ['fur_Elise_WoO59.ly', 'fur_Elise_WoO59.mid']
                .map((n) => `<a href="${dir}fur_Elise_WoO59/${n}">${n}</a>`)
                .join('\n'),
            [`${dir}fur-elise-guitar-duo/`]: ['fur-elise-guitar-duo.ly', 'fur-elise-guitar-duo.mid']
                .map((n) => `<a href="${dir}fur-elise-guitar-duo/${n}">${n}</a>`)
                .join('\n'),
        };
        const fetchText = async (url: string): Promise<string> => {
            const html = pages[url];
            if (html === undefined) {
                throw new Error(`404 ${url}`);
            }
            return html;
        };

        const key: WorkKey = { composerId: 'beethoven', catalogType: 'WoO', catalogN: 59 };
        const pieces = await harvestMutopiaFtp(fetchText, key);

        expect(pieces).toHaveLength(2);
        expect(lookupMutopia(pieces, key).map((c) => c.url)).toEqual([
            `${dir}fur_Elise_WoO59/fur_Elise_WoO59.ly`,
            `${dir}fur_Elise_WoO59/fur_Elise_WoO59.mid`,
        ]);
    });

    it('indexes Mutopia -mids.zip archives as MIDI candidates', async () => {
        const dir = 'https://www.mutopiaproject.org/ftp/BeethovenLv/O27/';
        const piece = `${dir}moonlight/`;
        const pages: Record<string, string> = {
            [dir]: `<a href="${piece}">moonlight/</a>`,
            [piece]: ['moonlight-let.pdf', 'moonlight-mids.zip', 'moonlight-lys.zip']
                .map((n) => `<a href="${piece}${n}">${n}</a>`)
                .join('\n'),
        };
        const fetchText = async (url: string): Promise<string> => {
            const html = pages[url];
            if (html === undefined) {
                throw new Error(`404 ${url}`);
            }
            return html;
        };
        const key: WorkKey = { composerId: 'beethoven', catalogType: 'Op', catalogN: 27, movementIndex: 2 };
        const pieces = await harvestMutopiaFtp(fetchText, key);
        expect(pieces.flatMap((p) => p.files.map((f) => f.filename))).toEqual(['moonlight-mids.zip']);
        expect(lookupMutopia(pieces, key).map((c) => c.url)).toEqual([`${piece}moonlight-mids.zip`]);
    });

    it('finds Mutopia title-folder MIDI for Gymnopédies and Debussy CD→L', async () => {
        const gymDir = 'https://www.mutopiaproject.org/ftp/SatieE/gymnopedie_2/';
        const l66 = 'https://www.mutopiaproject.org/ftp/DebussyC/L66/';
        const arab = `${l66}debussy_Arabesque_1/`;
        const pages: Record<string, string> = {
            [gymDir]: ['gymnopedie_2.ly', 'gymnopedie_2.mid']
                .map((n) => `<a href="${gymDir}${n}">${n}</a>`)
                .join('\n'),
            [l66]: `<a href="${arab}">debussy_Arabesque_1/</a>`,
            [arab]: ['debussy_Arabesque_1.ly', 'debussy_Arabesque_1.mid']
                .map((n) => `<a href="${arab}${n}">${n}</a>`)
                .join('\n'),
        };
        const fetchText = async (url: string): Promise<string> => {
            const html = pages[url];
            if (html === undefined) {
                throw new Error(`404 ${url}`);
            }
            return html;
        };
        const gymSet = workKeyFromText('3 Gymnopédies (Satie, Erik)')!;
        const gymPieces = await harvestMutopiaFtp(fetchText, gymSet);
        expect(lookupMutopia(gymPieces, gymSet).map((c) => c.url)).toEqual([
            `${gymDir}gymnopedie_2.ly`,
            `${gymDir}gymnopedie_2.mid`,
        ]);
        const arabesques = workKeyFromText('2 Arabesques, CD 74 (Debussy, Claude)')!;
        const arabPieces = await harvestMutopiaFtp(fetchText, arabesques);
        expect(lookupMutopia(arabPieces, arabesques).some((c) => c.url.endsWith('.mid'))).toBe(true);
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
