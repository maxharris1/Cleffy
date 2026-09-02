import { describe, expect, it } from 'vitest';

import {
    STOP_TOKENS,
    buildSearchVariants,
    cleanSnippet,
    correctTokens,
    damerauLevenshtein,
    extractPeriod,
    foldAccents,
    isWorkTitle,
    nearMatch,
    normalizeQuery,
    scoreTitleMatch,
    tokenizeQuery,
} from '../../supabase/functions/_shared/search';
import { facetTokens } from '../../supabase/functions/_shared/searchFacetData';

describe('foldAccents', () => {
    it('strips combining accents', () => {
        expect(foldAccents('Dvořák')).toBe('dvorak');
        expect(foldAccents('Frédéric')).toBe('frederic');
    });

    it('folds non-decomposable letters NFD cannot strip', () => {
        expect(foldAccents('Lutosławski')).toBe('lutoslawski');
        expect(foldAccents('Strauß')).toBe('strauss');
        expect(foldAccents('Ørsted')).toBe('orsted');
    });

    it('folds accidentals to spelled-out forms so E♭ matches E-flat titles', () => {
        expect(foldAccents('E♭ major')).toBe('e-flat major');
        expect(foldAccents('C♯ minor')).toBe('c-sharp minor');
    });
});

describe('normalizeQuery', () => {
    it('canonicalizes opus and number spellings', () => {
        expect(normalizeQuery('Opus 27 No 2')).toBe('op.27 no.2');
        expect(normalizeQuery('op. 27 no. 2')).toBe('op.27 no.2');
        expect(normalizeQuery('Op 106')).toBe('op.106');
    });

    it('leaves ordinary words alone', () => {
        expect(normalizeQuery('nocturne')).toBe('nocturne');
        expect(normalizeQuery('north wind')).toBe('north wind');
    });

    it('canonicalizes catalog numbers', () => {
        expect(normalizeQuery('BWV 565')).toBe('bwv.565');
        expect(normalizeQuery('K 545')).toBe('k.545');
        expect(normalizeQuery('D 960')).toBe('d.960');
    });

    it('maps alternate composer transliterations to IMSLP spellings', () => {
        expect(normalizeQuery('Rachmaninov concerto')).toBe('rachmaninoff concerto');
        expect(normalizeQuery('Tschaikowsky')).toBe('tchaikovsky');
    });
});

describe('tokenizeQuery', () => {
    it('keeps opus/number units atomic', () => {
        expect(tokenizeQuery('Op.27 No.2')).toEqual(['op.27', 'no.2']);
        expect(tokenizeQuery('Beethoven Op 27 no 2')).toEqual(['beethoven', 'op.27', 'no.2']);
    });

    it('splits on separators but not dots inside units', () => {
        expect(tokenizeQuery('K.331/300i')).toEqual(['k.331', '300i']);
    });

    it('keeps stop tokens out of the meaningful set via STOP_TOKENS', () => {
        expect(STOP_TOKENS.has('op')).toBe(true);
        expect(STOP_TOKENS.has('the')).toBe(true);
        expect(STOP_TOKENS.has('sonata')).toBe(false);
    });
});

describe('damerauLevenshtein / nearMatch', () => {
    it('measures deletions and transpositions as one edit', () => {
        expect(damerauLevenshtein('beethovn', 'beethoven')).toBe(1);
        expect(damerauLevenshtein('beehtoven', 'beethoven')).toBe(1);
    });

    it('caps at max+1 for early exit', () => {
        expect(damerauLevenshtein('completely', 'different', 2)).toBe(3);
    });

    it('nearMatch is tiered by length and never true for exact strings', () => {
        expect(nearMatch('beethovn', 'beethoven')).toBe(true);
        expect(nearMatch('chopn', 'chopin')).toBe(true);
        expect(nearMatch('sonata', 'sonata')).toBe(false);
        // Short words don't fuzz — "bach" must not match "bath".
        expect(nearMatch('bach', 'bath')).toBe(false);
        // Phonetic respellings beyond 2 edits are the alias table's job.
        expect(nearMatch('moonlite', 'moonlight')).toBe(false);
    });
});

