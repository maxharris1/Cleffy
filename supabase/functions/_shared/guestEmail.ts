import type * as PasswordPolicy from './passwordPolicy.ts';

/**
 * A share-link guest attaching an email address (and a password) to their
 * anonymous account — proven by a one-time code sent to that address.
 *
 * Why this exists: the upgrade banner used to call
 * `supabase.auth.updateUser({ email })` from the browser. Both projects ran
 * with `mailer_autoconfirm` on, which confirms an email CHANGE as instantly as
 * a sign-up, so a guest could claim any address with no mail sent: the real
 * owner then hit "an account with this email already exists", and a password
 * reset to the address would hand the guest's account to its mailbox. The
 * address must be proven before it is attached, whatever the auth settings
 * say — which is the point, and why production turning sign-up confirmation on
 * (`mailer_autoconfirm = false`, October 2026) changes nothing here: this flow
 * never depended on the setting being one way, and a project where an admin
 * flips it back must not become a flow that hands out somebody's address.
 * So the browser no longer attaches anything. guest-email-start mails a
 * code; guest-email-confirm checks it and only then sets the email (marked
 * confirmed: it now is) and the password through the admin API, which also
 * turns the anonymous user into a registered one with the same id, so every
 * membership and mark the guest made stays theirs. It also deletes all of
 * that user's sessions (an admin password change logs out everywhere), so the
 * client signs in again with the new email and password afterwards.
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
 * per-recipient send limits below, guessing at someone else's address is at
 * most 50 tries a day against a million codes (under 2% a year of trying
 * nonstop) — and every fresh code mails that person.
 */
export const GUEST_EMAIL_MAX_ATTEMPTS = 5;

/** Per-window ceilings; see the handlers for which key each one counts. */
export const GUEST_EMAIL_LIMITS = {
    startPerIp: { limit: 20, windowMs: 60 * 60_000 },
    startPerUser: { limit: 5, windowMs: 60 * 60_000 },
    /**
     * Mail to one address, from every guest together: nobody gets flooded.
     * Spent only on a code actually mailed, so asking about an address that
     * has an account cannot use up its owner's allowance, and neither can a
     * send that failed (handleGuestEmailStart reserves, then refunds).
     */
    startPerRecipient: { limit: 3, windowMs: 60 * 60_000 },
    startPerRecipientDaily: { limit: 10, windowMs: 24 * 60 * 60_000 },
    confirmPerIp: { limit: 30, windowMs: 15 * 60_000 },
    confirmPerUser: { limit: 10, windowMs: 15 * 60_000 },
} as const;

/** Trimmed and lower-cased: the form stored, compared and mailed. */
export const normalizeGuestEmail = (raw: string): string => raw.trim().toLowerCase();

/**
 * badoux/checkmail's ValidateFormat, the rule GoTrue's validateEmail applies
 * when guest-email-confirm attaches the address: an ASCII local part, and
 * letter-digit-hyphen labels with no leading, trailing or empty one.
 */
const GOTRUE_EMAIL_FORMAT =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * An address the attach can take — GoTrue's own format rule, plus a dot in the
 * domain — checked before anything is mailed. A looser test let through
 * strings GoTrue refuses ('Name <a@b.com>', '"a"@b.com', 'a@b.com.',
 * non-ASCII): each got a code, mailed verbatim (Resend parses the `Name <…>`
 * form) under a per-recipient allowance of its own spelling, and then could
 * never attach. Shape only beyond that: the code that arrives (or not) is the
 * real check.
 */
export const isPlausibleGuestEmail = (email: string): boolean =>
    email.length >= 3 && email.length <= 254 && GOTRUE_EMAIL_FORMAT.test(email) && /@.+\./.test(email);

/**
 * The mailbox an address reaches, for counting mail to it: the normalized
 * address with any `+tag` dropped, which most providers deliver to the same
 * inbox. Only ever a rate-limit key — what is mailed and attached is the
 * address as typed (normalized).
 */
export const guestEmailMailbox = (email: string): string => {
    const at = email.lastIndexOf('@');
    const local = email.slice(0, at);
    const plus = local.indexOf('+');
    return plus > 0 ? `${local.slice(0, plus)}${email.slice(at)}` : email;
};

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

/**
 * The per-recipient rate-limit key, of the mailbox (guestEmailMailbox) rather
 * than the spelling: edge_rate_buckets never holds an address.
 */
export const recipientRateKey = async (secret: string, email: string, window = 'hour'): Promise<string> =>
    `guest-email-to${window === 'hour' ? '' : `-${window}`}:${(await hmacHex(secret, `guest-email-recipient\u0000${guestEmailMailbox(email)}`)).slice(0, 40)}`;

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
    /**
     * The three Turnstile refusals. Their codes are restated from
     * `_shared/turnstile.ts` rather than imported — this file takes no runtime
     * imports — and `tests/security/turnstile.test.ts` holds the two lists
     * equal, so a code renamed there cannot drift away from the copy here.
     *
     * Worth the three separate sentences: "solve it again" and "this is our
     * problem, wait a moment" are different instructions, and a guest told the
     * wrong one either retries a challenge that cannot pass or gives up on one
     * that would.
     */
    captchaMissing: { error: 'Finish the “I’m human” check, then try again.', code: 'captcha_missing' },
    captchaFailed: { error: 'That “I’m human” check didn’t go through. Try it again.', code: 'captcha_failed' },
    captchaUnavailable: {
        error: 'We can’t run the “I’m human” check right now. Try again in a moment.',
        code: 'captcha_unavailable',
    },
} as const;

