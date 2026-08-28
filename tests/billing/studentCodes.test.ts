import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CODE_ALPHABET,
    CODE_LENGTH,
    formatLoginCode,
    generateLoginCode,
    generateProvisionPassword,
    hashLoginCode,
    isPlausibleLoginCode,
    isValidStudentPassword,
    isValidUsername,
    normalizeLoginCode,
    normalizeUsername,
    RESERVED_USERNAMES,
    STUDENT_PASSWORD_MAX_BYTES,
    STUDENT_PASSWORD_MIN,
    syntheticStudentEmail,
    USERNAME_MAX,
    USERNAME_MIN,
    USERNAME_RE,
} from '../../supabase/functions/_shared/studentCodes';

/**
 * A login code is a ONE-TIME CLAIM TOKEN: its hash selects the roster row in
 * student-claim exactly once, and the student picks a username and a password
 * there. It is never the account's password, but it is still the whole of what
 * stands between a stranger and a claim, so nothing here is cosmetic. Three
 * properties are worth a test:
 *
 *  - the code carries real entropy and no ambiguous glyphs, because it is read
 *    off a printed card and typed by a child at a music stand;
 *  - normalization makes the dashes, spaces and lower case that a child types
 *    into a non-issue, without ever widening what counts as a valid code;
 *  - the hash is a stable SHA-256 hex, since it is the only form the roster
 *    stores and student-login's lookup is an equality match on it.
 *
 * Imported without the `.ts` extension: this module is written to load under
 * both Deno and vitest, which is what puts it in reach of this suite at all.
 */

const SAMPLES = 200;

const codes = (count: number): string[] => Array.from({ length: count }, () => generateLoginCode());

