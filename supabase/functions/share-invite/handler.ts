import { guestEmailMailbox, isPlausibleGuestEmail, normalizeGuestEmail } from '../_shared/guestEmail.ts';
import type { MailWindow } from '../_shared/mailBudget.ts';
import type { readCappedJson } from '../_shared/readCappedJson.ts';

/**
 * share-invite (Share v2, #104): the owner of a score invites an email
 * address as a viewer or an editor ("Specific people").
 *
 * The database decides what happens (share_invite_create, 20261113120200): an
 * existing account becomes a member at once, a new address gets a pending
 * invite whose token is only in the email, and a roster student's address is
 * refused unless the owner is their teacher (D7). The owner hears {ok:true}
 * either way, so the answer never says whether an address has an account
 * (R9). Ownership is checked twice: under the caller's own JWT
 * (share_owner_ready), then again inside every service-role RPC.
 */

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface InviteCaller {
    userId: string;
    isAnonymous: boolean;
    userType: 'student' | null;
    /** share_owner_ready under the caller's JWT; false for any refusal or error. */
    ownerReady: (documentId: string) => Promise<boolean>;
}

export type RpcResult<T> = { ok: true; data: T } | { ok: false; code: string | null };

export type CreateResult =
    | { kind: 'roster_refused' }
    | { kind: 'member'; title: string | null; inviter_name: string | null }
    | { kind: 'invite'; invite_id: string; title: string | null; inviter_name: string | null };

export interface ReissueResult {
    invite_id: string;
    email: string;
    role: 'viewer' | 'editor';
    title: string | null;
    inviter_name: string | null;
}

export interface InviteMessage {
    subject: string;
    text: string;
    html: string;
}

export interface ShareInviteDeps {
    enabled: () => boolean;
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    readJson: typeof readCappedJson;
    authenticate: (req: Request) => Promise<InviteCaller | Response>;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    refundRateLimit: (key: string) => Promise<void>;
    /** Key material for the recipient bucket's HMAC; null on a deploy missing it. */
    secret: () => string | null;
    mailBudget: { hour: MailWindow; day: MailWindow };
    createInvite: (args: {
        caller: string;
        documentId: string;
        email: string;
        role: 'viewer' | 'editor';
        tokenHash: string;
    }) => Promise<RpcResult<CreateResult>>;
    /** null data: nothing pending to resend. */
    reissueInvite: (caller: string, inviteId: string, tokenHash: string) => Promise<RpcResult<ReissueResult | null>>;
    cancelInvite: (caller: string, inviteId: string) => Promise<RpcResult<boolean>>;
    sendEmail: (
        to: string,
        message: InviteMessage,
        idempotencyKey: string,
    ) => Promise<{ outcome: 'sent' | 'rejected' | 'unknown'; reason: string }>;
    idempotencyKey: (outbox: string, rowId: string) => string;
    siteUrl: string;
    /** 32 random bytes. */
    randomToken: () => Uint8Array;
}

export const BODY_MAX_BYTES = 4 * 1024;
export const INVITE_LIMITS = {
    perOwner: { limit: 30, windowMs: 60 * 60_000 },
    perRecipient: { limit: 3, windowMs: 24 * 60 * 60_000 },
} as const;
export const INVITE_MAIL_OUTBOX = 'share-invite';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const base64url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** sha256 of the token as text, hex: what document_invites.token_hash stores (as bytea). */
export const inviteTokenHash = async (token: string): Promise<string> =>
    toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));

const hmacHex = async (secret: string, message: string): Promise<string> => {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
};

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const oneLine = (value: string | null, fallback: string): string => {
    const line = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return line || fallback;
};

/** The email: who shared what, as which role, and the one link to open. */
export const inviteMessage = (args: {
    inviterName: string | null;
    title: string | null;
    role: 'viewer' | 'editor';
    url: string;
    pending: boolean;
}): InviteMessage => {
    const inviter = oneLine(args.inviterName, 'Someone');
    const title = oneLine(args.title, 'a score');
    const can = args.role === 'editor' ? 'view and mark up' : 'view';
    const lead = `${inviter} shared “${title}” with you on Cleffy. You can ${can} it.`;
    const action = args.pending ? 'Accept the invitation' : 'Open the score';
    const after = args.pending
        ? 'The invitation expires in 14 days. If you weren’t expecting it, you can ignore this email.'
        : 'You can find it in your Cleffy library.';
    return {
        subject: `${inviter} shared “${title}” with you`,
        text: [lead, '', `${action}: ${args.url}`, '', after].join('\n'),
        html: [
            '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;line-height:1.5">',
            `<p>${escapeHtml(lead)}</p>`,
            `<p><a href="${escapeHtml(args.url)}">${escapeHtml(action)}</a></p>`,
            `<p style="color:#57534e">${escapeHtml(after)}</p>`,
            '</div>',
        ].join(''),
    };
};

const tooMany = (json: ShareInviteDeps['json'], retryAfterSec: number): Response =>
    json({ error: 'rate_limited', retry_after: retryAfterSec }, 429);

const refusal = (json: ShareInviteDeps['json'], code: string | null): Response =>
    code === '42501' || code === '28000'
        ? json({ error: 'not_owner' }, 403)
        : code === '22023'
          ? json({ error: 'invalid_request' }, 422)
          : json({ error: 'unavailable' }, 503);

