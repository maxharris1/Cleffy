import type * as PasswordPolicy from './passwordPolicy.ts';

/**
 * A share-link guest attaching an email address (and a password) to their
 * anonymous account — proven by a one-time code sent to that address.
 *
 * Why this exists: the upgrade banner used to call
 * `supabase.auth.updateUser({ email })` from the browser. Both projects run
 * with `mailer_autoconfirm` on, which confirms an email CHANGE as instantly as
 * a sign-up, so a guest could claim any address with no mail sent: the real
 * owner then hit "an account with this email already exists", and a password
 * reset to the address would hand the guest's account to its mailbox. The
 * address must be proven before it is attached, whatever the auth settings
 * say — so the browser no longer attaches anything. guest-email-start mails a
 * code; guest-email-confirm checks it and only then sets the email (marked
 * confirmed: it now is) and the password through the admin API, which also
 * turns the anonymous user into a registered one with the same id, so every
 * membership and mark the guest made stays theirs.
 *
 * NO runtime imports, like loginThrottle.ts and student-login/handler.ts: Deno
 * wants the `.ts` extension and vitest wants it gone, so everything the
 * handlers call arrives in `deps`, and the type-only import above vanishes at
 * compile time. The two index.ts files are only the wiring.
 */

export const GUEST_EMAIL_CODE_LENGTH = 6;
/** How long a mailed code stays good. */
export const GUEST_EMAIL_CODE_TTL_MS = 15 * 60_000;
/**
 * Wrong codes before the pending one is thrown away. With six digits and the
 * per-recipient send limit below, guessing at someone else's address is ~15
 * tries an hour against a million codes — and every try mails that person.
 */
export const GUEST_EMAIL_MAX_ATTEMPTS = 5;

/** Per-window ceilings; see the handlers for which key each one counts. */
export const GUEST_EMAIL_LIMITS = {
    startPerIp: { limit: 20, windowMs: 60 * 60_000 },
    startPerUser: { limit: 5, windowMs: 60 * 60_000 },
    /** Mail to one address, from every guest together: nobody gets flooded. */
    startPerRecipient: { limit: 3, windowMs: 60 * 60_000 },
    confirmPerIp: { limit: 30, windowMs: 15 * 60_000 },
    confirmPerUser: { limit: 10, windowMs: 15 * 60_000 },
} as const;

/** Trimmed and lower-cased: the form stored, compared and mailed. */
export const normalizeGuestEmail = (raw: string): string => raw.trim().toLowerCase();

/** Shape only — the code that arrives (or not) is the real check. */
export const isPlausibleGuestEmail = (email: string): boolean =>
    email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** Digits only: spaces or a dash typed into the field are not a way to fail. */
export const normalizeGuestEmailCode = (raw: string): string => raw.replace(/[\s-]/g, '');

