/**
 * Student credentials: setup codes, usernames, passwords.
 *
 * NO imports — like entitlements.ts, this file is loaded by Deno (with the
 * `.ts` extension), by vitest (without it), and by the browser bundle (the
 * claim page validates against the same rules the server enforces), so the
 * rules are covered by the CI suite and cannot drift between the three. Web
 * Crypto is present in all three runtimes.
 *
 * A code is a one-time CLAIM token, not a password: it selects the roster row
 * (by hash) exactly once, at which point the student chooses their own
 * credential. It still has to carry real entropy — this is not a 4-digit
 * classroom PIN, because whoever holds a live code owns the claim. Twelve
 * characters from a 31-symbol alphabet is ~59 bits, drawn rejection-sampled so
 * every code is uniform. The alphabet drops 0/O, 1/I/L so a code read off a
 * printed card over a music stand cannot be mistyped into ambiguity.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const CODE_LENGTH = 12;

/** Rendered as XXXX-XXXX-XXXX on cards; separators are cosmetic only. */
export const formatLoginCode = (code: string): string =>
    code.replace(/(.{4})(?=.)/g, '$1-');

/** Uppercases and strips everything outside the alphabet (dashes, spaces, dots). */
export const normalizeLoginCode = (input: string): string => {
    let out = '';
    for (const ch of input.toUpperCase()) {
        if (CODE_ALPHABET.includes(ch)) {
            out += ch;
        }
    }
    return out;
};

/** Cheap shape check before any lookup — never reveals whether a code exists. */
export const isPlausibleLoginCode = (normalized: string): boolean => normalized.length === CODE_LENGTH;

/**
 * Uniform random code. Rejection sampling: a byte modulo 31 would bias the
 * first few symbols, so bytes >= 248 (the largest multiple of 31 below 256)
 * are discarded instead.
 */
export const generateLoginCode = (): string => {
    const limit = 256 - (256 % CODE_ALPHABET.length);
    let out = '';
    while (out.length < CODE_LENGTH) {
        const bytes = new Uint8Array(CODE_LENGTH * 2);
        crypto.getRandomValues(bytes);
        for (const byte of bytes) {
            if (out.length === CODE_LENGTH) {
                break;
            }
            if (byte < limit) {
                out += CODE_ALPHABET[byte % CODE_ALPHABET.length] as string;
            }
        }
    }
    return out;
};

/**
 * SHA-256 hex of the normalized code — the only form managed_students stores.
 * Unsalted is acceptable here because the input space is ~59 uniform bits, far
 * beyond any rainbow table; a pepper would add key-management for no real gain.
 */
export const hashLoginCode = async (normalized: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
};

/**
 * The synthetic address of a code-method student's auth user. Never shown to
 * anyone: no inbox exists behind it, and no email is collected from a
 * code-method student — that path stays the zero-email option. Email-method
 * students use their real address instead and never get a synthetic one.
 */
export const syntheticStudentEmail = (rosterId: string): string => `st-${rosterId}@students.cleffy.app`;

// ---------------------------------------------------------------------------
// Usernames and passwords (the credential a code student claims into)
// ---------------------------------------------------------------------------

export const USERNAME_MIN = 3;

export const USERNAME_MAX = 20;

/**
 * The canonical shape: lowercase letters, digits, underscore. The stored value
 * is always already normalized, so the regex never needs a case-insensitive
 * flag — and the DB re-checks this exact pattern in a CHECK constraint, so a
 * service-role bug cannot store a spelling the login lookup could not match.
 */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/** Trim + lowercase — applied before every comparison, storage, and lookup. */
export const normalizeUsername = (input: string): string => input.trim().toLowerCase();

/**
 * Names that would let a student impersonate the app or its people, or that
 * read as official. Small on purpose: the roster is per-teacher social space,
 * not a public forum, so this only needs to cover the confusing cases.
 */
export const RESERVED_USERNAMES: readonly string[] = [
    'admin',
    'cleffy',
    'help',
    'mod',
    'moderator',
    'root',
    'staff',
    'student',
    'support',
    'system',
    'teacher',
    'test',
];

/** True for a normalized username of valid shape that is not reserved. */
export const isValidUsername = (normalized: string): boolean =>
    USERNAME_RE.test(normalized) && !RESERVED_USERNAMES.includes(normalized);

export const STUDENT_PASSWORD_MIN = 8;

/** Upper bound is bcrypt's 72-byte ceiling — GoTrue truncates beyond it. */
export const STUDENT_PASSWORD_MAX = 72;

export const isValidStudentPassword = (password: string): boolean =>
    password.length >= STUDENT_PASSWORD_MIN && password.length <= STUDENT_PASSWORD_MAX;

/**
 * The scramble set as an Invited account's auth password: 32 random bytes as
 * hex, generated, set, and forgotten. Nobody ever knows it — which is what
 * makes "no sign-in path exists for an Invited account" true, on both the
 * code path (before claim, after reset) and the email path (after reset).
 */
export const generateProvisionPassword = (): string => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
};
