import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileCreditsFor } from '../../supabase/functions/_shared/imslpFileBlocks';
import {
    buildImslpProvenance,
    composerFromWorkTitle,
    imslpWorkPageUrl,
} from '../../supabase/functions/_shared/imslpProvenance';

const moonlight = readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures/moonlight-worktext.wikitext'), 'utf8');
const WORK = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';

describe('fileCreditsFor', () => {
    it('names the editor of a Creative Commons typeset and its plain-text publisher line', () => {
        expect(fileCreditsFor(moonlight, 'PMLP1458-Beethoven_Klavier-Mondscheinsonate-Op27Nr2.pdf')).toEqual({
            editor: 'Viktor Keil',
            arranger: null,
            publisher: 'Viktor Keil, 2024',
            year: null,
        });
    });

    it('joins several LinkEd editors and reads the {{P}} publisher', () => {
        const credits = fileCreditsFor(moonlight, 'Beethoven - Op.27 No.2 - Cappi - Score.pdf');
        // {{FE}} ("first edition") is not a person.
        expect(credits).toEqual({ editor: null, arranger: null, publisher: 'Diabelli', year: 1802 });
    });

    it('credits an arranger', () => {
        expect(fileCreditsFor(moonlight, 'PMLP1458-moonlight-guitar-duo-a4.pdf')).toMatchObject({
            arranger: 'J. J. Olson',
            publisher: 'Mutopia, 2016',
        });
    });

    it('matches the space/underscore spellings and returns null for an unknown file', () => {
        expect(fileCreditsFor(moonlight, 'pMLP1458-Beethoven Klavier-Mondscheinsonate-Op27Nr2.pdf')?.editor).toBe(
            'Viktor Keil',
        );
        expect(fileCreditsFor(moonlight, 'not-on-this-page.pdf')).toBeNull();
    });

    it('lists multiple editors in order', () => {
        const wikitext = `{{#fte:imslpfile
|File Name 1=Lebert.pdf
|Editor={{LinkEd|Sigmund|Lebert|1822|1884}}<br>{{LinkEd|Hans von|Bülow|1830|1894}}
|Publisher Information={{P|Cotta|J.G. Cotta|Stuttgart|n.d.[1871]|1871||}}
|Copyright=Public Domain
}}`;
        expect(fileCreditsFor(wikitext, 'Lebert.pdf')).toEqual({
            editor: 'Sigmund Lebert, Hans von Bülow',
            arranger: null,
            publisher: 'Cotta',
            year: 1871,
        });
    });
});

describe('buildImslpProvenance', () => {
    it('records the work page, file, license and credits', () => {
        expect(
            buildImslpProvenance({
                workTitle: WORK,
                filename: 'PMLP1458-Beethoven Klavier-Mondscheinsonate-Op27Nr2.pdf',
                licenseLabel: 'Creative Commons Attribution-ShareAlike 4.0',
                credits: { editor: 'Viktor Keil', arranger: null, publisher: 'Viktor Keil, 2024', year: null },
            }),
        ).toEqual({
            source_url: 'https://imslp.org/wiki/Piano_Sonata_No.14%2C_Op.27_No.2_(Beethoven%2C_Ludwig_van)',
            source_filename: 'PMLP1458-Beethoven Klavier-Mondscheinsonate-Op27Nr2.pdf',
            source_license: 'Creative Commons Attribution-ShareAlike 4.0',
            source_attribution: {
                source: 'imslp',
                work: WORK,
                composer: 'Beethoven, Ludwig van',
                editor: 'Viktor Keil',
                arranger: null,
                publisher: 'Viktor Keil, 2024',
                year: null,
            },
        });
    });

    it('still records composer and license when the credits lookup failed', () => {
        const provenance = buildImslpProvenance({
            workTitle: WORK,
            filename: 'a.pdf',
            licenseLabel: 'Public Domain',
            credits: null,
        });
        expect(provenance.source_attribution).toMatchObject({ composer: 'Beethoven, Ludwig van', editor: null });
        expect(provenance.source_license).toBe('Public Domain');
    });

    it('clips oversized values and drops an implausible year', () => {
        const provenance = buildImslpProvenance({
            workTitle: WORK,
            filename: 'a.pdf',
            licenseLabel: 'x'.repeat(500),
            credits: { editor: 'y'.repeat(500), arranger: null, publisher: null, year: 99999 },
        });
        expect(provenance.source_license).toHaveLength(200);
        expect(provenance.source_attribution.editor).toHaveLength(200);
        expect(provenance.source_attribution.year).toBeNull();
    });

    it('builds the same work URL as the edge functions and an https URL the column accepts', () => {
        expect(imslpWorkPageUrl('Für Elise, WoO 59 (Beethoven, Ludwig van)')).toBe(
            'https://imslp.org/wiki/F%C3%BCr_Elise%2C_WoO_59_(Beethoven%2C_Ludwig_van)',
        );
        expect(composerFromWorkTitle('Untitled')).toBeNull();
    });
});
