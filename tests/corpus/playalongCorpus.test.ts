import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CANONICAL_SURNAMES,
    LEDGER_STATUSES,
    LICENCE_TAGS,
    MAX_ATTEMPTS,
    MAX_FILES_PER_WORK,
    backoffDelayMs,
    canTransition,
    catalogEquals,
    catalogMatches,
    catalogRefsFromMutopiaDir,
    catalogRefsFromText,
    composerMatchesMutopiaId,
    coverageByOrigin,
    coveredWorkCount,
    demandFromDocumentTitles,
    evalPinPieceDirs,
    expandCatalogRefs,
    expandZipResolution,
    iaExactQuery,
    iaFallbackQueries,
    iaResolution,
    imslpFileLicenceFor,
    imslpRedirectAliases,
    licenceTagOf,
    licenceVerdict,
    mutopiaPieceCandidate,
    mutopiaPieceMatches,
    mutopiaPiecesFromTree,
    mutopiaResolution,
    openscoreResolution,
    openscoreWorkMatches,
    openscoreWorksFromTree,
    parseMutopiaRdf,
    parseSources,
    pickIaDoc,
    pickIaPdf,
    planWork,
    progressEvent,
    rankWorks,
    reconcileQueued,
    shouldProcess,
    titleForMutopiaPiece,
    titleWordsMatch,
    workLevelLicence,
    zipEntries,
    zipExtract,
} from '../../scripts/playalong-corpus.mjs';
import { POPULAR_WORKS } from '../../supabase/functions/_shared/popularWorks';

const MOONLIGHT = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
const FUR_ELISE = 'Für Elise, WoO 59 (Beethoven, Ludwig van)';
const WTC1 = 'The Well-Tempered Clavier I, BWV 846–869 (Bach, Johann Sebastian)';
const GYMNOPEDIES = '3 Gymnopédies (Satie, Erik)';
const EMPEROR_QUARTET = 'String Quartet in C major, Op.76 No.3 (Haydn, Joseph)';

const rdfXml = (fields: Record<string, string>): string =>
    `<?xml version="1.0"?><rdf:RDF><rdf:Description rdf:about=".">${Object.entries(fields)
        .map(([k, v]) => `<mp:${k}>${v}</mp:${k}>`)
        .join('')}</rdf:Description></rdf:RDF>`;

const furEliseRdf = parseMutopiaRdf(
    rdfXml({
        title: 'Für Elise',
        composer: 'BeethovenLv',
        opus: 'WoO 59',
        for: 'Piano',
        date: '1810',
        source: 'Breitkopf &amp;amp; Härtel, 1888',
        licence: 'Public Domain',
        lyFile: 'fur_Elise_WoO59.ly',
        midFile: 'fur_Elise_WoO59.mid',
        pdfFileLet: 'fur_Elise_WoO59-let.pdf',
        pdfFileA4: 'fur_Elise_WoO59-a4.pdf',
        id: 'Mutopia-2015/08/18-931',
        maintainer: 'Stelios Samelis',
    }),
);

const furElisePiece = {
    dir: 'ftp/BeethovenLv/WoO59/fur_Elise_WoO59',
    piece: 'fur_Elise_WoO59',
    composerId: 'BeethovenLv',
    catalogDir: 'WoO59',
};

describe('constraint values', () => {
    it('match the check constraints in the corpus migrations', () => {
        const corpus = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20260916140000_playalong_corpus.sql'),
            'utf8',
        );
        expect(corpus).toContain(
            `licence_tag text check (licence_tag in (${LICENCE_TAGS.map((t) => `'${t}'`).join(', ')}))`,
        );
        expect(corpus).toContain(`check (status in (${LEDGER_STATUSES.map((s) => `'${s}'`).join(', ')}))`);
    });

    it('keeps CANONICAL_SURNAMES a superset of ERA_SURNAMES in _shared/era.ts', () => {
        const era = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/era.ts'), 'utf8');
        const block = era.slice(
            era.indexOf('const ERA_SURNAMES'),
            era.indexOf('};', era.indexOf('const ERA_SURNAMES')),
        );
        const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(30);
        for (const name of names) {
            expect(CANONICAL_SURNAMES).toContain(name);
        }
    });
});

