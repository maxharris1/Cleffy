import { describe, expect, it } from 'vitest';

import { composerSurnameOf, DEFAULT_ERA, eraOfTitle } from './era.js';

describe('composerSurnameOf', () => {
    it('reads the surname from an IMSLP-style "(Last, First)" suffix', () => {
        expect(composerSurnameOf('Nocturnes, Op.9 (Chopin, Frédéric)')).toBe('Chopin');
        expect(composerSurnameOf('Für Elise (Beethoven, Ludwig van)  ')).toBe('Beethoven');
    });

    it('takes a bare surname in parentheses', () => {
        expect(composerSurnameOf('Gymnopédies (Satie)')).toBe('Satie');
    });

    it('is null without the suffix', () => {
        expect(composerSurnameOf('My Recital Piece')).toBeNull();
        expect(composerSurnameOf('Sonata (in C major) for piano')).toBeNull();
        expect(composerSurnameOf('()')).toBeNull();
    });
});

describe('eraOfTitle', () => {
    it('maps known composers to their era', () => {
        expect(eraOfTitle('Inventions (Bach, Johann Sebastian)')).toBe('baroque');
        expect(eraOfTitle('Sonata K.545 (Mozart, Wolfgang Amadeus)')).toBe('classical');
        expect(eraOfTitle('Nocturnes, Op.9 (Chopin, Frédéric)')).toBe('romantic');
        expect(eraOfTitle('Clair de lune (Debussy, Claude)')).toBe('modern');
    });

    it('ignores case and accents', () => {
        expect(eraOfTitle('Slavonic Dances (DVORAK, Antonin)')).toBe('romantic');
        expect(eraOfTitle('Romanian Folk Dances (Bartok, Bela)')).toBe('modern');
    });

    it('falls back to Classical for unknown or missing composers', () => {
        expect(DEFAULT_ERA).toBe('classical');
        expect(eraOfTitle('Piano Piece (Nobody, Anyone)')).toBe('classical');
        expect(eraOfTitle('scan.pdf')).toBe('classical');
        expect(eraOfTitle(null)).toBe('classical');
        expect(eraOfTitle(undefined)).toBe('classical');
    });
});
