import { describe, expect, it } from 'vitest';

import {
    STOP_TOKENS,
    buildSearchVariants,
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