/**
 * The Turnstile verdict for a request, as `_shared/turnstile.ts` reports it.
 *
 * Declared structurally here instead of imported, for the no-runtime-imports
 * reason above; `verifyTurnstileRequest`'s real return type is assignable to
 * it. Note the shape: a refusal is the ONLY `ok: false`, so the gate below is a
 * single guard, and `verified: false` with `ok: true` can mean one thing only —
 * no `TURNSTILE_SECRET_KEY` on this deploy, nothing was checked, carry on
 * exactly as before Turnstile existed.
 */
export type CaptchaVerdict =
    | { ok: true; verified: boolean }
    | { ok: false; code: 'captcha_missing' | 'captcha_failed' | 'captcha_unavailable'; status: number };

const CAPTCHA_REFUSALS = {
    captcha_missing: GUEST_EMAIL_ERRORS.captchaMissing,
    captcha_failed: GUEST_EMAIL_ERRORS.captchaFailed,
    captcha_unavailable: GUEST_EMAIL_ERRORS.captchaUnavailable,
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
    /**
     * Verify the request's Turnstile token (`captchaToken` in the body) —
     * `verifyTurnstileRequest` from `_shared/turnstileVerify.ts`. A deploy with
     * no `TURNSTILE_SECRET_KEY` admits, so this is inert until the keys are
     * set. Required rather than optional deliberately: a gate that can be
     * forgotten at the wiring is a gate that will be.
     */
    verifyCaptcha: (req: Request, body: Record<string, unknown> | null) => Promise<CaptchaVerdict>;
    /**
     * What this sender may spend of the project's mail budget, per window —
     * `mailLimit('guestEmailCode', …)` from `_shared/mailBudget.ts`, which is
     * where the numbers and the reserve held back for password resets and
     * sign-up confirmations are declared and justified. It arrives through
     * `deps` because that module cannot be imported from here (no runtime
     * imports), and because the limit is a property of the project's mail
     * quota rather than of this flow.
     */
    mailBudget: { hour: { limit: number; windowMs: number }; day: { limit: number; windowMs: number } };
    /** Whether any account uses the address (guest_email_taken); null when that could not be answered. */
    emailTaken: (email: string) => Promise<boolean | null>;
    /** Store (replacing any earlier) pending code for the guest; false on failure. */
    savePending: (row: { userId: string; email: string; codeHash: string; expiresAt: string }) => Promise<boolean>;
    deletePending: (userId: string) => Promise<void>;
    /** 'unconfigured' when the deploy has no mail key. */
    sendEmail: (to: string, message: GuestEmailMessage) => Promise<'sent' | 'failed' | 'unconfigured'>;
    /** Hand back one use of a checkRateLimit bucket (refund_edge_rate_limit); best effort. */
    refundRateLimit: (key: string) => Promise<void>;
    generateCode: () => string;
    now: () => number;
}

export interface GuestEmailConfirmDeps extends CommonDeps {
    /** As for start: asked again, since the address may have been registered since the code went out. */
    emailTaken: (email: string) => Promise<boolean | null>;
    /** check_guest_email_code; null when the check itself failed. */
    checkCode: (userId: string, email: string, codeHash: string) => Promise<CodeCheck | null>;
    /** Attach email (confirmed) and password to the anonymous user. */
    attach: (
        userId: string,
        email: string,
        password: string,
    ) => Promise<'ok' | 'email_taken' | 'weak_password' | 'invalid_email' | 'failed'>;
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
 * per guest, per address and per IP like everything else here — and now sits
 * behind the Turnstile gate as well, so it is not an oracle a script can read.
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

    // The Turnstile gate, and this is the place for it.
    //
    // AFTER the per-IP and per-guest limits above, so a flood is already
    // costing the attacker a counted slot before it costs Cloudflare a
    // verification — a gate placed ahead of them would turn every request into
    // an outbound siteverify call we pay for, which is a cheaper thing to
    // flood than the thing we are protecting. After the address-shape check
    // too, since that is a pure local test the browser can run itself and
    // reveals nothing: spending a verification on a malformed address is
    // waste.
    //
    // And BEFORE everything that follows, which is the part that matters:
    // `emailTaken` is the one oracle this endpoint has ("does this address
    // have an account?"), and the save and the send are the two things that
    // cost us. Nothing past this line runs for a caller who cannot produce a
    // token, which is what makes this the gate on the abuse path rather than a
    // decoration in front of it.
    const captcha = await deps.verifyCaptcha(req, body);
    if (!captcha.ok) {
        return json(CAPTCHA_REFUSALS[captcha.code], captcha.status);
    }

