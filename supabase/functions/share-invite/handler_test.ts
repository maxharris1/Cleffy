import { readCappedJson } from '../_shared/readCappedJson.ts';
import { resendIdempotencyKey } from '../_shared/resendDelivery.ts';
import {
    base64url,
    type CreateResult,
    handleShareInvite,
    type InviteCaller,
    inviteTokenHash,
    type ReissueResult,
    type RpcResult,
    type ShareInviteDeps,
} from './handler.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const OWNER = '0c0e0000-0000-4000-8000-000000000001';
const DOC = '0d0c0000-0000-4000-8000-000000000001';
const INVITE = '01e10000-0000-4000-8000-000000000001';
const TOKEN_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const TOKEN = base64url(TOKEN_BYTES);

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown) =>
    new Request('https://edge.test/functions/v1/share-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt' },
        body: JSON.stringify(body),
    });

const invite = (extra: Record<string, unknown> = {}) => ({
    action: 'invite',
    document_id: DOC,
    email: ' Ada@Example.com ',
    role: 'editor',
    ...extra,
});

const harness = (
    options: {
        enabled?: boolean;
        caller?: Partial<InviteCaller> | Response;
        owner?: boolean;
        create?: RpcResult<CreateResult>;
        reissue?: RpcResult<ReissueResult | null>;
        pendingEmail?: RpcResult<string | null>;
        send?: 'sent' | 'rejected' | 'unknown';
        refuse?: string;
    } = {},
) => {
    const calls: string[] = [];
    const rpcArgs: unknown[] = [];
    const reserved: string[] = [];
    const refunded: string[] = [];
    const mail: { to: string; subject: string; text: string; html: string }[] = [];
    const caller: InviteCaller | Response =
        options.caller instanceof Response
            ? options.caller
            : {
                  userId: OWNER,
                  isAnonymous: false,
                  userType: null,
                  ownerReady: (doc) => {
                      calls.push(`owner:${doc}`);
                      return Promise.resolve(options.owner ?? true);
                  },
                  pendingInviteEmail: (inviteId) => {
                      calls.push(`pending:${inviteId}`);
                      return Promise.resolve(options.pendingEmail ?? { ok: true, data: 'ada@example.com' });
                  },
                  ...options.caller,
              };
    const deps: ShareInviteDeps = {
        enabled: () => options.enabled ?? true,
        json,
        options: () => new Response('ok'),
        readJson: readCappedJson,
        authenticate: () => Promise.resolve(caller),
        checkRateLimit: (key) => {
            calls.push(`rate:${key.split(':').slice(0, 2).join(':')}`);
            if (options.refuse && key.startsWith(options.refuse)) {
                return Promise.resolve({ ok: false as const, retryAfterSec: 60 });
            }
            reserved.push(key);
            return Promise.resolve({ ok: true as const });
        },
        refundRateLimit: (key) => {
            refunded.push(key);
            return Promise.resolve();
        },
        secret: () => 'share-invite-test-secret',
        mailBudget: { hour: { limit: 10, windowMs: 3_600_000 }, day: { limit: 50, windowMs: 86_400_000 } },
        createInvite: (args) => {
            calls.push('create');
            rpcArgs.push(args);
            return Promise.resolve(
                options.create ?? {
                    ok: true,
                    data: { kind: 'invite', invite_id: INVITE, title: 'Sonata', inviter_name: 'Max' },
                },
            );
        },
        reissueInvite: (callerId, inviteId, tokenHash) => {
            calls.push('reissue');
            rpcArgs.push({ callerId, inviteId, tokenHash });
            return Promise.resolve(
                options.reissue ?? {
                    ok: true,
                    data: {
                        kind: 'invite',
                        invite_id: INVITE,
                        email: 'ada@example.com',
                        role: 'viewer',
                        title: 'Sonata',
                        inviter_name: 'Max',
                    },
                },
            );
        },
        cancelInvite: (callerId, inviteId) => {
            calls.push('cancel');
            rpcArgs.push({ callerId, inviteId });
            return Promise.resolve({ ok: true, data: true });
        },
        sendEmail: (to, message) => {
            calls.push('send');
            mail.push({ to, ...message });
            const outcome = options.send ?? 'sent';
            return Promise.resolve({ outcome, reason: outcome === 'sent' ? 'sent' : 'http_422' });
        },
        idempotencyKey: resendIdempotencyKey,
        siteUrl: 'https://cleffy.test',
        randomToken: () => TOKEN_BYTES,
    };
    return { deps, calls, rpcArgs, reserved, refunded, mail };
};

