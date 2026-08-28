/**
 * Student credentials: setup codes, usernames, passwords.
 *
 * NO imports — like entitlements.ts, this file is loaded by Deno (with the
 * `.ts` extension), by vitest (without it), and by the browser bundle (the
 * claim page validates against the same rules the server enforces), so all
 * three runtimes read one definition and cannot drift from each other. Web
 * Crypto is present in all three.
 *
 * The username shape has a FOURTH home this file cannot reach: the
 * managed_students_username_shape CHECK in
 * 20260827150000_student_credentials.sql, which re-states the pattern in SQL so
 * a service-role bug cannot store a spelling the login lookup would never
 * match. That copy drifts as easily as any other, so a guard test parses it
 * back out of the migration and holds it against USERNAME_RE — the same trick
 * limitsInSync.test.ts plays on tier_limits().
 *
 * A code is a one-time CLAIM token, not a password: student-claim spends it to
 * select the roster row (by hash) exactly once, nulling the hash in the same
 * statement that stores the username the student picked, and until then the
 * account's own password is a scramble. The code still has to carry real
 * entropy — this is not a 4-digit classroom PIN, because whoever holds a live
 * code owns the claim. Twelve characters from a 31-symbol alphabet is ~59 bits,
 * drawn rejection-sampled so every code is uniform. The alphabet drops 0/O,
 * 1/I/L so a code read off a printed card over a music stand cannot be mistyped
 * into ambiguity.
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

/** Lowercase hex — the form both a code hash and a provision scramble take. */
const toHex = (bytes: Uint8Array): string => {
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
};

/**
 * SHA-256 hex of the normalized code — the only form managed_students stores.
 * Unsalted is acceptable here because the input space is ~59 uniform bits, far
 * beyond any rainbow table; a pepper would add key-management for no real gain.
 */
export const hashLoginCode = async (normalized: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    return toHex(new Uint8Array(digest));
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
 * is always already normalized, so the pattern never needs a case-insensitive
 * flag.
 *
 * Built FROM the two constants rather than written out beside them. They are
 * not decoration: student-claim's error copy and the claim page's hint both
 * quote them, so a hardcoded `{3,20}` here would let someone raise USERNAME_MAX
 * and ship a form that advertises a bound the validator still refuses.
 */
export const USERNAME_RE = new RegExp(`^[a-z0-9_]{${USERNAME_MIN},${USERNAME_MAX}}$`);

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

/**
 * True for a username of valid shape that is not reserved.
 *
 * Normalizes first rather than trusting the caller to have done it. Both call
 * sites already do, so this changes no behavior today — but a caller that
 * validated raw input would otherwise reject 'Music_Kid', a name that is
 * perfectly legal the moment it is lowercased. The mistake can only ever have
 * gone in that direction: every string matching USERNAME_RE contains no
 * whitespace and no uppercase, so it is already invariant under
 * normalizeUsername, and normalizing here can turn a spurious false into a true
 * but never a true into a false. There is no raw spelling that sneaks past the
 * reserved list by normalizing INTO one.
 */
export const isValidUsername = (username: string): boolean => {
    const normalized = normalizeUsername(username);
    return USERNAME_RE.test(normalized) && !RESERVED_USERNAMES.includes(normalized);
};

/** Minimum, counted in characters — the unit the student is told they typed. */
export const STUDENT_PASSWORD_MIN = 8;

/**
 * Maximum, counted in BYTES, because bytes are the unit bcrypt limits: it
 * hashes at most 72 of them and Supabase Auth REJECTS anything longer outright
 * (supabase/auth#1368, released 2.132.3). Older builds truncated silently
 * instead, which was the worse failure — two different passwords hashing alike.
 *
 * The two bounds deliberately count different things, because they are about
 * different things: the minimum is a policy on how much the student typed, the
 * maximum is a ceiling their password has to physically fit under. An emoji is
 * one character against the first and four bytes against the second, and
 * measuring both with `.length` (UTF-16 code units) would get each one wrong in
 * a different direction.
 */
export const STUDENT_PASSWORD_MAX_BYTES = 72;

/** Code points, not UTF-16 units: '🎹' is one character, and `.length` says two. */
const characterCount = (value: string): number => [...value].length;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

export const isValidStudentPassword = (password: string): boolean =>
    characterCount(password) >= STUDENT_PASSWORD_MIN && utf8ByteLength(password) <= STUDENT_PASSWORD_MAX_BYTES;

/**
 * The scramble set as an Invited account's auth password: 32 random bytes as
 * hex, generated, set, and forgotten. Nobody ever knows it, which is what makes
 * the printed code — rather than the account itself — the only way in to a
 * student who has not claimed yet.
 *
 * Be precise about what that buys, because it is narrower than it looks: this
 * revokes the PASSWORD grant and nothing else. A code-method account is beyond
 * the other grants only because its address is synthetic and no inbox exists
 * behind it. An email-method account sits on a real inbox, so OTP and recovery
 * still reach it — which is not a hole but the mechanism the email branch of
 * 'reset' relies on to get a locked-out student back in. Withdrawing access
 * outright is the ban's job, never this value's: see ARCHIVE_BAN_DURATION and
 * the note above it in student-provision.
 */
export const generateProvisionPassword = (): string => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
};
