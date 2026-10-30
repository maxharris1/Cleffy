import { describe, expect, it } from 'vitest';

import { initialsOf } from '@/features/account/initials';

describe('initialsOf', () => {
    it('takes the first letters of the first and last names', () => {
        expect(initialsOf('Ada Lovelace')).toBe('AL');
        expect(initialsOf('  Clara   Josephine  Schumann ')).toBe('CS');
    });

    it('falls back to the start of the email local part, then to "?"', () => {
        expect(initialsOf('ada@example.com')).toBe('AD');
        expect(initialsOf('x')).toBe('X');
        expect(initialsOf('')).toBe('?');
        expect(initialsOf('   ')).toBe('?');
    });

    it('never splits an emoji or a letter with a combining mark', () => {
        expect(initialsOf('🎻 Strings')).toBe('🎻S');
        expect(initialsOf('👩‍🎤 Rocker')).toBe('👩‍🎤R');
        // "É" written as E + U+0301 stays one letter with its accent.
        expect(initialsOf('Émile Zola')).toBe('ÉZ');
        expect(initialsOf('😀😃@example.com')).toBe('😀😃');
    });

    it('upper-cases in a locale-aware way', () => {
        expect(initialsOf('ñandú élan')).toBe('ÑÉ');
    });
});