Deno.test('answers 404 when SHARE_V2_ENABLED is unset', async () => {
    const h = harness({ enabled: false });
    assert((await handleShareInvite(post(invite()), h.deps)).status === 404);
    assert(h.calls.length === 0);
});

Deno.test('a guest or a roster student cannot share', async () => {
    for (const caller of [{ isAnonymous: true }, { userType: 'student' as const }]) {
        const h = harness({ caller });
        assert((await handleShareInvite(post(invite()), h.deps)).status === 403);
        assert(!h.calls.includes('create'));
    }
});

Deno.test('ownership is checked under the caller JWT before anything else is done', async () => {
    const h = harness({ owner: false });
    const response = await handleShareInvite(post(invite()), h.deps);
    assert(response.status === 403);
    assert((await response.json()).error === 'not_owner');
    assert(JSON.stringify(h.calls) === JSON.stringify([`owner:${DOC}`]));
});

Deno.test('an existing account and a new address get the same answer', async () => {
    const member = harness({ create: { ok: true, data: { kind: 'member', title: 'Sonata', inviter_name: 'Max' } } });
    const fresh = harness();
    const a = await handleShareInvite(post(invite()), member.deps);
    const b = await handleShareInvite(post(invite()), fresh.deps);
    assert(a.status === 200 && b.status === 200);
    assert((await a.text()) === (await b.text()));
    assert(member.mail[0]?.text.includes(`https://cleffy.test/doc/${DOC}`));
    assert(!member.mail[0]?.text.includes(TOKEN));
    assert(fresh.mail[0]?.text.includes(`https://cleffy.test/invite#${TOKEN}`));
    assert(fresh.mail[0]?.to === 'ada@example.com');
});

Deno.test('only the token hash reaches the database; the token is only in the email', async () => {
    const h = harness();
    await handleShareInvite(post(invite()), h.deps);
    const args = h.rpcArgs[0] as { tokenHash: string; email: string; role: string };
    assert(args.tokenHash === (await inviteTokenHash(TOKEN)));
    assert(args.email === 'ada@example.com' && args.role === 'editor');
    assert(!JSON.stringify(h.rpcArgs).includes(TOKEN));
    assert(!h.reserved.some((key) => key.includes('ada') || key.includes(TOKEN)));
});

Deno.test('a roster student of another teacher is refused with the Assign hint and nothing mailed', async () => {
    const h = harness({ create: { ok: true, data: { kind: 'roster_refused' } } });
    const response = await handleShareInvite(post(invite()), h.deps);
    assert(response.status === 403);
    const body = await response.json();
    assert(body.error === 'cannot_invite' && body.hint === 'assign');
    assert(h.mail.length === 0);
    assert(h.refunded.length === h.reserved.filter((key) => !key.startsWith('share-invite:user:')).length);
});

Deno.test('a spent mail budget or recipient allowance is 429 and nothing is created', async () => {
    for (const refuse of ['mail:share-invite:day', 'share-invite:to:', 'share-invite:user:']) {
        const h = harness({ refuse });
        assert((await handleShareInvite(post(invite()), h.deps)).status === 429, refuse);
        assert(!h.calls.includes('create'), refuse);
    }
});

Deno.test('a send Resend refused hands the mail reservations back; an unknown one keeps them', async () => {
    const rejected = harness({ send: 'rejected' });
    assert((await handleShareInvite(post(invite()), rejected.deps)).status === 502);
    assert(
        JSON.stringify(rejected.refunded.sort()) ===
            JSON.stringify(rejected.reserved.filter((key) => !key.startsWith('share-invite:user:')).sort()),
    );
    assert(rejected.refunded.length === 3);
    const unknown = harness({ send: 'unknown' });
    assert((await handleShareInvite(post(invite()), unknown.deps)).status === 502);
    assert(unknown.refunded.length === 0);
});

Deno.test('a bad email or role is refused before any allowance is spent', async () => {
    for (const body of [invite({ email: 'not-an-email' }), invite({ role: 'owner' })]) {
        const h = harness();
        assert((await handleShareInvite(post(body), h.deps)).status === 422);
        assert(!h.calls.includes('create'));
    }
});