describe('correctTokens', () => {
    const vocab = ['beethoven', 'moonlight', 'sonata', 'chopin'];

    it('fixes near-miss tokens against the vocabulary', () => {
        expect(correctTokens(['beethovn', 'sonata'], vocab)).toEqual(['beethoven', 'sonata']);
        expect(correctTokens(['chopn'], vocab)).toEqual(['chopin']);
    });

    it('returns null when nothing changed', () => {
        expect(correctTokens(['moonlight', 'sonata'], vocab)).toBeNull();
        expect(correctTokens(['xyzzyplugh'], vocab)).toBeNull();
    });
});

describe('isWorkTitle', () => {
    it('accepts titles with a composer parenthetical', () => {
        expect(isWorkTitle('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)')).toBe(true);
    });

    it('drops list/wishlist/publisher noise pages', () => {
        expect(isWorkTitle('List of works by Ludwig van Beethoven')).toBe(false);
        expect(isWorkTitle('Wishlist A-B')).toBe(false);
        expect(isWorkTitle('Carl Fischer')).toBe(false);
    });
});

describe('buildSearchVariants', () => {
    it('emits full query first at weight 1 and caps at 6', () => {
        const variants = buildSearchVariants('beethoven moonlight sonata op 27');
        expect(variants[0]).toEqual({ q: 'beethoven moonlight sonata op 27', weight: 1 });
        expect(variants.length).toBeLessThanOrEqual(6);
    });

    it('includes every matching alias title, not just the first', () => {
        const variants = buildSearchVariants('moonlight or pathetique', {
            aliasTitles: [
                'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
                'Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)',
            ],
        });
        const qs = variants.map((v) => v.q);
        expect(qs).toContain('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)');
        expect(qs).toContain('Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)');
    });

    it('does not emit lone-token variants for 3+-token queries', () => {
        const variants = buildSearchVariants('beethoven moonlight sonata');
        const singles = variants.filter((v) => !v.q.includes(' '));
        expect(singles).toEqual([]);
    });

    it('emits low-weight lone tokens for 2-token queries', () => {
        const variants = buildSearchVariants('beethoven tempest');
        const single = variants.find((v) => v.q === 'tempest');
        expect(single?.weight).toBe(0.3);
    });

    it('adds a facet-scoped variant at weight 0.8', () => {
        const variants = buildSearchVariants('nocturne', { facetTokens: ['piano'] });
        expect(variants.find((v) => v.q === 'piano nocturne')?.weight).toBe(0.8);
    });

    it('does not inject era surnames into search variants', () => {
        const tokens = facetTokens({ eras: ['baroque'] });
        const variants = buildSearchVariants('sonata', { facetTokens: tokens });
        const blob = variants.map((v) => v.q).join(' ');
        expect(blob).not.toMatch(/bach|vivaldi|handel/i);
    });
});

describe('extractPeriod', () => {
    it('maps a composition year to an era and strips it from rest', () => {
        expect(extractPeriod('chopin nocturne 1831')).toEqual({
            eraIds: ['romantic'],
            rest: 'chopin nocturne',
        });
    });

    it('maps period words and leaves the rest of the query', () => {
        expect(extractPeriod('baroque fugue')).toEqual({
            eraIds: ['baroque'],
            rest: 'fugue',
        });
    });

    it('does not treat classical as a period when followed by guitar', () => {
        expect(extractPeriod('classical guitar')).toEqual({
            eraIds: [],
            rest: 'classical guitar',
        });
    });

    it('maps decades onto the early-20th bin', () => {
        expect(extractPeriod('1920s piano')).toEqual({
            eraIds: ['early-20th'],
            rest: 'piano',
        });
    });
});