describe('catalog references', () => {
    it('parses the popular-list title shapes', () => {
        expect(catalogRefsFromText('Piano Sonata No.14, Op.27 No.2')).toEqual([{ type: 'Op', n: 27, no: 2 }]);
        expect(catalogRefsFromText('Für Elise, WoO 59')).toEqual([{ type: 'WoO', n: 59 }]);
        expect(catalogRefsFromText('The Well-Tempered Clavier I, BWV 846–869')).toEqual([
            { type: 'BWV', n: 846, nEnd: 869 },
        ]);
        expect(catalogRefsFromText('Minuet in G major, BWV Anh.114')).toEqual([{ type: 'Anh', n: 114 }]);
        expect(catalogRefsFromText('Piano Sonata No.11, K.331/300i')).toEqual([{ type: 'K', n: 331 }]);
        expect(catalogRefsFromText('Keyboard Sonata in C major, Hob.XVI:50')).toEqual([{ type: 'Hob.XVI', n: 50 }]);
        expect(catalogRefsFromText('Liebesträume, S.541')).toEqual([{ type: 'S', n: 541 }]);
        expect(catalogRefsFromText('Kinderszenen')).toEqual([]);
    });

    it('maps Debussy CD numbers onto the Lesure dirs Mutopia uses', () => {
        expect(expandCatalogRefs([{ type: 'CD', n: 74 }])).toEqual([
            { type: 'CD', n: 74 },
            { type: 'L', n: 66 },
        ]);
        expect(expandCatalogRefs([{ type: 'L', n: 117 }])).toEqual([
            { type: 'L', n: 117 },
            { type: 'CD', n: 125 },
        ]);
        expect(expandCatalogRefs([{ type: 'Op', n: 9 }])).toEqual([{ type: 'Op', n: 9 }]);
        const arabesque = {
            dir: 'ftp/DebussyC/L66/arabesque-1',
            piece: 'arabesque-1',
            composerId: 'DebussyC',
            catalogDir: 'L66',
        };
        expect(mutopiaPieceCandidate({ title: '2 Arabesques, CD 74 (Debussy, Claude)' }, arabesque)).toBe(true);
        expect(mutopiaPieceCandidate({ title: 'Suite bergamasque, CD 82 (Debussy, Claude)' }, arabesque)).toBe(false);
    });

    it('reads Mutopia catalog directories', () => {
        expect(catalogRefsFromMutopiaDir('L117')).toEqual([{ type: 'L', n: 117 }]);
        expect(catalogRefsFromMutopiaDir('S.172')).toEqual([{ type: 'S', n: 172 }]);
        expect(catalogRefsFromMutopiaDir('HOB-XVI-27')).toEqual([{ type: 'Hob.XVI', n: 27 }]);
        expect(catalogRefsFromMutopiaDir('O27')).toEqual([{ type: 'Op', n: 27 }]);
        expect(catalogRefsFromMutopiaDir('Op_821')).toEqual([{ type: 'Op', n: 821 }]);
        expect(catalogRefsFromMutopiaDir('BWVAnh114')).toEqual([{ type: 'Anh', n: 114 }]);
        expect(catalogRefsFromMutopiaDir('BWV846')).toEqual([{ type: 'BWV', n: 846 }]);
        expect(catalogRefsFromMutopiaDir(null)).toEqual([]);
        expect(catalogRefsFromMutopiaDir('moonlight')).toEqual([]);
    });

    it('matches ranges, whole sets, and refuses a different No.', () => {
        const wtc = catalogRefsFromText('BWV 846–869');
        expect(catalogMatches(wtc, [{ type: 'BWV', n: 846 }])).toBe(true);
        expect(catalogMatches(wtc, [{ type: 'BWV', n: 870 }])).toBe(false);
        const op76n3 = [{ type: 'Op', n: 76, no: 3 }];
        expect(catalogMatches(op76n3, [{ type: 'Op', n: 76 }])).toBe(true);
        expect(
            catalogMatches(op76n3, [
                { type: 'Op', n: 76 },
                { type: 'Op', n: 76, no: 1 },
            ]),
        ).toBe(false);
        expect(catalogMatches([{ type: 'Op', n: 9 }], [{ type: 'Op', n: 9, no: 2 }])).toBe(true);
        expect(catalogEquals([{ type: 'Op', n: 27, no: 2 }], [{ type: 'Op', n: 27, no: 1 }])).toBe(false);
        expect(catalogEquals([{ type: 'Op', n: 27, no: 2 }], [{ type: 'Op', n: 27, no: 2 }])).toBe(true);
    });

    it('falls back to title words for uncatalogued works', () => {
        expect(titleWordsMatch(GYMNOPEDIES, 'Gymnopédie No. 2')).toBe(true);
        expect(titleWordsMatch('The Entertainer (Joplin, Scott)', 'The Entertainer')).toBe(true);
        expect(titleWordsMatch('Solace (Joplin, Scott)', 'The Entertainer')).toBe(false);
    });

    it('matches composers by Mutopia id prefix', () => {
        expect(composerMatchesMutopiaId('Bach', 'BachJS')).toBe(true);
        expect(composerMatchesMutopiaId('Mendelssohn', 'Mendelssohn-BartholdyF')).toBe(true);
        expect(composerMatchesMutopiaId('Bach', 'BeethovenLv')).toBe(false);
    });
});

describe('licence filter', () => {
    it('maps labels onto the licence_tag constraint values', () => {
        expect(licenceTagOf('Public Domain')).toBe('PD');
        expect(licenceTagOf('Creative Commons Attribution-ShareAlike 2.5')).toBe('CC-BY-SA');
        expect(licenceTagOf('Creative Commons Attribution Share Alike 3.0')).toBe('CC-BY-SA');
        expect(licenceTagOf('Creative Commons Attribution 4.0')).toBe('CC-BY');
        expect(licenceTagOf('Creative Commons Zero 1.0')).toBe('CC0');
        expect(licenceTagOf('Creative Commons Attribution Non-commercial 3.0')).toBeNull();
        expect(licenceTagOf('Creative Commons Attribution-NonCommercial-NoDerivs 4.0')).toBeNull();
        expect(licenceTagOf('Performance Restricted Attribution-NonCommercial 3.0')).toBeNull();
        expect(licenceTagOf('Non-PD US')).toBeNull();
        expect(licenceTagOf(null)).toBeNull();
        for (const tag of ['PD', 'CC0', 'CC-BY', 'CC-BY-SA']) {
            expect(LICENCE_TAGS).toContain(tag);
        }
    });

    it('accepts PD/CC0/CC BY/CC BY-SA that are US-PD and rejects the rest', () => {
        expect(licenceVerdict({ label: 'Public Domain', year: 1888 })).toEqual({
            accept: true,
            tag: 'PD',
            usPd: true,
            reason: null,
        });
        expect(licenceVerdict({ label: 'Public Domain', year: null })).toMatchObject({ accept: true, usPd: true });
        expect(licenceVerdict({ label: 'Public Domain', year: 1950 })).toMatchObject({
            accept: false,
            reason: 'not_us_pd',
        });
        expect(licenceVerdict({ label: 'Public Domain', restriction: 'Non-PD US' })).toMatchObject({
            accept: false,
            reason: 'not_us_pd',
        });
        expect(licenceVerdict({ label: 'Public Domain', restriction: 'Non-PD EU' })).toMatchObject({
            accept: false,
            reason: 'not_us_pd',
        });
        expect(licenceVerdict({ label: 'Public Domain', euHosted: true })).toMatchObject({
            accept: false,
            reason: 'eu_hosted',
        });
        expect(licenceVerdict({ label: 'Creative Commons Attribution 4.0', year: 2015 })).toMatchObject({
            accept: true,
            tag: 'CC-BY',
            usPd: true,
        });
        expect(licenceVerdict({ label: 'Creative Commons Attribution-NonCommercial 3.0' })).toMatchObject({
            accept: false,
            reason: 'non_commercial',
        });
        expect(licenceVerdict({ label: 'Performance Restricted Attribution 3.0' })).toMatchObject({
            accept: false,
            reason: 'performance_restricted',
        });
        expect(licenceVerdict({ label: null })).toMatchObject({ accept: false, reason: 'no_licence' });
    });

    it('binds IA scan names to IMSLP file tags loosely and falls back to the work level', () => {
        const licences = new Map([
            [
                'PMLP14377-Beethoven Fur Elise.pdf',
                { licenseLabel: 'Public Domain', restriction: null, euHosted: false },
            ],
            [
                'PMLP14377-Elise urtext.pdf',
                { licenseLabel: 'Creative Commons Attribution 4.0', restriction: 'Non-PD US', euHosted: false },
            ],
        ]);
        expect(imslpFileLicenceFor('Beethoven_Fur_Elise.pdf', licences)?.licenseLabel).toBe('Public Domain');
        expect(imslpFileLicenceFor('Something_else.pdf', licences)).toBeNull();
        // Work level: a clean PD file qualifies; flagged / CC-only / EU-only pages do not.
        expect(workLevelLicence(licences)?.licenseLabel).toBe('Public Domain');
        licences.delete('PMLP14377-Beethoven Fur Elise.pdf');
        expect(workLevelLicence(licences)).toBeNull();
        expect(
            workLevelLicence(
                new Map([
                    ['a.pdf', { licenseLabel: 'Creative Commons Attribution 4.0', restriction: null, euHosted: false }],
                ]),
            ),
        ).toBeNull();
        expect(
            workLevelLicence(
                new Map([['a.pdf', { licenseLabel: 'Public Domain', restriction: null, euHosted: true }]]),
            ),
        ).toBeNull();
        expect(workLevelLicence(new Map())).toBeNull();
    });
});

