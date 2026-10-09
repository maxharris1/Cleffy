import { PASSWORD_HINT } from '../../../supabase/functions/_shared/passwordPolicy';

/** Friendly copy for common Supabase Auth failures. */

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const USER_EXISTS = 'An account with this email already exists. Try signing in.';
const RATE_LIMITED = 'Too many attempts. Try again later.';
const LINK_EXPIRED = 'This link has expired. Request a new one.';
// The server's refusal of a password the form let through — which should only
// happen when the hosted policy and passwordPolicy.ts have drifted apart, or
// the password is in a breach corpus (see weakPasswordMessage).
const WEAK_PASSWORD = `That password is too weak. ${PASSWORD_HINT}`;
const PWNED_PASSWORD = 'That password has appeared in a data breach. Choose a different one.';
const SAME_PASSWORD = 'Choose a password different from your current one.';

/** Closed map of Auth API `error.code` → product copy. */
const BY_CODE: Readonly<Record<string, string>> = {
    invalid_credentials: INVALID_CREDENTIALS,
    user_already_exists: USER_EXISTS,
    over_email_send_rate_limit: RATE_LIMITED,
    over_request_rate_limit: RATE_LIMITED,
    otp_expired: LINK_EXPIRED,
    same_password: SAME_PASSWORD,
};

/**
 * Legacy / URL `error_description` strings that lack a machine code.
 * Kept small and ordered; prefer adding to BY_CODE when Auth exposes a code.
 */
const BY_MESSAGE: readonly { pattern: RegExp; message: string }[] = [
    { pattern: /invalid login credentials/i, message: INVALID_CREDENTIALS },
    { pattern: /user already registered|already been registered/i, message: USER_EXISTS },
    { pattern: /email rate limit|rate limit|too many requests/i, message: RATE_LIMITED },
    {
        pattern: /email link is invalid or has expired|token has expired|one-time token not found/i,
        message: LINK_EXPIRED,
    },
];

const readAuthFields = (err: unknown): { code: string; message: string } => {
    if (typeof err === 'string') {
        return { code: '', message: err };
    }
    if (err instanceof Error) {
        const withCode = err as Error & { code?: unknown };
        const code = typeof withCode.code === 'string' ? withCode.code : '';
        return { code, message: err.message };
    }
    if (err && typeof err === 'object') {
        const record = err as { code?: unknown; message?: unknown; error_code?: unknown };
        const code =
            typeof record.code === 'string'
                ? record.code
                : typeof record.error_code === 'string'
                  ? record.error_code
                  : '';
        const message = typeof record.message === 'string' ? record.message : '';
        return { code, message };
    }
    return { code: '', message: '' };
};

/**
 * Map a thrown Auth error or auth-redirect `error_description` string to
 * user-facing text. Unknown errors use `fallback` (no raw vendor passthrough).
 */
/**
 * AuthWeakPasswordError carries WHY in `reasons` ('length', 'characters',
 * 'pwned'). A breached password meets every rule the hint states, so repeating
 * the hint at it would be a refusal nobody can act on.
 */
const weakPasswordMessage = (err: unknown): string | null => {
    const reasons = err && typeof err === 'object' ? (err as { reasons?: unknown }).reasons : undefined;
    return Array.isArray(reasons) && reasons.includes('pwned') ? PWNED_PASSWORD : null;
};

export const mapAuthError = (err: unknown, fallback = 'Something went wrong.'): string => {
    const { code, message } = readAuthFields(err);
    if (code === 'weak_password') {
        return weakPasswordMessage(err) ?? WEAK_PASSWORD;
    }
    if (code && BY_CODE[code]) {
        return BY_CODE[code];
    }
    for (const { pattern, message: mapped } of BY_MESSAGE) {
        if (pattern.test(message)) {
            return mapped;
        }
    }
    return fallback;
};

const RESET_RATE_LIMITED = 'Too many requests right now. Wait a few minutes, then try again.';
const RESET_INVALID_EMAIL = 'Enter a valid email address.';
const RESET_UNREACHABLE = 'Could not reach Cleffy. Check your connection and try again.';

/**
 * What the forgot-password form may say about a failed reset request — or
 * null, meaning "show the same neutral confirmation as a success".
 *
 * GoTrue answers an address with no account with a plain 200 (it sends
 * nothing), so every error that only an EXISTING account can produce must
 * look like that 200 too, or the form becomes a way to test which addresses
 * have accounts. Those are the per-address resend limit ("you can only request
 * this after N seconds" — only an account has a last-sent time) and any failure
 * to send the mail itself. What may still be said is what does not depend on
 * the address having an account:
 *  * the request-rate limits, which GoTrue checks before it looks anyone up,
 *    so they answer every address alike — and the person needs to know to wait;
 *  * an address GoTrue will not accept at all (malformed, refused domain);
 *  * no answer at all: offline, or the service unreachable (502–504).
 */
export const passwordResetProblem = (err: unknown): string | null => {
    const { code, message } = readAuthFields(err);
    const record = err && typeof err === 'object' ? (err as { name?: unknown; status?: unknown }) : {};
    if (/only request this/i.test(message)) {
        return null;
    }
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || record.status === 429) {
        return RESET_RATE_LIMITED;
    }
    if (code === 'validation_failed' || code === 'email_address_invalid' || /unable to validate email/i.test(message)) {
        return RESET_INVALID_EMAIL;
    }
    if (record.name === 'AuthRetryableFetchError') {
        return RESET_UNREACHABLE;
    }
    return null;
};