describe('generateLoginCode', () => {
    it('is twelve characters from the unambiguous alphabet', () => {
        for (const code of codes(SAMPLES)) {
            expect(code).toHaveLength(CODE_LENGTH);
            expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`));
        }
    });

    it('never emits a glyph that can be misread off a printed card', () => {
        // 0/O and 1/I/L are the pairs a child mistypes; the alphabet drops one of
        // each rather than relying on a font to tell them apart.
        const ambiguous = ['0', 'O', '1', 'I', 'L'];
        for (const glyph of ambiguous) {
            expect(CODE_ALPHABET).not.toContain(glyph);
        }
        expect(codes(SAMPLES).join('')).not.toMatch(/[0O1IL]/);
    });

    it('gives two calls two different codes', () => {
        expect(generateLoginCode()).not.toBe(generateLoginCode());
        // At ~59 bits a collision inside one run is not a thing that happens; a
        // duplicate here means the generator is not drawing fresh bytes at all.
        expect(new Set(codes(SAMPLES)).size).toBe(SAMPLES);
    });

    it('can reach every symbol in the alphabet', () => {
        // The rejection sampling exists so a byte modulo 31 cannot bias the first
        // few symbols. This does not measure the distribution — it proves no
        // symbol is unreachable, which is the failure a broken sampler produces.
        const drawn = new Set(codes(SAMPLES).join(''));
        expect(drawn.size).toBe(CODE_ALPHABET.length);
    });

    it('comes out already normalized, which is what provisioning hashes', () => {
        // student-provision hashes the generated code directly and student-login
        // hashes what the student typed after normalizing it. Those two only meet
        // if generation lands in normalized form to begin with.
        for (const code of codes(SAMPLES)) {
            expect(normalizeLoginCode(code)).toBe(code);
        }
    });
});

describe('normalizeLoginCode', () => {
    it('uppercases what a child types in lower case', () => {
        expect(normalizeLoginCode('abcd2345efgh')).toBe('ABCD2345EFGH');
    });

    it('strips the separators the card prints and the spaces a keyboard adds', () => {
        expect(normalizeLoginCode('ABCD-2345-EFGH')).toBe('ABCD2345EFGH');
        expect(normalizeLoginCode(' ABCD 2345 EFGH ')).toBe('ABCD2345EFGH');
        expect(normalizeLoginCode('abcd. 2345 -efgh')).toBe('ABCD2345EFGH');
    });

    it('drops anything outside the alphabet rather than passing it through', () => {
        // Including the ambiguous glyphs: a typed O is not silently read as a 0,
        // it is dropped, and the shortened result fails isPlausible below.
        expect(normalizeLoginCode('OOOO-1111-LLLL')).toBe('');
        expect(normalizeLoginCode('')).toBe('');
    });

    it('round-trips the format the printed card uses', () => {
        for (const code of codes(20)) {
            const printed = formatLoginCode(code);
            expect(printed).toBe(`${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`);
            expect(normalizeLoginCode(printed)).toBe(code);
        }
    });

    it('leaves no trailing separator on the printed form', () => {
        // The groups are cosmetic, so a dash with nothing after it would be a
        // character the student has to know to ignore.
        expect(formatLoginCode('ABCD2345EFGH')).toBe('ABCD-2345-EFGH');
        expect(formatLoginCode('ABCD2345EFGH').endsWith('-')).toBe(false);
    });
});

describe('isPlausibleLoginCode', () => {
    it('accepts a normalized code of the right length', () => {
        expect(isPlausibleLoginCode(normalizeLoginCode(formatLoginCode(generateLoginCode())))).toBe(true);
    });

    it('rejects an empty or short code before any lookup happens', () => {
        expect(isPlausibleLoginCode('')).toBe(false);
        expect(isPlausibleLoginCode('ABCD')).toBe(false);
        expect(isPlausibleLoginCode(normalizeLoginCode('ABCD-2345'))).toBe(false);
    });

    it('rejects a string made only of characters the alphabet excludes', () => {
        // The check reads the NORMALIZED form, which is the whole reason it can be
        // this cheap: twelve O's normalize to nothing and never reach a lookup.
        expect(isPlausibleLoginCode(normalizeLoginCode('OOOOOOOOOOOO'))).toBe(false);
        expect(isPlausibleLoginCode(normalizeLoginCode('llllllllllll'))).toBe(false);
    });

    it('rejects a code that is too long', () => {
        expect(isPlausibleLoginCode(`${'A'.repeat(CODE_LENGTH)}A`)).toBe(false);
    });
});

describe('hashLoginCode', () => {
    it('is a 64-character lowercase hex digest', async () => {
        const hash = await hashLoginCode(generateLoginCode());
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable for the same code', async () => {
        const code = generateLoginCode();
        expect(await hashLoginCode(code)).toBe(await hashLoginCode(code));
    });

    it('differs for a different code', async () => {
        expect(await hashLoginCode(generateLoginCode())).not.toBe(await hashLoginCode(generateLoginCode()));
    });

    it('is SHA-256, zero-padded per byte', async () => {
        // The published vector, which pins both the algorithm and the hex
        // encoding: a byte formatted without padStart would drop the '01' here to
        // '1' and quietly produce a 63-character hash for some inputs.
        expect(await hashLoginCode('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('is what makes the stored form unreadable — a lost code is replaced, never recovered', async () => {
        const code = generateLoginCode();
        const stored = await hashLoginCode(code);
        expect(stored).not.toContain(code);
    });
});

describe('syntheticStudentEmail', () => {
    it('names the roster row the account belongs to', () => {
        expect(syntheticStudentEmail('11111111-2222-3333-4444-555555555555')).toBe(
            'st-11111111-2222-3333-4444-555555555555@students.cleffy.app',
        );
    });

    it('gives every roster row its own address', () => {
        expect(syntheticStudentEmail('a')).not.toBe(syntheticStudentEmail('b'));
    });

    it('is derived, never collected — no student address is ever asked for', () => {
        // The address exists so Supabase has something to key an auth user on. No
        // inbox is behind it, which is why provisioning sets email_confirm.
        const address = syntheticStudentEmail('11111111-2222-3333-4444-555555555555');
        expect(address.endsWith('@students.cleffy.app')).toBe(true);
        expect(address.startsWith('st-')).toBe(true);
    });
});

/**
 * Usernames and passwords: what a code student claims INTO, and what they type
 * every lesson afterwards. The pipeline is always normalize-then-validate, in
 * that order, in all three runtimes — the claim page, student-claim, and the
 * `username ~ '^[a-z0-9_]{3,20}$'` CHECK in
 * 20260827150000_student_credentials.sql. The tests below pin the pipeline, not
 * either half on its own, because the stored form being canonical is what makes
 * a plain unique index a case-insensitive uniqueness guarantee.
 */
describe('normalizeUsername', () => {
    it('lowercases what a phone keyboard capitalizes', () => {
        expect(normalizeUsername('Amelia_K')).toBe('amelia_k');
        expect(normalizeUsername('AMELIA')).toBe('amelia');
    });

    it('trims the whitespace a copy-paste brings with it', () => {
        expect(normalizeUsername('  amelia  ')).toBe('amelia');
        expect(normalizeUsername('\tamelia\n')).toBe('amelia');
    });

    it('leaves an already-canonical name exactly as it is', () => {
        // The stored value is always normalized, so this is the identity that
        // makes the login lookup an equality match rather than a search.
        expect(normalizeUsername('amelia_k2')).toBe('amelia_k2');
        expect(normalizeUsername(normalizeUsername(' Amelia_K2 '))).toBe('amelia_k2');
    });
});

describe('isValidUsername', () => {
    it('accepts the shapes a student would actually pick', () => {
        for (const name of ['ada', 'amelia_k', 'player_1', 'x_9', '___', 'a'.repeat(USERNAME_MAX)]) {
            expect(isValidUsername(name)).toBe(true);
        }
    });

    it('rejects anything shorter than the minimum or longer than the maximum', () => {
        expect(isValidUsername('a'.repeat(USERNAME_MIN - 1))).toBe(false);
        expect(isValidUsername('a'.repeat(USERNAME_MIN))).toBe(true);
        expect(isValidUsername('a'.repeat(USERNAME_MAX))).toBe(true);
        expect(isValidUsername('a'.repeat(USERNAME_MAX + 1))).toBe(false);
        expect(isValidUsername('')).toBe(false);
    });

    it('rejects every character outside the canonical alphabet', () => {
        for (const name of ['amelia k', 'amelia-k', 'amelia@k', 'amelia.k', 'améliá', 'am/k', 'am\tk']) {
            expect(isValidUsername(name)).toBe(false);
        }
    });

    it('normalizes before judging, so a caller that skipped it is not punished', () => {
        // The function normalizes internally. A capital or a stray space is what
        // a phone keyboard and a copy-paste produce, and neither is a reason to
        // tell a child their name is illegal.
        for (const name of ['Music_Kid', 'AMELIA', ' ada ', '\tada\n']) {
            expect(isValidUsername(name)).toBe(true);
        }
    });

    it('cannot be walked past by dressing a reserved name up', () => {
        // The direction that would matter: a raw spelling that normalizes INTO a
        // reserved name must still be refused, or the list would be decorative.
        for (const dressed of ['Admin', 'ADMIN', ' support ', 'TeAcHeR', '  Root  ']) {
            expect(isValidUsername(dressed)).toBe(false);
        }
    });

    it('rejects every reserved name', () => {
        for (const reserved of RESERVED_USERNAMES) {
            expect(isValidUsername(reserved)).toBe(false);
        }
    });

    it('rejects a reserved name dressed up in capitals, once normalized', () => {
        // The whole point of normalize-then-validate. 'Admin' fails the shape
        // check on its own, which would hide a reserved list that never ran; what
        // matters is that the pipeline the server actually uses refuses it.
        for (const dressed of ['Admin', 'ADMIN', ' Support ', 'Teacher']) {
            expect(isValidUsername(normalizeUsername(dressed))).toBe(false);
        }
        // And that the same pipeline still admits an ordinary name.
        expect(isValidUsername(normalizeUsername(' Amelia_K '))).toBe(true);
    });
});

describe('isValidStudentPassword', () => {
    it('refuses one character below the minimum and accepts the minimum', () => {
        expect(isValidStudentPassword('a'.repeat(STUDENT_PASSWORD_MIN - 1))).toBe(false);
        expect(isValidStudentPassword('a'.repeat(STUDENT_PASSWORD_MIN))).toBe(true);
        expect(STUDENT_PASSWORD_MIN).toBe(8);
    });

    it('stops at the bcrypt ceiling, which Supabase Auth rejects rather than truncates', () => {
        expect(isValidStudentPassword('a'.repeat(STUDENT_PASSWORD_MAX_BYTES))).toBe(true);
        expect(isValidStudentPassword('a'.repeat(STUDENT_PASSWORD_MAX_BYTES + 1))).toBe(false);
        expect(STUDENT_PASSWORD_MAX_BYTES).toBe(72);
    });

    it('measures the ceiling in BYTES, so a multi-byte password cannot slip past it', () => {
        // The bug this pins: '.length' counts UTF-16 units, so 25 piano emoji
        // read as 50 and sailed under a 72 "character" bound while actually
        // being 100 bytes — a password the server would refuse outright, after
        // the student had already typed it twice.
        const emoji = '🎹'.repeat(25);
        expect(emoji.length).toBe(50);
        expect(new TextEncoder().encode(emoji).length).toBe(100);
        expect(isValidStudentPassword(emoji)).toBe(false);

        // Accents are the quieter version of the same thing: two bytes each.
        expect(isValidStudentPassword('é'.repeat(36))).toBe(true);
        expect(isValidStudentPassword('é'.repeat(37))).toBe(false);
    });

    it('measures the floor in characters, so an emoji counts as the one key it was', () => {
        // The other half of the mixed units. Eight emoji is eight characters to
        // the student and 32 bytes to bcrypt; counting UTF-16 units would call
        // four of them "eight" and let a four-key password through.
        expect(isValidStudentPassword('🎹'.repeat(STUDENT_PASSWORD_MIN))).toBe(true);
        expect(isValidStudentPassword('🎹'.repeat(STUDENT_PASSWORD_MIN - 1))).toBe(false);
    });

    it('takes the password exactly as typed, spaces and all', () => {
        // Never trimmed anywhere in the stack — a password whose spaces are eaten
        // on the way in is one the student cannot type on the way back.
        expect(isValidStudentPassword('  pass  ')).toBe(true);
        expect(isValidStudentPassword('')).toBe(false);
    });
});

describe('generateProvisionPassword', () => {
    it('is 32 random bytes as lowercase hex', () => {
        const password = generateProvisionPassword();
        expect(password).toHaveLength(64);
        expect(password).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gives two calls two different scrambles', () => {
        // This value is set and forgotten — it is what makes "no sign-in path
        // exists for an Invited account" true. A generator that repeated itself
        // would make one scramble the password of every unclaimed student.
        expect(generateProvisionPassword()).not.toBe(generateProvisionPassword());
        const drawn = new Set(Array.from({ length: SAMPLES }, () => generateProvisionPassword()));
        expect(drawn.size).toBe(SAMPLES);
    });

    it('is a password no rule in this file would reject as too long', () => {
        // 64 characters, comfortably inside bcrypt's 72-byte ceiling, so GoTrue
        // stores the whole scramble rather than refusing it.
        expect(isValidStudentPassword(generateProvisionPassword())).toBe(true);
    });
});

/**
 * Drift guard, in the shape limitsInSync.test.ts uses on tier_limits().
 *
 * The username shape lives in two places that cannot import each other:
 * USERNAME_RE, which every runtime validates against, and the
 * managed_students_username_shape CHECK, which is what the database will
 * actually refuse. They were written to be the same pattern. Nothing but this
 * test keeps them that way, and the failure they would hide is quiet: a
 * username the form accepts and the INSERT then rejects, surfacing as a 502 at
 * the end of a claim the student cannot retry.
 */
describe('username shape stays in step with the migration', () => {
    // Resolved from the project root: the jsdom test environment gives
    // import.meta a non-file URL, so fileURLToPath cannot be used here.
    const MIGRATION = resolve(process.cwd(), 'supabase/migrations/20260827150000_student_credentials.sql');

    it('re-states exactly the pattern the CHECK constraint enforces', () => {
        const sql = readFileSync(MIGRATION, 'utf8');
        const match =
            /constraint managed_students_username_shape\s+check \(username is null or username ~ '([^']+)'\)/.exec(sql);
        expect(match, 'managed_students_username_shape not found — was the constraint renamed?').not.toBeNull();
        expect((match as RegExpExecArray)[1]).toBe(USERNAME_RE.source);
    });

    it('builds the pattern from the exported bounds rather than a literal', () => {
        // student-claim's error copy and the claim page's hint both quote these
        // constants, so a regex that ignored them would advertise one rule and
        // enforce another.
        expect(USERNAME_RE.source).toBe(`^[a-z0-9_]{${USERNAME_MIN},${USERNAME_MAX}}$`);
    });
});
