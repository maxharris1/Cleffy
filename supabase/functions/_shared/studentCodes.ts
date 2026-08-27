/**
 * Student login codes: generation, normalization, hashing.
 *
 * NO imports — like entitlements.ts, this file is loaded by Deno (with the
 * `.ts` extension) and by vitest (without it), so the code rules are covered by
 * the CI suite. Web Crypto is present in both runtimes.
 *
 * A code is the student's entire credential: it selects the roster row (by
 * hash) AND serves as the Supabase password of the synthetic student user, so
 * it has to carry real entropy — this is not a 4-digit classroom PIN. Twelve
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
 * The synthetic address of a provisioned student's auth user. Never shown to
 * anyone: no inbox exists behind it, and no email is ever collected from the
 * student — the COPPA posture is that the code on the printed card is the whole
 * credential.
 */
export const syntheticStudentEmail = (rosterId: string): string => `st-${rosterId}@students.cleffy.app`;
