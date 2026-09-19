import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileBlockKey, parseImslpFileBlocks } from '../../supabase/functions/_shared/imslpFileBlocks';

const fixture = (name: string): string => readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures', name), 'utf8');

describe('fileBlockKey', () => {
    it('matches prop=images titles against underscore File Name values', () => {
        expect(fileBlockKey('PMLP01458-beethoven_piano-sonata_henle.pdf')).toBe(
            'PMLP01458-beethoven piano-sonata henle.pdf',
        );
        expect(fileBlockKey('beethoven  -  Cappi.pdf')).toBe('Beethoven - Cappi.pdf');
    });
});

describe('parseImslpFileBlocks', () => {
    // Trimmed from the real Moonlight Sonata wikitext (saved 2026-09-19).
    const meta = parseImslpFileBlocks(fixture('moonlight-worktext.wikitext'));

    it('flags both Henle files as Urtext with house and year', () => {
        const bandII = meta.get('PMLP01458-beethoven piano-sonata-op27-no2 henle-pp17-30.pdf');
        expect(bandII).toEqual({
            publisher: 'G. Henle Verlag',
            year: 1976,
            plate: null,
            urtext: true,
            arrangement: false,
            description: 'Complete Score',
        });

        // Filename says nothing about Henle — only the wikitext does. The
        // uploader put HN1032 in the edition-number slot, so no plate here.
        const bandI = meta.get('PMLP01458-E621557 247-260-beethoven--sonatas-vol1.pdf');
        expect(bandI).toEqual({
            publisher: 'G. Henle Verlag',
            year: 1976,
            plate: null,
            urtext: true,
            arrangement: false,
            description: 'Complete Score',
        });
    });

    it('does not mistake the Leo Weiner / EMB "wiener" typeset for Wiener Urtext', () => {
        const weiner = meta.get('PMLP1458-Beethoven.op27no2.sonata.no14.moonlight.wiener.pdf');
        expect(weiner).toEqual({
            publisher: 'Editio Musica Budapest',
            year: 1959,
            plate: 'Z. 2347',
            urtext: false,
            arrangement: false,
            description: 'Complete Score',
        });
    });

    it('reads the official publisher name over the imprint and the n.d.[year] date form', () => {
        expect(meta.get('Beethoven - Op.27 No.2 - Cappi - Score.pdf')).toEqual({
            publisher: 'Diabelli',
            year: 1802,
            plate: '879',
            urtext: false,
            arrangement: false,
            description: 'Complete Score',
        });
        const schirmer = meta.get('PMLP1458-Sonata No. 14.pdf');
        expect(schirmer?.publisher).toBe('Schirmer');
        expect(schirmer?.year).toBe(1895);
        expect(schirmer?.urtext).toBe(false);
        expect(meta.get('PMLP01458-Beethoven Sonaten Piano Band1 Peters 9452 14 Op27 No2 1200dpi.pdf')).toEqual({
            publisher: 'Edition Peters',
            year: 1910,
            plate: '9452',
            urtext: false,
            arrangement: false,
            description: 'Complete Score',
        });
    });

    it('maps every file of a multi-file block and keeps per-file descriptions', () => {
        const gesamt = meta.get(
            'PMLP01458-Beethoven, Ludwig van-Werke Breitkopf Kalmus Band 21 B137 Op 27 No 2 scan.pdf',
        );
        expect(gesamt).toEqual({
            publisher: null,
            year: null,
            plate: null,
            urtext: false,
            arrangement: false,
            description: 'Complete Score',
        });
        expect(
            meta.get("PMLP1458-Beethoven, L. van - 14. Sonata for Piano in C- minor, Op. 27.2 'Moonlight'.pdf"),
        ).toEqual(gesamt);

        // Both guitar files say "Complete Score" — only the Arranger field reveals the arrangement.
        const guitar = meta.get('PMLP1458-moonlight-guitar-duo.pdf');
        expect(guitar?.description).toBe('Complete Score');
        expect(guitar?.arrangement).toBe(true);
        expect(meta.get('PMLP1458-moonlight-guitar-duo-a4.pdf')).toEqual({
            ...guitar,
            description: 'Complete Score (a4)',
        });
    });

    it('leaves plain-text publisher lines without a {{P}} template unpublished', () => {
        expect(meta.get('PMLP1458-Beethoven Klavier-Mondscheinsonate-Op27Nr2.pdf')).toEqual({
            publisher: null,
            year: null,
            plate: null,
            urtext: false,
            arrangement: false,
            description: 'Complete Score',
        });
    });

    it('ignores audio blocks and returns nothing for empty or unrelated wikitext', () => {
        for (const key of meta.keys()) {
            expect(key.toLowerCase().endsWith('.mp3')).toBe(false);
        }
        expect(parseImslpFileBlocks('').size).toBe(0);
        expect(parseImslpFileBlocks('{{#fte:imslppage\n|Work Title=Nothing\n}}').size).toBe(0);
    });

    it('prefers a per-file Publisher Information N over the shared block line', () => {
        const wikitext = [
            '{{#fte:imslpfile',
            '|File Name 1=a.pdf',
            '|File Name 2=b.pdf',
            '|File Description 1=Complete Score',
            '|File Description 2=Parts',
            '|Publisher Information={{P|Bärenreiter||Kassel||1980||BA 4001}} {{Urtext}}',
            '|Publisher Information 2={{P|Edition Peters||Leipzig||1920||}}',
            '|Copyright=Public Domain',
            '}}',
        ].join('\n');
        const parsed = parseImslpFileBlocks(wikitext);
        expect(parsed.get('A.pdf')).toEqual({
            publisher: 'Bärenreiter',
            year: 1980,
            plate: 'BA 4001',
            urtext: true,
            arrangement: false,
            description: 'Complete Score',
        });
        expect(parsed.get('B.pdf')).toEqual({
            publisher: 'Edition Peters',
            year: 1920,
            plate: null,
            urtext: false,
            arrangement: false,
            description: 'Parts',
        });
    });
});
