import type * as PasswordPolicy from '../_shared/passwordPolicy.ts';
import type { readCappedJson } from '../_shared/readCappedJson.ts';

/**
 * share-invite-accept (Share v2, #104, D5): /invite#<token> shows who invited
 * the visitor to which score (peek), and accepting it gives them the score.
 *
 * A signed-in account with the invite's address accepts in one step. Anyone
 * else creates that account here: the age screen's answer and a password, then
 * the account is made confirmed (the token arriving in the mailbox proved the
 * address) and the invite attached; if the attach fails, the new account is
 * deleted again. An address that already has an account must sign in first.
 * No JWT required (supabase/config.toml); an anonymous guest's is ignored.
 */

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export type PeekResult =
    | { state: 'expired' | 'used' | 'cancelled' | 'invalid' }
    | { state: 'pending'; title: string | null; inviter_name: string | null; role: 'viewer' | 'editor'; email: string };

export type ConsumeResult = { ok: true; document_id: string } | { ok: false; state: string };

export interface ShareInviteAcceptDeps {
    enabled: () => boolean;
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    readJson: typeof readCappedJson;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /** The signed-in, non-anonymous caller behind the request's JWT, or null. */
    signedInUser: (req: Request) => Promise<{ userId: string; email: string | null } | null>;
    /** share_invite_peek; null when it failed. */
    peek: (tokenHash: string) => Promise<PeekResult | null>;
    /** share_invite_consume; null when it failed. */
    consume: (tokenHash: string, userId: string) => Promise<ConsumeResult | null>;
    /** guest_email_taken; null when it failed. */
    emailTaken: (email: string) => Promise<boolean | null>;
    /** age_gate_problem_for({age_gate}, false): null passes; 'unknown' when it could not be asked. */
    ageGateProblem: (gate: Record<string, unknown>) => Promise<string | null>;
    password: Pick<typeof PasswordPolicy, 'passwordProblem' | 'passwordProblemMessage'>;
    createUser: (args: {
        email: string;
        password: string;
        ageGate: Record<string, unknown>;
    }) => Promise<{ ok: true; userId: string } | { ok: false; reason: 'email_exists' | 'weak_password' | 'failed' }>;
    deleteUser: (userId: string) => Promise<void>;
}

export const BODY_MAX_BYTES = 4 * 1024;
export const ACCEPT_LIMIT = { limit: 20, windowMs: 10 * 60_000 };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

export const inviteTokenHash = async (token: string): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');

/** `j***@e***.com`: enough for the visitor to recognise their address, not enough to read it off a screen. */
export const maskEmail = (email: string): string => {
    const at = email.lastIndexOf('@');
    if (at < 1) {
        return '***';
    }
    const labels = email.slice(at + 1).split('.');
    const tld = labels.length > 1 ? `.${labels.at(-1)}` : '';
    return `${email[0]}***@${(labels[0] ?? '').slice(0, 1)}***${tld}`;
};

export const handleShareInviteAccept = async (req: Request, deps: ShareInviteAcceptDeps): Promise<Response> => {
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

    const read = await deps.readJson(req, BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413
            ? json({ error: 'Request body too large', code: 'payload_too_large' }, 413)
            : json({ error: 'bad_request' }, 400);
    }
    const body = read.value && typeof read.value === 'object' ? (read.value as Record<string, unknown>) : {};
    const action = body['action'];
    if (action !== 'peek' && action !== 'accept') {
        return json({ error: 'bad_request' }, 400);
    }
    const token = body['token'];
    if (typeof token !== 'string' || !TOKEN.test(token)) {
        return action === 'peek' ? json({ state: 'invalid' }) : json({ state: 'invalid' }, 404);
    }

    const tokenHash = await inviteTokenHash(token);
    const gate = await deps.checkRateLimit(
        `share-invite-accept:${tokenHash}`,
        ACCEPT_LIMIT.limit,
        ACCEPT_LIMIT.windowMs,
    );
    if (!gate.ok) {
        return json({ error: 'rate_limited', retry_after: gate.retryAfterSec }, 429);
    }

    const invite = await deps.peek(tokenHash);
    if (!invite) {
        return json({ error: 'unavailable' }, 503);
    }
    if (action === 'peek') {
        return invite.state === 'pending'
            ? json({
                  state: 'pending',
                  title: invite.title,
                  inviter_name: invite.inviter_name,
                  role: invite.role,
                  email_masked: maskEmail(invite.email),
              })
            : json({ state: invite.state });
    }
    if (invite.state !== 'pending') {
        return json({ state: invite.state }, 410);
    }

    const finish = (result: ConsumeResult | null): Response =>
        !result
            ? json({ error: 'unavailable' }, 503)
            : result.ok
              ? json({ ok: true, document_id: result.document_id })
              : result.state === 'email_mismatch'
                ? json({ error: 'email_mismatch' }, 409)
                : json({ state: result.state }, 410);

    const user = await deps.signedInUser(req);
    if (user) {
        if ((user.email ?? '').toLowerCase() !== invite.email) {
            return json({ error: 'email_mismatch' }, 409);
        }
        return finish(await deps.consume(tokenHash, user.userId));
    }

    const taken = await deps.emailTaken(invite.email);
    if (taken === null) {
        return json({ error: 'unavailable' }, 503);
    }
    if (taken) {
        return json({ error: 'sign_in_required' }, 409);
    }

    const ageGate = body['age_gate'];
    if (!ageGate || typeof ageGate !== 'object' || Array.isArray(ageGate)) {
        return json({ error: 'age_check_missing' }, 400);
    }
    const ageProblem = await deps.ageGateProblem(ageGate as Record<string, unknown>);
    if (ageProblem === 'unknown') {
        return json({ error: 'unavailable' }, 503);
    }
    if (ageProblem === 'below_consent_age') {
        return json({ error: 'below_consent_age' }, 403);
    }
    if (ageProblem !== null) {
        return json({ error: 'age_check_missing' }, 400);
    }

    // Exactly as typed — never trimmed: it is what GoTrue stores the hash of.
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const weak = deps.password.passwordProblem(password);
    if (weak) {
        return json({ error: 'weak_password', message: deps.password.passwordProblemMessage(weak) }, 400);
    }

    const created = await deps.createUser({
        email: invite.email,
        password,
        ageGate: ageGate as Record<string, unknown>,
    });
    if (!created.ok) {
        return created.reason === 'email_exists'
            ? json({ error: 'sign_in_required' }, 409)
            : created.reason === 'weak_password'
              ? json({ error: 'weak_password', message: 'That password was refused. Choose a different one.' }, 400)
              : json({ error: 'unavailable' }, 502);
    }

    const consumed = await deps.consume(tokenHash, created.userId);
    if (!consumed?.ok) {
        await deps.deleteUser(created.userId);
    }
    return finish(consumed);
};
