import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    isValidPassword,
    PASSWORD_HINT,
    PASSWORD_MAX_BYTES,
    PASSWORD_MIN_LENGTH,
    passwordProblem,
    passwordProblemMessage,
} from '../../supabase/functions/_shared/passwordPolicy';

/**
 * The account password policy. Every account's password is chosen against
 * these rules (sign-up, recovery, account settings, the student claim and
 * welcome pages, student-claim on the server) and GoTrue enforces the same ones
 * — so the cases here are also the cases the hosted auth config must agree with.
 */

/** A password of exactly `n` characters that meets every other rule. */
const ofLength = (n: number): string => `1${'a'.repeat(n - 1)}`;

describe('passwordProblem — length', () => {
    it('refuses one character below the minimum and accepts the minimum', () => {
        expect(PASSWORD_MIN_LENGTH).toBe(8);
        expect(passwordProblem(ofLength(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
        expect(passwordProblem(ofLength(PASSWORD_MIN_LENGTH))).toBeNull();
    });

    it('stops at the bcrypt ceiling, which Supabase Auth rejects rather than truncates', () => {
        expect(PASSWORD_MAX_BYTES).toBe(72);
        expect(passwordProblem(ofLength(PASSWORD_MAX_BYTES))).toBeNull();
        expect(passwordProblem(ofLength(PASSWORD_MAX_BYTES + 1))).toBe('too_long');
    });

    it('measures the ceiling in BYTES, so a multi-byte password cannot slip past it', () => {
        // '.length' counts UTF-16 units, so 25 piano emoji read as 50 and would
        // sail under a 72 "character" bound while actually being 100 bytes — a
        // password the server refuses outright, after it was typed twice.
        const emoji = `a1${'🎹'.repeat(25)}`;
        expect(emoji.length).toBe(52);
        expect(new TextEncoder().encode(emoji).length).toBe(102);
        expect(passwordProblem(emoji)).toBe('too_long');

        // Accents are the quieter version of the same thing: two bytes each.
        expect(passwordProblem(`a1${'é'.repeat(35)}`)).toBeNull(); // 72 bytes
        expect(passwordProblem(`a1${'é'.repeat(36)}`)).toBe('too_long'); // 74 bytes
    });

    it('measures the floor in characters, so an emoji counts as the one key it was', () => {
        // Eight characters to the person, 26 bytes to bcrypt; counting UTF-16
        // units would call five of these "eight" and let them through.
        expect(passwordProblem(`a1${'🎹'.repeat(PASSWORD_MIN_LENGTH - 2)}`)).toBeNull();
        expect(passwordProblem(`a1${'🎹'.repeat(PASSWORD_MIN_LENGTH - 3)}`)).toBe('too_short');
    });
});

describe('passwordProblem — letters and digits', () => {
    it('needs at least one letter and one digit', () => {
        expect(passwordProblem('abcdefgh')).toBe('needs_letter_and_digit');
        expect(passwordProblem('12345678')).toBe('needs_letter_and_digit');
        expect(passwordProblem('--------')).toBe('needs_letter_and_digit');
        expect(passwordProblem('abcdefg1')).toBeNull();
        expect(passwordProblem('1234567Z')).toBeNull();
        expect(passwordProblem('hunter2hunter2')).toBeNull();
    });

    it('counts only ASCII letters, exactly as GoTrue letters_digits does', () => {
        // GoTrue checks against a-zA-Z; a form that accepted 'é' as the letter
        // would pass a password the server then refuses.
        expect(passwordProblem('éééééé12')).toBe('needs_letter_and_digit');
        expect(passwordProblem('ééééé12x')).toBeNull();
    });

    it('reports length before composition, the problem typing more usually fixes', () => {
        expect(passwordProblem('abc')).toBe('too_short');
        expect(passwordProblem('')).toBe('too_short');
    });

    it('takes the password exactly as typed, spaces and all', () => {
        // Never trimmed anywhere in the stack — a password whose spaces are eaten
        // on the way in is one nobody can type on the way back.
        expect(isValidPassword('  pass 1  ')).toBe(true);
        expect(isValidPassword('   1a   ')).toBe(true);
    });
});

describe('passwordProblemMessage', () => {
    it('gives each rule its own sentence', () => {
        const messages = (['too_short', 'too_long', 'needs_letter_and_digit'] as const).map(passwordProblemMessage);
        expect(new Set(messages).size).toBe(3);
        expect(passwordProblemMessage('too_short')).toBe('Password must be at least 8 characters.');
        expect(passwordProblemMessage('needs_letter_and_digit')).toBe(
            'Password must include at least one letter and one number.',
        );
        expect(PASSWORD_HINT).toBe('At least 8 characters, with a letter and a number.');
    });
});

/**
 * Drift guard: the local auth config must state the policy this file enforces.
 * The hosted projects are configured by hand from DEPLOY.md, which this cannot
 * reach — that payload is in the same commit for the same reason.
 */
describe('supabase/config.toml', () => {
    const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
    const authSection = config.slice(config.indexOf('[auth]'), config.indexOf('[auth.', config.indexOf('[auth]')));

    it('sets the same minimum length', () => {
        expect(authSection).toMatch(new RegExp(`^minimum_password_length = ${PASSWORD_MIN_LENGTH}$`, 'm'));
    });

    it('requires letters and digits', () => {
        expect(authSection).toMatch(/^password_requirements = "letters_digits"$/m);
    });
});
