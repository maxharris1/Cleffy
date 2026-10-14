/**
 * The password policy for every Cleffy account — teacher, email student, code
 * student — stated once.
 *
 * NO imports, like studentCodes.ts: Deno loads this with the `.ts` extension
 * (student-claim), vitest without it, and the browser bundle validates every
 * new-password form against it, so the three runtimes cannot disagree.
 *
 * The AUTHORITY is Supabase Auth, configured to match in supabase/config.toml
 * (`minimum_password_length = 8`, `password_requirements = "letters_digits"`)
 * and, for the hosted projects, through the Management API (see DEPLOY.md). It
 * applies to sign-up, password change and recovery, and to the admin API
 * student-claim uses — so anything this file lets through that GoTrue would
 * refuse is a confusing round-trip, and anything it refuses that GoTrue would
 * accept is a rule nobody can see. Keep the two equal.
 *
 * It applies only where a password is CHOSEN. Sign-in never checks it: accounts
 * created under the old 6-character minimum must still be able to log in, and
 * GoTrue does not re-check strength on sign-in either.
 */

/** Minimum, counted in characters — the unit the person is told they typed. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Maximum, counted in BYTES, because bytes are the unit bcrypt limits: it
 * hashes at most 72 of them and Supabase Auth REJECTS anything longer outright
 * (supabase/auth#1368, released 2.132.3). Older builds truncated silently
 * instead, which was the worse failure — two different passwords hashing alike.
 *
 * The two bounds deliberately count different things, because they are about
 * different things: the minimum is a policy on how much was typed, the maximum
 * is a ceiling the password has to physically fit under. An emoji is one
 * character against the first and four bytes against the second, and measuring
 * both with `.length` (UTF-16 code units) would get each one wrong in a
 * different direction. GoTrue's own minimum counts bytes, so a password that
 * clears ours in characters always clears its.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * GoTrue's `letters_digits` requirement, exactly: at least one ASCII letter and
 * one ASCII digit. Not \p{L} — an accented or non-Latin letter does not count
 * for GoTrue, so it must not count here, or the form would pass a password the
 * server then refuses.
 */
const ASCII_LETTER = /[A-Za-z]/;
const ASCII_DIGIT = /[0-9]/;

export type PasswordProblem = 'too_short' | 'too_long' | 'needs_letter_and_digit';

/** Code points, not UTF-16 units: '🎹' is one character, and `.length` says two. */
const characterCount = (value: string): number => [...value].length;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Which rule a new password breaks, or null when it meets the policy.
 *
 * One problem at a time, length first: "too short" is the one a person fixes
 * by typing more, which usually fixes the rest. The password is judged exactly
 * as typed — never trimmed, never normalized — because that is what GoTrue
 * stores the hash of.
 */
export const passwordProblem = (password: string): PasswordProblem | null => {
    if (characterCount(password) < PASSWORD_MIN_LENGTH) {
        return 'too_short';
    }
    if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) {
        return 'too_long';
    }
    if (!ASCII_LETTER.test(password) || !ASCII_DIGIT.test(password)) {
        return 'needs_letter_and_digit';
    }
    return null;
};

export const isValidPassword = (password: string): boolean => passwordProblem(password) === null;

/** The rule as one line, for under a new-password field. */
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number.`;

/**
 * The refusal for each problem — one sentence per rule, because a refusal that
 * names the minimum for a password that was too LONG contradicts the field the
 * person is looking at.
 */
export const passwordProblemMessage = (problem: PasswordProblem): string => {
    switch (problem) {
        case 'too_short':
            return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
        case 'too_long':
            return 'That password is too long — pick a shorter one.';
        case 'needs_letter_and_digit':
            return 'Password must include at least one letter and one number.';
    }
};