Deno.test('resend mails a fresh token for a pending invite, and 404s when nothing is pending', async () => {
    const h = harness();
    const response = await handleShareInvite(post({ action: 'resend', document_id: DOC, invite_id: INVITE }), h.deps);
    assert(response.status === 200);
    const args = h.rpcArgs[0] as { tokenHash: string; inviteId: string };
    assert(args.inviteId === INVITE && args.tokenHash === (await inviteTokenHash(TOKEN)));
    assert(h.mail[0]?.text.includes(`/invite#${TOKEN}`));

    const gone = harness({ reissue: { ok: true, data: null } });
    const missing = await handleShareInvite(post({ action: 'resend', document_id: DOC, invite_id: INVITE }), gone.deps);
    assert(missing.status === 404);
    assert(gone.mail.length === 0 && gone.refunded.length === 3);

    const notListed = harness({ pendingEmail: { ok: true, data: null } });
    const unlisted = await handleShareInvite(
        post({ action: 'resend', document_id: DOC, invite_id: INVITE }),
        notListed.deps,
    );
    assert(unlisted.status === 404);
    assert(!notListed.calls.includes('reissue') && notListed.mail.length === 0);
});

Deno.test('resend reserves the recipient allowance and the mail budget before the token changes', async () => {
    const h = harness();
    await handleShareInvite(post({ action: 'resend', document_id: DOC, invite_id: INVITE }), h.deps);
    const reissueAt = h.calls.indexOf('reissue');
    assert(h.calls.indexOf(`pending:${INVITE}`) < h.calls.indexOf('rate:share-invite:to'));
    assert(h.calls.indexOf('rate:share-invite:to') < reissueAt);
    assert(h.calls.indexOf('rate:mail:share-invite') < reissueAt);
    assert(h.mail[0]?.to === 'ada@example.com');
});

Deno.test('a resend refused by an allowance is 429 and leaves the last mailed token working', async () => {
    for (const refuse of ['share-invite:to:', 'mail:share-invite:hour', 'mail:share-invite:day']) {
        const h = harness({ refuse });
        const response = await handleShareInvite(
            post({ action: 'resend', document_id: DOC, invite_id: INVITE }),
            h.deps,
        );
        assert(response.status === 429, refuse);
        assert(!h.calls.includes('reissue'), refuse);
        assert(h.mail.length === 0, refuse);
    }
});

Deno.test("a resend to an address that has since become another teacher's roster student is refused", async () => {
    const h = harness({ reissue: { ok: true, data: { kind: 'roster_refused' } } });
    const response = await handleShareInvite(post({ action: 'resend', document_id: DOC, invite_id: INVITE }), h.deps);
    assert(response.status === 403);
    const body = await response.json();
    assert(body.error === 'cannot_invite' && body.hint === 'assign');
    assert(h.mail.length === 0);
    assert(h.refunded.length === h.reserved.filter((key) => !key.startsWith('share-invite:user:')).length);
});

Deno.test('a resend whose invite cannot be looked up is 503 and changes nothing', async () => {
    const h = harness({ pendingEmail: { ok: false, code: null } });
    const response = await handleShareInvite(post({ action: 'resend', document_id: DOC, invite_id: INVITE }), h.deps);
    assert(response.status === 503);
    assert(!h.calls.includes('reissue') && h.mail.length === 0);
});

Deno.test('cancel answers whether a pending invite was cancelled, and mails nothing', async () => {
    const h = harness();
    const response = await handleShareInvite(post({ action: 'cancel', document_id: DOC, invite_id: INVITE }), h.deps);
    assert(response.status === 200);
    assert(JSON.stringify(await response.json()) === JSON.stringify({ ok: true, cancelled: true }));
    assert(h.mail.length === 0);
});

Deno.test('a database refusal maps to 403 for ownership and 503 otherwise', async () => {
    const owner = harness({ create: { ok: false, code: '42501' } });
    assert((await handleShareInvite(post(invite()), owner.deps)).status === 403);
    const broken = harness({ create: { ok: false, code: null } });
    assert((await handleShareInvite(post(invite()), broken.deps)).status === 503);
    assert(broken.refunded.length === 3);
});

Deno.test('the email escapes the title and inviter name in HTML', async () => {
    const h = harness({
        create: { ok: true, data: { kind: 'invite', invite_id: INVITE, title: '<b>x</b>', inviter_name: 'A & B' } },
    });
    await handleShareInvite(post(invite()), h.deps);
    const html = h.mail[0]?.html ?? '';
    assert(html.includes('&lt;b&gt;x&lt;/b&gt;') && html.includes('A &amp; B') && !html.includes('<b>x'));
    assert(!/<img/i.test(html));
});