describe('Mutopia', () => {
    const tree = [
        'ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.ly',
        'ftp/BeethovenLv/O27/moonlight/moonlight-lys/moonlight1-let.ly',
        'ftp/BeethovenLv/O27/moonlight/moonlight-lys/moonlight2-let.ly',
        'ftp/BeethovenLv/O27/moonlight-guitar-duo/moonlight-guitar-duo.ly',
        'ftp/SatieE/gymnopedie_2/gymnopedie_2.ly',
        'ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.ly',
        'ftp/BachJS/BWV846/wtk1-prelude1/Makefile',
        'ftp/README.txt',
    ];

    it('lists piece directories from the git tree, collapsing -lys folders', () => {
        const pieces = mutopiaPiecesFromTree(tree);
        expect(pieces.map((p) => p.dir)).toEqual([
            'ftp/BachJS/BWV846/wtk1-prelude1',
            'ftp/BeethovenLv/O27/moonlight',
            'ftp/BeethovenLv/O27/moonlight-guitar-duo',
            'ftp/BeethovenLv/WoO59/fur_Elise_WoO59',
            'ftp/SatieE/gymnopedie_2',
        ]);
        expect(pieces.find((p) => p.piece === 'gymnopedie_2')).toMatchObject({
            composerId: 'SatieE',
            catalogDir: null,
        });
        expect(pieces.find((p) => p.piece === 'moonlight')).toMatchObject({
            composerId: 'BeethovenLv',
            catalogDir: 'O27',
        });
    });

    it('pre-filters candidates by composer and catalog directory, then confirms on the RDF', () => {
        const pieces = mutopiaPiecesFromTree(tree);
        const forElise = pieces.filter((p) => mutopiaPieceCandidate({ title: FUR_ELISE }, p));
        expect(forElise.map((p) => p.piece)).toEqual(['fur_Elise_WoO59']);
        const forMoonlight = pieces.filter((p) => mutopiaPieceCandidate({ title: MOONLIGHT }, p));
        expect(forMoonlight.map((p) => p.piece).sort()).toEqual(['moonlight', 'moonlight-guitar-duo']);
        expect(pieces.filter((p) => mutopiaPieceCandidate({ title: WTC1 }, p)).map((p) => p.piece)).toEqual([
            'wtk1-prelude1',
        ]);
        expect(pieces.filter((p) => mutopiaPieceCandidate({ title: GYMNOPEDIES }, p)).map((p) => p.piece)).toEqual([
            'gymnopedie_2',
        ]);

        expect(mutopiaPieceMatches({ title: FUR_ELISE }, furElisePiece, furEliseRdf)).toBe(true);
        expect(mutopiaPieceMatches({ title: MOONLIGHT }, furElisePiece, furEliseRdf)).toBe(false);
        const duo = parseMutopiaRdf(
            rdfXml({ title: 'Moonlight', opus: 'Op. 27, No. 2', arranger: 'Someone', licence: 'Public Domain' }),
        );
        expect(mutopiaPieceMatches({ title: MOONLIGHT }, forMoonlight[1]!, duo)).toBe(false);
        const gym = parseMutopiaRdf(
            rdfXml({ title: 'Gymnopédie No. 2', for: 'Piano', licence: 'Public Domain', date: '1888' }),
        );
        expect(mutopiaPieceMatches({ title: GYMNOPEDIES }, pieces[4]!, gym)).toBe(true);
        const op76n1 = parseMutopiaRdf(
            rdfXml({ title: 'Quartet', opus: 'Op. 76', for: 'String Quartet', licence: 'Public Domain' }),
        );
        expect(
            mutopiaPieceMatches(
                { title: EMPEROR_QUARTET },
                { dir: 'ftp/HaydnFJ/O76/op76-n1', piece: 'op76-n1', composerId: 'HaydnFJ', catalogDir: 'O76' },
                op76n1,
            ),
        ).toBe(false);
    });

    it('parses the RDF and builds a resolution with provenance', () => {
        expect(furEliseRdf.source).toBe('Breitkopf & Härtel, 1888');
        const res = mutopiaResolution({ title: FUR_ELISE }, furElisePiece, furEliseRdf);
        expect(res).toMatchObject({
            ok: true,
            origin: 'mutopia',
            workTitle: FUR_ELISE,
            filename: 'fur_Elise_WoO59-let.pdf',
            pdfUrl: 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59-let.pdf',
            candidateUrl: 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.mid',
            sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931',
            licenceTag: 'PD',
            usPd: true,
            editorCredit: 'Stelios Samelis, after Breitkopf & Härtel, 1888 (Mutopia)',
            pianoSolo: true,
        });
        expect(res.pdfUrl).not.toMatch(/imslp\.org/);
    });

    it('skips non-commercial licences and pieces without a PDF', () => {
        const nc = parseMutopiaRdf(
            rdfXml({ licence: 'Creative Commons Attribution-NonCommercial 3.0', pdfFileLet: 'x-let.pdf' }),
        );
        expect(mutopiaResolution({ title: FUR_ELISE }, furElisePiece, nc)).toMatchObject({
            ok: false,
            reason: 'non_commercial',
        });
        const guitar = parseMutopiaRdf(
            rdfXml({ licence: 'Public Domain', for: 'Guitar', pdfFileLet: 'anna-magdalena-04-guitar-let.pdf' }),
        );
        expect(mutopiaResolution({ title: FUR_ELISE }, furElisePiece, guitar)).toMatchObject({
            ok: false,
            reason: 'arrangement_only',
        });
        const none = parseMutopiaRdf(rdfXml({ licence: 'Public Domain' }));
        expect(mutopiaResolution({ title: FUR_ELISE }, furElisePiece, none)).toMatchObject({
            ok: false,
            reason: 'no_source',
        });
    });

    it('resolves eval pins to IMSLP titles (popular first, narrowest catalog page next)', () => {
        const pins = [
            {
                pdf: {
                    url: 'https://www.mutopiaproject.org/ftp/BachJS/BWVAnh114/anna-magdalena-04/anna-magdalena-04-let.pdf',
                },
            },
            {
                pdf: { url: 'https://imslp.org/wiki/Special:IMSLPDisclaimerAccept/895428' },
                reference: { url: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-mids.zip' },
            },
            { pdf: { url: 'https://example.test/toy.pdf' } },
        ];
        expect(evalPinPieceDirs(pins)).toEqual([
            'ftp/BachJS/BWVAnh114/anna-magdalena-04',
            'ftp/BeethovenLv/O27/moonlight',
        ]);

        const anh = {
            dir: 'ftp/BachJS/BWVAnh114/anna-magdalena-04',
            piece: 'anna-magdalena-04',
            composerId: 'BachJS',
            catalogDir: 'BWVAnh114',
        };
        expect(
            titleForMutopiaPiece(
                anh,
                parseMutopiaRdf(rdfXml({ title: 'Menuet', opus: 'BWV Anh. 114' })),
                POPULAR_WORKS,
                [],
            ),
        ).toBe('Minuet in G major, BWV Anh.114 (Pezold, Christian)');
        const bwv939 = {
            dir: 'ftp/BachJS/BWV939/bwv-939',
            piece: 'bwv-939',
            composerId: 'BachJS',
            catalogDir: 'BWV939',
        };
        const catalog = [
            {
                page_title: '5 Little Preludes, BWV 939-943 (Bach, Johann Sebastian)',
                composer: 'Bach, Johann Sebastian',
                categories: [],
                touched: null,
            },
            {
                page_title: 'Prelude in C major, BWV 939 (Bach, Johann Sebastian)',
                composer: 'Bach, Johann Sebastian',
                categories: [],
                touched: null,
            },
        ];
        expect(
            titleForMutopiaPiece(
                bwv939,
                parseMutopiaRdf(rdfXml({ title: 'Little Prelude', opus: 'BWV 939' })),
                POPULAR_WORKS,
                catalog,
            ),
        ).toBe('Prelude in C major, BWV 939 (Bach, Johann Sebastian)');
        // An opus number never crosses composers: Schumann's Op.68 is not Beethoven's Pastoral.
        const op68 = {
            dir: 'ftp/SchumannR/O68/schumann-op68-01-melodie',
            piece: 'schumann-op68-01-melodie',
            composerId: 'SchumannR',
            catalogDir: 'O68',
        };
        const schumann = [
            {
                page_title: 'Album für die Jugend, Op.68 (Schumann, Robert)',
                composer: 'Schumann, Robert',
                categories: [],
                touched: null,
            },
        ];
        expect(
            titleForMutopiaPiece(
                op68,
                parseMutopiaRdf(rdfXml({ title: 'Melodie', opus: 'Op. 68' })),
                POPULAR_WORKS,
                schumann,
            ),
        ).toBe('Album für die Jugend, Op.68 (Schumann, Robert)');
        expect(
            titleForMutopiaPiece(
                op68,
                parseMutopiaRdf(rdfXml({ title: 'Melodie', opus: 'Op. 68' })),
                POPULAR_WORKS,
                [],
            ),
        ).toBeNull();
        const gym = { dir: 'ftp/SatieE/gymnopedie_2', piece: 'gymnopedie_2', composerId: 'SatieE', catalogDir: null };
        expect(
            titleForMutopiaPiece(gym, parseMutopiaRdf(rdfXml({ title: 'Gymnopédie No. 2' })), POPULAR_WORKS, []),
        ).toBe(GYMNOPEDIES);
    });
});

describe('Mutopia zips', () => {
    /** Build a stored (method 0) zip in memory: local headers, central directory, EOCD. */
    const storedZip = (files: Array<[string, string]>): Buffer => {
        const locals: Buffer[] = [];
        const centrals: Buffer[] = [];
        let offset = 0;
        for (const [name, text] of files) {
            const nameBuf = Buffer.from(name, 'utf8');
            const data = Buffer.from(text, 'utf8');
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(0, 8);
            local.writeUInt32LE(data.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            locals.push(local, nameBuf, data);
            const central = Buffer.alloc(46);
            central.writeUInt32LE(0x02014b50, 0);
            central.writeUInt16LE(0, 10);
            central.writeUInt32LE(data.length, 20);
            central.writeUInt32LE(data.length, 24);
            central.writeUInt16LE(nameBuf.length, 28);
            central.writeUInt32LE(offset, 42);
            centrals.push(central, nameBuf);
            offset += local.length + nameBuf.length + data.length;
        }
        const centralBytes = Buffer.concat(centrals);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(files.length, 8);
        eocd.writeUInt16LE(files.length, 10);
        eocd.writeUInt32LE(centralBytes.length, 12);
        eocd.writeUInt32LE(offset, 16);
        return Buffer.concat([...locals, centralBytes, eocd]);
    };

    it('lists and extracts entries from a Mutopia-style *-pdfs.zip', () => {
        const zip = storedZip([
            ['moonlight1-let.pdf', '%PDF-1'],
            ['moonlight2-let.pdf', '%PDF-2'],
            ['violino-1-part-let.pdf', '%PDF-part'],
            ['__MACOSX/._moonlight1-let.pdf', 'junk'],
            ['README.txt', 'hi'],
        ]);
        const entries = zipEntries(zip);
        expect(entries.map((e) => e.name)).toEqual([
            'moonlight1-let.pdf',
            'moonlight2-let.pdf',
            'violino-1-part-let.pdf',
            '__MACOSX/._moonlight1-let.pdf',
            'README.txt',
        ]);
        expect(zipExtract(zip, entries[1]!).toString()).toBe('%PDF-2');
        // Orchestral/choral part names inside a Mutopia zip (Mass in B minor ships score + every part).
        const mass = expandZipResolution({ ok: true, origin: 'mutopia', filename: 'mass-let-pdfs.zip', zipUrl: 'z' }, [
            'score-let.pdf',
            'bass-let.pdf',
            'bassoon1-let.pdf',
            'continuo-let.pdf',
            'hornF-let.pdf',
            'soprano1-let.pdf',
            'violino1-let.pdf',
        ]);
        expect(mass.map((r) => r.filename)).toEqual(['score-let.pdf']);
        const zipRes = {
            ok: true,
            origin: 'mutopia',
            workTitle: MOONLIGHT,
            filename: 'moonlight-let-pdfs.zip',
            zipUrl: 'https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-let-pdfs.zip',
            pdfUrl: null,
        };
        const expanded = expandZipResolution(
            zipRes,
            entries.map((e) => e.name),
        );
        expect(expanded.map((r) => [r.filename, r.zipEntry, r.pdfUrl, r.zipUrl])).toEqual([
            ['moonlight1-let.pdf', 'moonlight1-let.pdf', null, zipRes.zipUrl],
            ['moonlight2-let.pdf', 'moonlight2-let.pdf', null, zipRes.zipUrl],
        ]);
    });

    it('resolves a zip-only piece to a zip resolution the CLI expands', () => {
        const zip = parseMutopiaRdf(
            rdfXml({
                licence: 'Public Domain',
                pdfFileLet: 'x-let-pdfs.zip',
                pdfFileA4: 'x-a4-pdfs.zip',
                date: '1802',
            }),
        );
        expect(mutopiaResolution({ title: FUR_ELISE }, furElisePiece, zip)).toMatchObject({
            ok: true,
            filename: 'x-let-pdfs.zip',
            pdfUrl: null,
            zipUrl: 'https://www.mutopiaproject.org/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/x-let-pdfs.zip',
        });
    });
});

describe('OpenScore', () => {
    const tree = [
        'scores/Beethoven,_Ludwig_van/String_Quartet_No.1,_Op.18_No.1/README.md',
        'scores/Beethoven,_Ludwig_van/String_Quartet_No.1,_Op.18_No.1/sq8071278-Part-Viola.pdf',
        'scores/Beethoven,_Ludwig_van/String_Quartet_No.1,_Op.18_No.1/sq8071278.mxl',
        'scores/Beethoven,_Ludwig_van/String_Quartet_No.1,_Op.18_No.1/sq8071278.pdf',
        'scores/Schubert,_Franz/Schwanengesang,_D.957/4_Ständchen/lc123.mscz',
        'scores/Schubert,_Franz/Schwanengesang,_D.957/4_Ständchen/lc123.mxl',
    ];
    const repo = { id: 'sq', rawBase: 'https://raw.test/', htmlBase: 'https://html.test/', credit: 'OpenScore (CC0)' };

    it('matches work folders by composer + title / catalog and picks the full score', () => {
        const works = openscoreWorksFromTree(tree);
        expect(works).toHaveLength(2);
        const quartet = works[0]!;
        expect(
            openscoreWorkMatches({ title: 'String Quartet No.1, Op.18 No.1 (Beethoven, Ludwig van)' }, quartet),
        ).toBe(true);
        expect(
            openscoreWorkMatches({ title: 'String Quartet No.2, Op.18 No.2 (Beethoven, Ludwig van)' }, quartet),
        ).toBe(false);
        expect(openscoreWorkMatches({ title: 'Schwanengesang, D.957 (Schubert, Franz)' }, works[1]!)).toBe(true);
        const res = openscoreResolution(
            { title: 'String Quartet No.1, Op.18 No.1 (Beethoven, Ludwig van)' },
            quartet,
            repo,
        );
        expect(res).toMatchObject({
            ok: true,
            origin: 'openscore',
            filename: 'sq8071278.pdf',
            pdfUrl: 'https://raw.test/scores/Beethoven,_Ludwig_van/String_Quartet_No.1,_Op.18_No.1/sq8071278.pdf',
            licenceTag: 'CC0',
            usPd: true,
            editorCredit: 'OpenScore (CC0)',
        });
    });

    it('skips repos without PDFs unless a renderer is available', () => {
        const lied = openscoreWorksFromTree(tree)[1]!;
        expect(openscoreResolution({ title: 'Schwanengesang, D.957 (Schubert, Franz)' }, lied, repo)).toMatchObject({
            ok: false,
            reason: 'no_renderer',
        });
        expect(
            openscoreResolution({ title: 'Schwanengesang, D.957 (Schubert, Franz)' }, lied, repo, { renderer: true }),
        ).toMatchObject({
            ok: true,
            renderFrom: 'https://raw.test/scores/Schubert,_Franz/Schwanengesang,_D.957/4_Ständchen/lc123.mscz',
        });
    });
});

describe('Internet Archive', () => {
    it('builds the exact record-id query from the IMSLP page title', () => {
        expect(iaExactQuery(FUR_ELISE)).toBe(
            'collection:imslp AND external-identifier:"urn:imslp_record_id:RsO8ciBFbGlzZSwgV29PIDU5IChCZWV0aG92ZW4sIEx1ZHdpZyB2YW4p"',
        );
        expect(iaFallbackQueries(MOONLIGHT)).toEqual([
            'collection:imslp AND creator:"Beethoven, Ludwig van" AND title:"Op.27 No.2"',
            'collection:imslp AND creator:"Beethoven, Ludwig van" AND title:"piano sonata no 14"',
        ]);
    });

    it('only accepts the same work from a fallback search', () => {
        const docs = [
            { identifier: 'a', title: 'Piano Sonata No.13, Op.27 No.1', creator: 'Beethoven, Ludwig van' },
            { identifier: 'b', title: 'Piano Sonata No.14, Op.27 No.2', creator: 'Beethoven, Ludwig van' },
        ];
        expect(pickIaDoc(MOONLIGHT, docs)?.identifier).toBe('b');
        expect(pickIaDoc(MOONLIGHT, [docs[0]!])).toBeNull();
        expect(
            pickIaDoc('Canon and Gigue in D major, P.37 (Pachelbel, Johann)', [
                { title: 'Canon and Gigue in D major', creator: 'Pachelbel, Johann' },
            ]),
        ).not.toBeNull();
        expect(
            pickIaDoc('Canon and Gigue in D major, P.37 (Pachelbel, Johann)', [
                { title: 'Canon and Gigue in D major', creator: 'Someone Else' },
            ]),
        ).toBeNull();
    });

    it('keeps only same-composer former titles from the redirect table', () => {
        const response = {
            query: {
                backlinks: [
                    { pageid: 1, ns: 0, title: 'Swan Lake, Op.20 (Tchaikovsky, Pyotr Ilyich)', redirect: '' },
                    { pageid: 2, ns: 0, title: 'Swan Lake (ballet), Op.20 (Tchaikovsky, Pyotr)', redirect: '' },
                    {
                        pageid: 3,
                        ns: 0,
                        title: "Selections from Tchaikovsky's 'Swan Lake' (Bantock, Granville)",
                        redirect: '',
                    },
                    { pageid: 4, ns: 4, title: 'IMSLP:Swan Lake', redirect: '' },
                ],
            },
        };
        expect(imslpRedirectAliases('Swan Lake (ballet), Op.20 (Tchaikovsky, Pyotr)', response)).toEqual([
            'Swan Lake, Op.20 (Tchaikovsky, Pyotr Ilyich)',
        ]);
        expect(imslpRedirectAliases('X (Y, Z)', null)).toEqual([]);
    });

    it('picks the original PDF and applies the IMSLP tag for the bound file', () => {
        const files = [
            { name: 'Fur_Elise_WoO59_text.pdf', source: 'derivative', size: '1' },
            { name: 'Fur_Elise_WoO59.pdf', source: 'original', size: '427090' },
            { name: 'Fur_Elise_WoO59.djvu', source: 'original', size: '9' },
        ];
        expect(pickIaPdf(files)?.name).toBe('Fur_Elise_WoO59.pdf');
        expect(
            pickIaPdf([
                { name: 'PMLP01607-Beethoven_Symphonie_No9_Op125_Pf4h.pdf', source: 'original', size: '9' },
                { name: 'Haydn_-Trumpet_Concerto_-_Solo_Trumpet_Part_in_Bb.pdf', source: 'original', size: '9' },
                { name: 'Ravel_-_String_Quartet_(Violin_II).pdf', source: 'original', size: '9' },
            ]),
        ).toBeNull();
        expect(
            pickIaPdf([
                { name: 'PMLP02334-FChopin_Polonaise,_Op.53_BH5.pdf', source: 'original', size: '9' },
                { name: 'Mozart - Piano Sonata, K 545.pdf', source: 'original', size: '10' },
            ])?.name,
        ).toBe('Mozart - Piano Sonata, K 545.pdf');
        const item = {
            metadata: {
                identifier: 'imslp-elise-woo-59-beethoven-ludwig-van',
                title: 'Für Elise, WoO 59',
                date: '1867',
                subject: ['For piano'],
            },
        };
        const licences = new Map([
            ['PMLP14377-Fur Elise WoO59.pdf', { licenseLabel: 'Public Domain', restriction: null, euHosted: false }],
        ]);
        const res = iaResolution({ title: FUR_ELISE }, item, files[1]!, licences);
        expect(res).toMatchObject({
            ok: true,
            origin: 'ia',
            filename: 'Fur_Elise_WoO59.pdf',
            pdfUrl: 'https://archive.org/download/imslp-elise-woo-59-beethoven-ludwig-van/Fur_Elise_WoO59.pdf',
            sourceUrl: 'https://archive.org/details/imslp-elise-woo-59-beethoven-ludwig-van',
            licenceTag: 'PD',
            usPd: true,
            pianoSolo: true,
        });
        expect(iaResolution({ title: FUR_ELISE }, item, files[1]!, new Map())).toMatchObject({
            ok: false,
            reason: 'no_licence',
        });
        const flagged = new Map([
            [
                'PMLP14377-Fur Elise WoO59.pdf',
                { licenseLabel: 'Public Domain', restriction: 'Non-PD US', euHosted: false },
            ],
        ]);
        expect(iaResolution({ title: FUR_ELISE }, item, files[1]!, flagged)).toMatchObject({
            ok: false,
            reason: 'not_us_pd',
        });
        const unbound = new Map([
            ['PMLP1-Other.pdf', { licenseLabel: 'Public Domain', restriction: null, euHosted: false }],
        ]);
        expect(
            iaResolution({ title: FUR_ELISE }, { metadata: { ...item.metadata, date: null } }, files[1]!, unbound),
        ).toMatchObject({ ok: false, reason: 'not_us_pd' });
        expect(iaResolution({ title: FUR_ELISE }, item, files[1]!, unbound)).toMatchObject({
            ok: true,
            licenceTag: 'PD',
        });
    });
});

describe('ranking', () => {
    const popular = [
        { title: MOONLIGHT, composer: 'Beethoven', instrument: 'piano' },
        { title: FUR_ELISE, composer: 'Beethoven', instrument: 'piano' },
        { title: 'Nocturnes, Op.9 (Chopin, Frédéric)', composer: 'Chopin', instrument: 'piano' },
    ];
    const catalog = [
        {
            page_title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            categories: ['For piano'],
            touched: '2026-01-01T00:00:00Z',
        },
        {
            page_title: 'Ballade No.4, Op.52 (Chopin, Frédéric)',
            composer: 'Chopin, Frédéric',
            categories: ['For piano'],
            touched: '2025-01-01T00:00:00Z',
        },
        {
            page_title: 'Piano Sonata No.4, Op.7 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            categories: ['For piano'],
            touched: '2020-01-01T00:00:00Z',
        },
        {
            page_title: 'Piano Sonata No.5, Op.10 No.1 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            categories: ['For piano'],
            touched: '2024-01-01T00:00:00Z',
        },
        {
            page_title: 'Symphony No.5, Op.67 (Beethoven, Ludwig van)',
            composer: 'Beethoven, Ludwig van',
            categories: ['For orchestra'],
            touched: '2026-01-01T00:00:00Z',
        },
        {
            page_title: 'Sonatina (Nobody, Anon)',
            composer: 'Nobody, Anon',
            categories: ['For piano'],
            touched: '2026-01-01T00:00:00Z',
        },
        {
            page_title: 'Étude, Op.1 (Scriabin, Aleksandr)',
            composer: 'Scriabin, Aleksandr',
            categories: ['For piano'],
            touched: '2026-01-01T00:00:00Z',
        },
    ];

    it('cold start: popular order, then For piano by canonical composer (popular composer order, touched desc)', () => {
        const ranked = rankWorks({ popular, catalog });
        expect(ranked.map((w) => w.title)).toEqual([
            MOONLIGHT,
            FUR_ELISE,
            'Nocturnes, Op.9 (Chopin, Frédéric)',
            'Piano Sonata No.5, Op.10 No.1 (Beethoven, Ludwig van)',
            'Piano Sonata No.4, Op.7 (Beethoven, Ludwig van)',
            'Ballade No.4, Op.52 (Chopin, Frédéric)',
            'Étude, Op.1 (Scriabin, Aleksandr)',
        ]);
        expect(ranked[0]).toMatchObject({ tier: 0, prior: 3 });
        expect(ranked[3]).toMatchObject({ tier: 1, prior: 0 });
    });

    it('pins join tier 0 after the popular list, once', () => {
        const ranked = rankWorks({
            popular,
            pins: [{ title: 'Preludes, Op.28 (Chopin, Frédéric)' }, { title: FUR_ELISE }],
        });
        expect(ranked.map((w) => w.title)).toEqual([
            MOONLIGHT,
            FUR_ELISE,
            'Nocturnes, Op.9 (Chopin, Frédéric)',
            'Preludes, Op.28 (Chopin, Frédéric)',
        ]);
        expect(ranked[3]).toMatchObject({ tier: 0, pin: true });
        expect(ranked[1]!.pin).toBeUndefined();
    });

    it('re-rank: 1000·downloads + 100·use + prior, and unseen demanded titles jump the queue', () => {
        const demand = new Map([
            ['Ballade No.4, Op.52 (Chopin, Frédéric)', 2],
            ['Waltzes, Op.64 (Chopin, Frédéric)', 1],
        ]);
        const corpusUse = new Map([[FUR_ELISE, 5]]);
        const ranked = rankWorks({ popular, catalog, demand, corpusUse });
        expect(ranked.slice(0, 4).map((w) => [w.title, w.score])).toEqual([
            ['Ballade No.4, Op.52 (Chopin, Frédéric)', 2000],
            ['Waltzes, Op.64 (Chopin, Frédéric)', 1000],
            [FUR_ELISE, 502],
            [MOONLIGHT, 3],
        ]);
        expect(ranked.find((w) => w.title === 'Waltzes, Op.64 (Chopin, Frédéric)')).toMatchObject({ tier: 1 });
    });

    it('counts IMSLP-import titles only (uploads carry a file name, not a composer suffix)', () => {
        const demand = demandFromDocumentTitles([FUR_ELISE, FUR_ELISE, 'my-scan.pdf', MOONLIGHT, null]);
        expect([...demand.entries()]).toEqual([
            [FUR_ELISE, 2],
            [MOONLIGHT, 1],
        ]);
    });
});

describe('ledger', () => {
    it('allows only the resumable transitions', () => {
        expect(canTransition('pending', 'fetched')).toBe(true);
        expect(canTransition('fetched', 'queued')).toBe(true);
        expect(canTransition('queued', 'ready')).toBe(true);
        expect(canTransition('queued', 'failed')).toBe(true);
        expect(canTransition('failed', 'pending')).toBe(true);
        expect(canTransition('skipped', 'pending')).toBe(true);
        expect(canTransition('ready', 'pending')).toBe(false);
        expect(canTransition('pending', 'ready')).toBe(false);
        expect(canTransition('pending', 'paused')).toBe(true);
        expect(canTransition('paused', 'fetched')).toBe(true);
        for (const status of LEDGER_STATUSES) {
            expect(canTransition(status, 'ready')).toBe(status === 'queued');
        }
    });

    it('decides what a rerun touches: ready never, skipped only on request, failed until attempts run out', () => {
        expect(shouldProcess({ status: 'ready' })).toEqual({ process: false, reason: 'already_ready' });
        expect(shouldProcess({ status: 'queued' })).toEqual({ process: false, reason: 'in_flight' });
        expect(shouldProcess({ status: 'pending' })).toEqual({ process: true, reason: 'resume' });
        expect(shouldProcess({ status: 'fetched' })).toEqual({ process: true, reason: 'resume' });
        expect(shouldProcess({ status: 'paused' })).toEqual({ process: true, reason: 'resume' });
        expect(shouldProcess({ status: 'failed', attempts: 1 })).toEqual({ process: true, reason: 'retry' });
        expect(shouldProcess({ status: 'failed', attempts: MAX_ATTEMPTS })).toEqual({
            process: false,
            reason: 'attempts_exhausted',
        });
        expect(shouldProcess({ status: 'skipped', attempts: 1 })).toEqual({ process: false, reason: 'skipped' });
        expect(shouldProcess({ status: 'skipped', attempts: 1 }, { retrySkipped: true })).toEqual({
            process: true,
            reason: 'retry_skipped',
        });
    });

    it('reconciles queued rows from the job / analysis outcome', () => {
        expect(reconcileQueued({ status: 'succeeded' }, { status: 'ready' })).toEqual({ status: 'ready', error: null });
        expect(
            reconcileQueued({ status: 'dead', last_error: 'omr_timeout' }, { status: 'failed', error: 'omr_timeout' }),
        ).toEqual({ status: 'failed', error: 'omr_timeout' });
        expect(reconcileQueued({ status: 'failed_permanent', last_error: 'no_staves_found' }, null)).toEqual({
            status: 'failed',
            error: 'no_staves_found',
        });
        expect(reconcileQueued({ status: 'queued' }, { status: 'pending' })).toBeNull();
        expect(reconcileQueued({ status: 'queued' }, { status: 'failed', error: 'worker_lost' })).toBeNull();
        expect(reconcileQueued(null, { status: 'failed', error: 'x' })).toEqual({ status: 'failed', error: 'x' });
    });

    it('floors --limit on distinct works at or past queued', () => {
        expect(
            coveredWorkCount([
                { work_title: 'a', status: 'queued' },
                { work_title: 'a', status: 'ready' },
                { work_title: 'b', status: 'fetched' },
                { work_title: 'c', status: 'skipped' },
                { work_title: 'd', status: 'failed' },
            ]),
        ).toBe(2);
    });
});

describe('planning', () => {
    const ok = (origin: string, filename: string, pianoSolo = true) => ({
        ok: true,
        origin,
        filename,
        pianoSolo,
        workTitle: 'w',
    });
    const skip = (origin: string, reason: string) => ({ ok: false, origin, filename: `${origin}.pdf`, reason });

    it('takes the first origin in Mutopia → OpenScore → IA order that has an accepted file', () => {
        const plan = planWork([
            skip('mutopia', 'non_commercial'),
            ok('ia', 'scan.pdf', false),
            ok('openscore', 'sq1.pdf', false),
        ]);
        expect(plan.origin).toBe('openscore');
        expect(plan.queue.map((r) => r.filename)).toEqual(['sq1.pdf']);
        expect(plan.skips).toEqual([skip('mutopia', 'non_commercial')]);
    });

    it('honours --source, orders piano-solo pieces first, and caps files per work', () => {
        const many = Array.from({ length: MAX_FILES_PER_WORK + 5 }, (_, i) =>
            ok('mutopia', `p${String(i).padStart(2, '0')}.pdf`, i % 2 === 0),
        );
        const plan = planWork([...many, ok('ia', 'scan.pdf')], { sources: ['mutopia'] });
        expect(plan.origin).toBe('mutopia');
        expect(plan.queue).toHaveLength(MAX_FILES_PER_WORK);
        expect(plan.queue.slice(0, 3).every((r) => r.pianoSolo)).toBe(true);
        expect(planWork([ok('mutopia', 'a.pdf')], { sources: ['ia'] })).toEqual({ queue: [], skips: [], origin: null });
        expect(parseSources('ia,mutopia')).toEqual(['mutopia', 'ia']);
        expect(parseSources('all')).toEqual(['mutopia', 'openscore', 'ia']);
        expect(() => parseSources('imslp')).toThrow(/--source/);
    });

    it('summarises coverage by origin and formats the progress line', () => {
        const plans = new Map([
            ['a', { origin: 'mutopia' }],
            ['b', { origin: 'ia' }],
            ['c', { origin: null }],
        ]);
        expect(coverageByOrigin(plans, ['a', 'b', 'c', 'd'])).toEqual({
            mutopia: 1,
            openscore: 0,
            ia: 1,
            none: 2,
            total: 4,
        });
        expect(
            JSON.parse(
                progressEvent({
                    ready: 1,
                    queued: 2,
                    skipped: 3,
                    failed: 4,
                    target: 131,
                    batchId: 7,
                    mode: 'fetch',
                    eta_s: 9,
                }),
            ),
        ).toEqual({
            event: 'corpus_seed',
            ready: 1,
            queued: 2,
            fetched: 0,
            skipped: 3,
            failed: 4,
            target: 131,
            batch_id: 7,
            mode: 'fetch',
            eta_s: 9,
        });
        expect(backoffDelayMs(1)).toBe(1000);
        expect(backoffDelayMs(3)).toBe(4000);
        expect(backoffDelayMs(20)).toBe(60_000);
    });
});