describe('scoreTitleMatch', () => {
    const moonlight = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';

    it('gives unit tokens a stronger bonus than plain words', () => {
        const withUnit = scoreTitleMatch(moonlight, ['op.27']);
        const withWord = scoreTitleMatch(moonlight, ['piano']);
        expect(withUnit).toBeGreaterThan(withWord);
    });

    it('does not award the all-tokens bonus for stop tokens alone', () => {
        // "op" and "no" are substrings of almost every IMSLP title.
        expect(scoreTitleMatch('Nocturnes, Op.9 (Chopin, Frédéric)', ['op', 'no'])).toBe(0);
    });

    it('scores near-miss tokens via edit distance', () => {
        expect(scoreTitleMatch(moonlight, ['beethovn'])).toBeGreaterThan(0);
    });

    it('matches space-form catalog numbers — IMSLP dots K./D. but spaces BWV/WoO/RV', () => {
        const tokens = tokenizeQuery('Bach BWV 565');
        expect(tokens).toEqual(['bach', 'bwv.565']);
        expect(scoreTitleMatch('Toccata and Fugue in D minor, BWV 565 (Bach, Johann Sebastian)', tokens)).toBeGreaterThan(
            scoreTitleMatch('Cello Suite No.1 in G major, BWV 1007 (Bach, Johann Sebastian)', tokens),
        );
        expect(scoreTitleMatch('Für Elise, WoO 59 (Beethoven, Ludwig van)', tokenizeQuery('WoO 59'))).toBeGreaterThan(0);
    });

    it('never space-forms "no.N" — it hides inside "piano 4 hands"-style titles', () => {
        const tokens = tokenizeQuery('sonata no 4');
        expect(tokens).toEqual(['sonata', 'no.4']);
        expect(scoreTitleMatch('Piano Sonata No.4, Op.7 (Beethoven, Ludwig van)', tokens)).toBeGreaterThan(
            scoreTitleMatch('Sonata for Piano 4 hands (Diabelli, Anton)', tokens),
        );
    });

    it('matches accent-folded non-decomposable letters', () => {
        expect(scoreTitleMatch('Symphony No.3 (Lutosławski, Witold)', ['lutoslawski'])).toBeGreaterThan(0);
    });
});