    const secret = deps.secret();
    if (!secret) {
        deps.logError('guest-email-start: no secret to hash codes with');
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const taken = await deps.emailTaken(email);
    if (taken === null) {
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }
    if (taken) {
        return json(GUEST_EMAIL_ERRORS.emailInUse, 409);
    }

    // The mailbox's and the project's allowances are for mail that went out.
    // Each is RESERVED here, before the send — so two requests at once cannot
    // both take the last one — and every reservation is handed back if no
    // mail goes out after all: a later limit refused, the code could not be
    // stored, or the send failed or is not configured. (The per-IP and
    // per-guest limits above stay spent: they count attempts, and are what
    // stops a caller hammering a broken mailer.)
    const reserved: string[] = [];
    const release = async (): Promise<void> => {
        await Promise.all(reserved.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
    };

    for (const [window, { limit, windowMs }] of [
        ['hour', GUEST_EMAIL_LIMITS.startPerRecipient],
        ['day', GUEST_EMAIL_LIMITS.startPerRecipientDaily],
    ] as const) {
        const key = await recipientRateKey(secret, email, window);
        const recipientGate = await deps.checkRateLimit(key, limit, windowMs);
        if (!recipientGate.ok) {
            await release();
            return tooMany(json, recipientGate.retryAfterSec);
        }
        reserved.push(key);
    }

    // And the project's share of the mail budget: past it, nobody's code goes
    // out until the window moves on. Said as the mail being unavailable — it
    // is not this guest's doing, and trying again sooner cannot help.
    //
    // These two ceilings are no longer this flow's to choose. They come from
    // `_shared/mailBudget.ts` through `deps.mailBudget`, which declares what
    // the whole project may send and holds a reserve back for password resets
    // and sign-up confirmations — mail someone is locked out without. Every
    // other limit in this file protects a person (a mailbox, a guest, an IP);
    // this one protects the mail that is not ours to spend.
    for (const [key, { limit, windowMs }] of [
        ['guest-email-start:global', deps.mailBudget.hour],
        ['guest-email-start:global-day', deps.mailBudget.day],
    ] as const) {
        const globalGate = await deps.checkRateLimit(key, limit, windowMs);
        if (!globalGate.ok) {
            await release();
            deps.logError(`${key}: the ceiling on guest code mail was reached`);
            return json({ ...GUEST_EMAIL_ERRORS.unavailable, retryAfterSec: globalGate.retryAfterSec }, 503);
        }
        reserved.push(key);
    }

    const code = deps.generateCode();
    const saved = await deps.savePending({
        userId,
        email,
        codeHash: await hashGuestEmailCode(secret, userId, email, code),
        expiresAt: new Date(deps.now() + GUEST_EMAIL_CODE_TTL_MS).toISOString(),
    });
    if (!saved) {
        await release();
        return json(GUEST_EMAIL_ERRORS.unavailable, 503);
    }

    const sent = await deps.sendEmail(email, guestEmailMessage(code));
    if (sent !== 'sent') {
        // A code nobody received must not stay redeemable, nor count as mail.
        await Promise.all([deps.deletePending(userId), release()]);
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
 *
 * The address may have been registered since the code went out. GoTrue's
 * admin update has no duplicate-email check (only admin create does): the
 * clash surfaces as a unique-index violation, reported as a generic database
 * error. So the address is asked about again before the attach, and once
 * more after a failed one, and a clash either time is answered "sign in
 * instead" with the code withdrawn — not a retry that can never succeed.
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

    const emailInUse = async (): Promise<Response> => {
        await deps.deletePending(userId);
        return json(GUEST_EMAIL_ERRORS.emailInUse, 409);
    };
    // Unknown (null) goes ahead: the attach itself cannot take a used address.
    if ((await deps.emailTaken(email)) === true) {
        return emailInUse();
    }

    const attached = await deps.attach(userId, email, password);
    switch (attached) {
        case 'ok':
            await deps.deletePending(userId);
            return json({ ok: true, email });
        case 'email_taken':
            // Someone registered the address between start and confirm.
            return emailInUse();
        case 'weak_password':
            // GoTrue's policy is stricter than passwordPolicy.ts thought (or the
            // password is breached): the code stays good for another password.
            return json({ error: 'That password was refused. Choose a different one.', code: 'weak_password' }, 422);
        case 'invalid_email':
            // GoTrue will never take this address, whatever is retried: say so
            // and withdraw the code. (start refuses such an address now; a code
            // mailed before it did can still arrive here.)
            await deps.deletePending(userId);
            return json(GUEST_EMAIL_ERRORS.invalidEmail, 422);
        default:
            // The same race, lost inside GoTrue: its message says only "Database error".
            if ((await deps.emailTaken(email)) === true) {
                return emailInUse();
            }
            return json(GUEST_EMAIL_ERRORS.attachFailed, 502);
    }
};