/** Six uniform digits. Bytes past the largest multiple of 10 are discarded, not folded. */
export const generateGuestEmailCode = (): string => {
    let out = '';
    while (out.length < GUEST_EMAIL_CODE_LENGTH) {
        const bytes = new Uint8Array(GUEST_EMAIL_CODE_LENGTH * 2);
        crypto.getRandomValues(bytes);
        for (const byte of bytes) {
            if (out.length === GUEST_EMAIL_CODE_LENGTH) {
                break;
            }
            if (byte < 250) {
                out += String(byte % 10);
            }
        }
    }
    return out;
};

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const hmacHex = async (secret: string, message: string): Promise<string> => {
    if (!secret) {
        // An empty key would make a six-digit code a lookup away from its hash.
        throw new Error('guest email secret is missing');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
};

/** What guest_email_verifications stores: bound to the guest, the address and the code. */
export const hashGuestEmailCode = (secret: string, userId: string, email: string, code: string): Promise<string> =>
    hmacHex(secret, `guest-email-code\u0000${userId}\u0000${email}\u0000${code}`);

/** The per-recipient rate-limit key: edge_rate_buckets never holds an address. */
export const recipientRateKey = async (secret: string, email: string): Promise<string> =>
    `guest-email-to:${(await hmacHex(secret, `guest-email-recipient\u0000${email}`)).slice(0, 40)}`;

export interface GuestEmailMessage {
    subject: string;
    text: string;
    html: string;
}

/** The email itself: the code, what it is for, and what to do if it was not you. */
export const guestEmailMessage = (code: string): GuestEmailMessage => {
    const minutes = Math.round(GUEST_EMAIL_CODE_TTL_MS / 60_000);
    return {
        subject: `${code} is your Cleffy code`,
        text: [
            `Your Cleffy code is ${code}`,
            '',
            `Enter it in Cleffy to save the work you did as a guest to this email address. It expires in ${minutes} minutes.`,
            '',
            'If you did not ask for this, ignore this email: nothing is linked to your address unless the code is entered.',
        ].join('\n'),
        html: [
            '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;line-height:1.5">',
            '<p>Your Cleffy code is</p>',
            `<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:8px 0 16px">${code}</p>`,
            `<p>Enter it in Cleffy to save the work you did as a guest to this email address. It expires in ${minutes} minutes.</p>`,
            '<p style="color:#57534e">If you did not ask for this, ignore this email: nothing is linked to your address unless the code is entered.</p>',
            '</div>',
        ].join(''),
    };
};

/** The refusals the browser can act on, each with a stable code. */
export const GUEST_EMAIL_ERRORS = {
    notGuest: { error: 'This account already has an email address.', code: 'not_guest' },
    invalidEmail: { error: 'Enter a valid email address.', code: 'invalid_email' },
    emailInUse: {
        error: 'An account with this email already exists. Sign in to it instead.',
        code: 'email_in_use',
    },
    unavailable: { error: 'We can’t send email right now. Try again later.', code: 'email_unavailable' },
    sendFailed: { error: 'We couldn’t send the email. Check the address and try again.', code: 'send_failed' },
    invalidCode: { error: 'That code didn’t work. Check the email and try again.', code: 'invalid_code' },
    codeExpired: { error: 'That code has expired. Send a new one.', code: 'code_expired' },
    codeLocked: { error: 'Too many wrong codes. Send a new one.', code: 'code_locked' },
    attachFailed: { error: 'We couldn’t save your email. Try again.', code: 'attach_failed' },
} as const;

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface GuestCaller {
    userId: string;
    isAnonymous: boolean;
}

export type CodeCheck = 'ok' | 'mismatch' | 'locked' | 'expired' | 'missing';

interface CommonDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    /** The caller behind the request's JWT, or the Response refusing it (401/500). */
    authenticate: (req: Request) => Promise<GuestCaller | Response>;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /** Key material for the code HMAC; null on a deploy missing it. */
    secret: () => string | null;
    logError: (message: string, err?: unknown) => void;
}

export interface GuestEmailStartDeps extends CommonDeps {
    /** Whether any account uses the address; null when that could not be answered. */
    emailTaken: (email: string) => Promise<boolean | null>;
    /** Store (replacing any earlier) pending code for the guest; false on failure. */
    savePending: (row: { userId: string; email: string; codeHash: string; expiresAt: string }) => Promise<boolean>;
    deletePending: (userId: string) => Promise<void>;
    /** 'unconfigured' when the deploy has no mail key. */
    sendEmail: (to: string, message: GuestEmailMessage) => Promise<'sent' | 'failed' | 'unconfigured'>;
    generateCode: () => string;
    now: () => number;
}

export interface GuestEmailConfirmDeps extends CommonDeps {
    /** check_guest_email_code; null when the check itself failed. */
    checkCode: (userId: string, email: string, codeHash: string) => Promise<CodeCheck | null>;
    /** Attach email (confirmed) and password to the anonymous user. */
    attach: (
        userId: string,
        email: string,
        password: string,
    ) => Promise<'ok' | 'email_taken' | 'weak_password' | 'failed'>;
    deletePending: (userId: string) => Promise<void>;
    password: Pick<typeof PasswordPolicy, 'passwordProblem' | 'passwordProblemMessage'>;
}