describe('cleanSnippet', () => {
    // Fixtures are verbatim srwhat=text snippets captured from imslp.org for "moonlight".
    it('drops file names, thumbnails and the uploader line', () => {
        expect(
            cleanSnippet(
                '|File Name 1=PMLP1458-01.01._Sonata_No._14_In_C-Sharp_Minor,_Op._27,_No._2_(&quot;<span class="searchmatch">Moonlight</span>&quot;)-_I_-_Adagio_Sostenuto.mp3\n...ilename=TN-PMLP1458-01.01._Sonata_No._14-7939.png\n',
            ),
        ).toBe('');
        expect(cleanSnippet('|Uploader=[[User:Mr. Moonlight|Mr. Moonlight]]\n')).toBe('');
        expect(cleanSnippet('#REDIRECT [[Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)]]')).toBe('');
    });

    it('reduces templates and links to their labels and drops a bare "Source:"', () => {
        expect(
            cleanSnippet(
                '|Misc. Notes=Source: {{plain|https://archive.org/details/lp_three-favorite-sonatas|Internet Archive}}\n',
            ),
        ).toBe('Source: Internet Archive');
        expect(cleanSnippet('|Misc. Notes=Source: {{plain|https://archive.org/details/x}}\n')).toBe('');
        // A field name cut mid-word by the snippet window is unknown plumbing, not prose.
        expect(cleanSnippet('...otes=Source: {{plain|https://archive.org/details/x|Internet Archive}}\n')).toBe('');
        expect(
            cleanSnippet(
                '|Work Title=Ludwig van Beethovens Werke\n|External Links=[[wikipedia:Beethoven Gesamtausgabe|Wikipedia article]]\n',
            ),
        ).toBe('Ludwig van Beethovens Werke');
    });

    it('keeps movement lists and human fields as prose, with entities decoded', () => {
        expect(
            cleanSnippet(
                '# Mondnacht am Seegestade ; Clair de lune au bord de la mer ; Moonlight on the Lake-Shore. Andante placido ({{K|Ab}}) \n',
            ),
        ).toBe(
            'Mondnacht am Seegestade ; Clair de lune au bord de la mer ; Moonlight on the Lake-Shore. Andante placido (Ab)',
        );
        expect(cleanSnippet('# Nocturne &quot;Moonlight&quot; (Ноктюрн «Лунный свет»)\n')).toBe(
            'Nocturne "Moonlight" (Ноктюрн «Лунный свет»)',
        );
        expect(cleanSnippet(':5. Boro Budur in Moonlight\n**Nocturne: &quot;The Moonlight&quot;\n')).toBe(
            '5. Boro Budur in Moonlight · Nocturne: "The Moonlight"',
        );
        expect(cleanSnippet('|Work Title=Water in the Moonlight\n|Alternative Title=\n')).toBe(
            'Water in the Moonlight',
        );
    });

    it('drops discography slugs, cut templates and escaped <br>, and reads [url label] links', () => {
        // Verbatim shapes from "chopin nocturne": a Discography field cut by the window.
        expect(
            cleanSnippet(
                '...rne-for-piano-no-11-in-g-minor-op-37-1-ct-118-mc0002468657|No.1}}&lt;br&gt;{{AMG|nocturne-for-piano-no-12-in-g-major-op-37-2-ct-119-mc0002429720|No.2}}&lt;br&gt;{{AMG|noct\n',
            ),
        ).toBe('');
        expect(
            cleanSnippet(
                '...cturne_in_C_minor,_Op._posth._(Chopin)&lt;br&gt;136&lt;br&gt;nocturne-for-piano-in-c-minor-kk-ivb-8\n',
            ),
        ).toBe('');
        expect(
            cleanSnippet(
                '|Misc. Notes=Manuscript description given here @ [https://en.chopin.nifc.pl/chopin/manuscripts/detail/id/98 Chopin Society].\n',
            ),
        ).toBe('Manuscript description given here @ Chopin Society.');
        expect(cleanSnippet('...{{plain|https://archive.org/details/x|Internet Archive}}\n')).toBe('');
        // Verbatim: the window cut "Source:" off, and searchmatch spans sit inside the URL.
        expect(
            cleanSnippet(
                "...: {{plain|https://archive.org/details/lp_nocturnes_frdric-<span class='searchmatch'>chopin</span>-eugene-istomin|Internet Archive}}\n|File Name 1=<span class='searchmatch'>Chopin</span> - 2 Nocturnes, Op 27.pdf\n",
            ),
        ).toBe('');
        expect(
            cleanSnippet(
                "|Misc. Notes=Manuscript given here @ [https://en.<span class='searchmatch'>chopin</span>.nifc.pl/<span class='searchmatch'>chopin</span>/manuscripts/detail/id/98 Chopin Society].\n",
            ),
        ).toBe('Manuscript given here @ Chopin Society.');
        expect(
            cleanSnippet(
                "|Publisher Information=''Guiomar Novaes: <span class='searchmatch'>Chopin</span>: Nocturnes'' - {{RC||Vox|New York||1956||PL 963\n|Misc. Notes=File split by the uploader from &quot;<span class='searchmatch'>Nocturne</span>-Waltz-Scherzo&quot;\n",
            ),
        ).toBe('File split by the uploader from "Nocturne-Waltz-Scherzo"');
    });

    it('caps length and handles empty input', () => {
        expect(cleanSnippet(undefined)).toBe('');
        expect(cleanSnippet('')).toBe('');
        const long = Array.from({ length: 20 }, (_, i) => `# Movement number ${i} with a long descriptive title`).join(
            '\n',
        );
        const out = cleanSnippet(long);
        expect(out.length).toBeLessThanOrEqual(200);
        expect(out.endsWith('…')).toBe(true);
    });
});
