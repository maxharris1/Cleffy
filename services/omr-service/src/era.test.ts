import { readFileSync } from 'node:fs';

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

describe('era mapping lockstep', () => {
    it('keeps the client and edge-function copies on the same surnames', () => {
        const here = readFileSync(new URL('./era.ts', import.meta.url), 'utf8');
        const client = readFileSync(new URL('../../../src/features/playback/era.ts', import.meta.url), 'utf8');
        const edge = readFileSync(new URL('../../../supabase/functions/_shared/era.ts', import.meta.url), 'utf8');
        const surnames = "baroque: ['Bach', 'Vivaldi', 'Handel', 'Pachelbel'";
        expect(here).toContain(surnames);
        expect(client).toContain(surnames);
        expect(edge).toContain(surnames);
        expect(client).toContain("export const DEFAULT_ERA: Era = 'classical'");
        expect(edge).toContain("export const DEFAULT_ERA: Era = 'classical'");
    });
});