export const handleShareInvite = async (req: Request, deps: ShareInviteDeps): Promise<Response> => {
    const { json } = deps;
    if (!deps.enabled()) {
        return json({ error: 'not_found' }, 404);
    }
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    const caller = await deps.authenticate(req);
    if (caller instanceof Response) {
        return caller;
    }
    if (caller.isAnonymous) {
        return json({ error: 'Create an account to share a score', code: 'anonymous_session' }, 403);
    }
    if (caller.userType === 'student') {
        return json({ error: 'Student accounts are managed by your teacher', code: 'student_account' }, 403);
    }

    const read = await deps.readJson(req, BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413
            ? json({ error: 'Request body too large', code: 'payload_too_large' }, 413)
            : json({ error: 'bad_request' }, 400);
    }
    const body = read.value && typeof read.value === 'object' ? (read.value as Record<string, unknown>) : {};
    const action = body['action'];
    const documentId = typeof body['document_id'] === 'string' ? body['document_id'] : '';
    if ((action !== 'invite' && action !== 'resend' && action !== 'cancel') || !UUID.test(documentId)) {
        return json({ error: 'bad_request' }, 400);
    }
    const inviteId = typeof body['invite_id'] === 'string' ? body['invite_id'] : '';
    if (action !== 'invite' && !UUID.test(inviteId)) {
        return json({ error: 'bad_request' }, 400);
    }

    if (!(await caller.ownerReady(documentId))) {
        return json({ error: 'not_owner' }, 403);
    }

    if (action === 'cancel') {
        const cancelled = await deps.cancelInvite(caller.userId, inviteId);
        return cancelled.ok ? json({ ok: true, cancelled: cancelled.data === true }) : refusal(json, cancelled.code);
    }

    const ownerGate = await deps.checkRateLimit(
        `share-invite:user:${caller.userId}`,
        INVITE_LIMITS.perOwner.limit,
        INVITE_LIMITS.perOwner.windowMs,
    );
    if (!ownerGate.ok) {
        return tooMany(json, ownerGate.retryAfterSec);
    }

    const secret = deps.secret();
    if (!secret) {
        return json({ error: 'unavailable' }, 503);
    }

    // Reserved before the send and handed back if no mail can have gone out,
    // as guest-email-start does.
    const reserved: string[] = [];
    const release = async (): Promise<void> => {
        await Promise.all(reserved.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
    };
    const reserve = async (key: string, limit: number, windowMs: number): Promise<Response | null> => {
        const gate = await deps.checkRateLimit(key, limit, windowMs);
        if (!gate.ok) {
            await release();
            return tooMany(json, gate.retryAfterSec);
        }
        reserved.push(key);
        return null;
    };
    const reserveRecipient = async (email: string): Promise<Response | null> =>
        reserve(
            `share-invite:to:${(await hmacHex(secret, `share-invite-recipient\u0000${guestEmailMailbox(email)}`)).slice(0, 40)}`,
            INVITE_LIMITS.perRecipient.limit,
            INVITE_LIMITS.perRecipient.windowMs,
        );
    const reserveBudget = async (): Promise<Response | null> =>
        (await reserve('mail:share-invite:hour', deps.mailBudget.hour.limit, deps.mailBudget.hour.windowMs)) ??
        (await reserve('mail:share-invite:day', deps.mailBudget.day.limit, deps.mailBudget.day.windowMs));

    const token = base64url(deps.randomToken());
    const tokenHash = await inviteTokenHash(token);
    const send = async (to: string, message: InviteMessage): Promise<Response> => {
        const sent = await deps.sendEmail(
            to,
            message,
            deps.idempotencyKey(
                INVITE_MAIL_OUTBOX,
                (await hmacHex(secret, `share-invite-send\u0000${tokenHash}`)).slice(0, 40),
            ),
        );
        if (sent.outcome === 'sent') {
            return json({ ok: true });
        }
        if (sent.outcome === 'rejected') {
            await release();
        }
        return json({ error: 'send_failed' }, 502);
    };

    if (action === 'resend') {
        const budget = await reserveBudget();
        if (budget) {
            return budget;
        }
        const reissued = await deps.reissueInvite(caller.userId, inviteId, tokenHash);
        if (!reissued.ok || !reissued.data) {
            await release();
            return reissued.ok ? json({ error: 'not_pending' }, 404) : refusal(json, reissued.code);
        }
        const recipient = await reserveRecipient(reissued.data.email);
        if (recipient) {
            return recipient;
        }
        return send(
            reissued.data.email,
            inviteMessage({
                inviterName: reissued.data.inviter_name,
                title: reissued.data.title,
                role: reissued.data.role,
                url: `${deps.siteUrl}/invite#${token}`,
                pending: true,
            }),
        );
    }

    const email = normalizeGuestEmail(typeof body['email'] === 'string' ? body['email'] : '');
    const role = body['role'] ?? 'viewer';
    if (!isPlausibleGuestEmail(email)) {
        return json({ error: 'invalid_email' }, 422);
    }
    if (role !== 'viewer' && role !== 'editor') {
        return json({ error: 'invalid_role' }, 422);
    }

    const limited = (await reserveRecipient(email)) ?? (await reserveBudget());
    if (limited) {
        return limited;
    }

    const created = await deps.createInvite({ caller: caller.userId, documentId, email, role, tokenHash });
    if (!created.ok) {
        await release();
        return refusal(json, created.code);
    }
    if (created.data.kind === 'roster_refused') {
        await release();
        return json(
            {
                error: 'cannot_invite',
                hint: 'assign',
                message: 'This address can’t be invited here. If they’re your student, use Assign instead.',
            },
            403,
        );
    }
    const pending = created.data.kind === 'invite';
    return send(
        email,
        inviteMessage({
            inviterName: created.data.inviter_name,
            title: created.data.title,
            role,
            url: pending ? `${deps.siteUrl}/invite#${token}` : `${deps.siteUrl}/doc/${documentId}`,
            pending,
        }),
    );
};