const tooMany = (json: CommonDeps['json'], retryAfterSec: number): Response =>
    json(
        {
            error: `Too many tries. Wait ${retryAfterSec < 90 ? `${retryAfterSec} seconds` : `${Math.ceil(retryAfterSec / 60)} minutes`} and try again.`,
            code: 'rate_limited',
            retryAfterSec,
        },
        429,
    );

/** Method, per-IP gate, then the caller — who must be a guest. Shared by both handlers. */
const admit = async (
    req: Request,
    deps: CommonDeps,
    ipLimit: { limit: number; windowMs: number },
    scope: string,
): Promise<{ ok: true; caller: GuestCaller } | { ok: false; response: Response }> => {
    if (req.method === 'OPTIONS') {
        return { ok: false, response: deps.options() };
    }
    if (req.method !== 'POST') {
        return { ok: false, response: deps.json({ error: 'Method not allowed' }, 405) };
    }
    // Ahead of the auth round-trip, so a flood costs a slot before it costs GoTrue.
    const ipGate = await deps.checkRateLimit(`${scope}:ip:${deps.clientKey(req)}`, ipLimit.limit, ipLimit.windowMs);
    if (!ipGate.ok) {
        return { ok: false, response: tooMany(deps.json, ipGate.retryAfterSec) };
    }
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) {
        return { ok: false, response: caller };
    }
    // A registered account changes its address another way (support, for now);
    // this path exists to turn a guest into an account and nothing else.
    if (!caller.isAnonymous) {
        return { ok: false, response: deps.json(GUEST_EMAIL_ERRORS.notGuest, 403) };
    }
    return { ok: true, caller };
};

const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
        const body: unknown = await req.json();
        return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

/**
 * guest-email-start: `{ email }` → mail a code to it.
 *
 * Refuses an address that already has an account with `email_in_use` — the
 * guest should sign in to it, and the code could never attach anyway. That
 * says no more than sign-up already says about an address, and it is limited
 * per guest, per address and per IP like everything else here.
 */
export const handleGuestEmailStart = async (req: Request, deps: GuestEmailStartDeps): Promise<Response> => {
    const { json } = deps;
    const admitted = await admit(req, deps, GUEST_EMAIL_LIMITS.startPerIp, 'guest-email-start');
    if (!admitted.ok) {
        return admitted.response;
    }
    const { userId } = admitted.caller;

    const userGate = await deps.checkRateLimit(
        `guest-email-start:user:${userId}`,
        GUEST_EMAIL_LIMITS.startPerUser.limit,
        GUEST_EMAIL_LIMITS.startPerUser.windowMs,
    );
    if (!userGate.ok) {
        return tooMany(json, userGate.retryAfterSec);
    }

    const body = await readBody(req);
    const email = normalizeGuestEmail(typeof body?.['email'] === 'string' ? body['email'] : '');
    if (!isPlausibleGuestEmail(email)) {
        return json(GUEST_EMAIL_ERRORS.invalidEmail, 422);
    }

    const secret = deps.secret();
    if (!secret) {
        deps.logError('guest-email-start: no secret to hash codes with');
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const recipientGate = await deps.checkRateLimit(
        await recipientRateKey(secret, email),
        GUEST_EMAIL_LIMITS.startPerRecipient.limit,
        GUEST_EMAIL_LIMITS.startPerRecipient.windowMs,
    );
    if (!recipientGate.ok) {
        return tooMany(json, recipientGate.retryAfterSec);
    }

    const taken = await deps.emailTaken(email);
    if (taken === null) {
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }
    if (taken) {
        return json(GUEST_EMAIL_ERRORS.emailInUse, 409);
    }

    const code = deps.generateCode();
    const saved = await deps.savePending({
        userId,
        email,
        codeHash: await hashGuestEmailCode(secret, userId, email, code),
        expiresAt: new Date(deps.now() + GUEST_EMAIL_CODE_TTL_MS).toISOString(),
    });
    if (!saved) {
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const sent = await deps.sendEmail(email, guestEmailMessage(code));
    if (sent !== 'sent') {
        // A code nobody received must not stay redeemable.
        await deps.deletePending(userId);
        return sent === 'unconfigured'
            ? json(GUEST_EMAIL_ERRORS.unavailable, 503)
            : json(GUEST_EMAIL_ERRORS.sendFailed, 502);
    }
    return json({ sent: true, expiresInSec: Math.round(GUEST_EMAIL_CODE_TTL_MS / 1000) });
};

/**
 * guest-email-confirm: `{ email, code, password }` → attach, once the code
 * matches the address it was sent to.
 *
 * The password is checked first, against the policy GoTrue applies, so a
 * password the server would refuse does not spend one of the code's tries.
 * The pending row goes only after the attach succeeds: a transient failure
 * can be retried with the same code.
 */
export const handleGuestEmailConfirm = async (req: Request, deps: GuestEmailConfirmDeps): Promise<Response> => {
    const { json } = deps;
    const admitted = await admit(req, deps, GUEST_EMAIL_LIMITS.confirmPerIp, 'guest-email-confirm');
    if (!admitted.ok) {
        return admitted.response;
    }
    const { userId } = admitted.caller;

    const userGate = await deps.checkRateLimit(
        `guest-email-confirm:user:${userId}`,
        GUEST_EMAIL_LIMITS.confirmPerUser.limit,
        GUEST_EMAIL_LIMITS.confirmPerUser.windowMs,
    );
    if (!userGate.ok) {
        return tooMany(json, userGate.retryAfterSec);
    }

    const body = await readBody(req);
    const email = normalizeGuestEmail(typeof body?.['email'] === 'string' ? body['email'] : '');
    const code = normalizeGuestEmailCode(typeof body?.['code'] === 'string' ? body['code'] : '');
    // Exactly as typed — never trimmed: it is what GoTrue stores the hash of.
    const password = typeof body?.['password'] === 'string' ? body['password'] : '';

    if (!isPlausibleGuestEmail(email)) {
        return json(GUEST_EMAIL_ERRORS.invalidEmail, 422);
    }
    const problem = deps.password.passwordProblem(password);
    if (problem) {
        return json({ error: deps.password.passwordProblemMessage(problem), code: 'weak_password' }, 422);
    }
    if (!/^\d+$/.test(code) || code.length !== GUEST_EMAIL_CODE_LENGTH) {
        return json(GUEST_EMAIL_ERRORS.invalidCode, 400);
    }

    const secret = deps.secret();
    if (!secret) {
        deps.logError('guest-email-confirm: no secret to hash codes with');
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const check = await deps.checkCode(userId, email, await hashGuestEmailCode(secret, userId, email, code));
    switch (check) {
        case 'ok':
            break;
        case 'mismatch':
            return json(GUEST_EMAIL_ERRORS.invalidCode, 400);
        case 'locked':
            return json(GUEST_EMAIL_ERRORS.codeLocked, 410);
        case 'expired':
        case 'missing':
            return json(GUEST_EMAIL_ERRORS.codeExpired, 410);
        default:
            return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const attached = await deps.attach(userId, email, password);
    switch (attached) {
        case 'ok':
            await deps.deletePending(userId);
            return json({ ok: true, email });
        case 'email_taken':
            // Someone registered the address between start and confirm.
            await deps.deletePending(userId);
            return json(GUEST_EMAIL_ERRORS.emailInUse, 409);
        case 'weak_password':
            // GoTrue's policy is stricter than passwordPolicy.ts thought (or the
            // password is breached): the code stays good for another password.
            return json({ error: 'That password was refused. Choose a different one.', code: 'weak_password' }, 422);
        default:
            return json(GUEST_EMAIL_ERRORS.attachFailed, 502);
    }
};
