import { passwordProblem, passwordProblemMessage } from '../_shared/passwordPolicy.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import {
    type ConsumeResult,
    handleShareInviteAccept,
    inviteTokenHash,
    maskEmail,
    type PeekResult,
    type ShareInviteAcceptDeps,
} from './handler.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const DOC = '0d0c0000-0000-4000-8000-000000000001';
const NEW_USER = '05e70000-0000-4000-8000-000000000001';
const GATE = { country: 'US', min_age: 13 };

const pending: PeekResult = {
    state: 'pending',
    title: 'Sonata',
    inviter_name: 'Max',
    role: 'editor',
    email: 'jane@example.com',
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown) =>
    new Request('https://edge.test/functions/v1/share-invite-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

const accept = (extra: Record<string, unknown> = {}) => ({
    action: 'accept',
    token: TOKEN,
    password: 'Correct1horse',
    age_gate: GATE,
    ...extra,
});

const harness = (
    options: {
        enabled?: boolean;
        invite?: PeekResult | null;
        user?: { userId: string; email: string | null } | null;
        taken?: boolean | null;
        age?: string | null;
        create?: 'ok' | 'email_exists' | 'weak_password' | 'failed';
        consume?: ConsumeResult | null;
        rate?: boolean;
    } = {},
) => {
    const calls: string[] = [];
    const deleted: string[] = [];
    const created: { email: string; password: string; ageGate: Record<string, unknown> }[] = [];
    const deps: ShareInviteAcceptDeps = {
        enabled: () => options.enabled ?? true,
        json,
        options: () => new Response('ok'),
        readJson: readCappedJson,
        checkRateLimit: (key) => {
            calls.push(`rate:${key}`);
            return Promise.resolve(options.rate === false ? { ok: false, retryAfterSec: 30 } : { ok: true });
        },
        signedInUser: () => Promise.resolve(options.user ?? null),
        peek: (hash) => {
            calls.push(`peek:${hash}`);
            return Promise.resolve(options.invite === undefined ? pending : options.invite);
        },
        consume: (_hash, userId) => {
            calls.push(`consume:${userId}`);
            return Promise.resolve(options.consume === undefined ? { ok: true, document_id: DOC } : options.consume);
        },
        emailTaken: () => Promise.resolve(options.taken ?? false),
        ageGateProblem: () => {
            calls.push('age');
            return Promise.resolve(options.age === undefined ? null : options.age);
        },
        password: { passwordProblem, passwordProblemMessage },
        createUser: (args) => {
            calls.push('create');
            created.push(args);
            const outcome = options.create ?? 'ok';
            return Promise.resolve(outcome === 'ok' ? { ok: true, userId: NEW_USER } : { ok: false, reason: outcome });
        },
        deleteUser: (userId) => {
            deleted.push(userId);
            return Promise.resolve();
        },
    };
    return { deps, calls, deleted, created };
};

Deno.test('answers 404 when SHARE_V2_ENABLED is unset', async () => {
    const h = harness({ enabled: false });
    assert((await handleShareInviteAccept(post({ action: 'peek', token: TOKEN }), h.deps)).status === 404);
    assert(h.calls.length === 0);
});

Deno.test('peek shows the title, inviter, role and a masked address, keyed by the token hash', async () => {
    const h = harness();
    const response = await handleShareInviteAccept(post({ action: 'peek', token: TOKEN }), h.deps);
    const body = await response.json();
    assert(response.status === 200);
    assert(
        JSON.stringify(body) ===
            JSON.stringify({
                state: 'pending',
                title: 'Sonata',
                inviter_name: 'Max',
                role: 'editor',
                email_masked: 'j***@e***.com',
            }),
    );
    const hash = await inviteTokenHash(TOKEN);
    assert(h.calls.includes(`rate:share-invite-accept:${hash}`) && h.calls.includes(`peek:${hash}`));
    assert(!h.calls.some((call) => call.includes(TOKEN)));
});

Deno.test('peek of a dead invite says only its state; a malformed token is invalid without a lookup', async () => {
    for (const state of ['expired', 'used', 'cancelled', 'invalid'] as const) {
        const body = await (
            await handleShareInviteAccept(post({ action: 'peek', token: TOKEN }), harness({ invite: { state } }).deps)
        ).json();
        assert(JSON.stringify(body) === JSON.stringify({ state }), state);
    }
    const h = harness();
    const body = await (await handleShareInviteAccept(post({ action: 'peek', token: 'short' }), h.deps)).json();
    assert(body.state === 'invalid' && h.calls.length === 0);
});

Deno.test('the per-token bucket fails closed', async () => {
    const h = harness({ rate: false });
    assert((await handleShareInviteAccept(post({ action: 'peek', token: TOKEN }), h.deps)).status === 429);
    assert(!h.calls.some((call) => call.startsWith('peek:')));
});

Deno.test('expired, used and cancelled invites cannot be accepted', async () => {
    for (const state of ['expired', 'used', 'cancelled'] as const) {
        const h = harness({ invite: { state } });
        const response = await handleShareInviteAccept(post(accept()), h.deps);
        assert(response.status === 410, state);
        assert(!h.calls.includes('create') && !h.calls.some((call) => call.startsWith('consume')), state);
    }
});

Deno.test('a signed-in account with the invited address accepts in one step', async () => {
    const h = harness({ user: { userId: 'u1', email: 'Jane@Example.com' } });
    const response = await handleShareInviteAccept(post({ action: 'accept', token: TOKEN }), h.deps);
    assert(response.status === 200);
    assert(JSON.stringify(await response.json()) === JSON.stringify({ ok: true, document_id: DOC }));
    assert(h.calls.includes('consume:u1') && !h.calls.includes('create'));
});

Deno.test('a signed-in account with another address is refused', async () => {
    const h = harness({ user: { userId: 'u2', email: 'other@example.com' } });
    const response = await handleShareInviteAccept(post(accept()), h.deps);
    assert(response.status === 409 && (await response.json()).error === 'email_mismatch');
    assert(!h.calls.some((call) => call.startsWith('consume')));
});

Deno.test('signed out, an address that already has an account must sign in', async () => {
    const h = harness({ taken: true });
    const response = await handleShareInviteAccept(post(accept()), h.deps);
    assert(response.status === 409 && (await response.json()).error === 'sign_in_required');
    assert(!h.calls.includes('create'));
});

Deno.test('signed out, a missing or failing age gate creates nothing', async () => {
    const missing = harness();
    const noGate = await handleShareInviteAccept(post(accept({ age_gate: undefined })), missing.deps);
    assert(noGate.status === 400 && (await noGate.json()).error === 'age_check_missing');
    assert(!missing.calls.includes('age') && !missing.calls.includes('create'));

    const young = harness({ age: 'below_consent_age' });
    assert((await handleShareInviteAccept(post(accept()), young.deps)).status === 403);
    const incomplete = harness({ age: 'age_check_missing' });
    assert((await handleShareInviteAccept(post(accept()), incomplete.deps)).status === 400);
    assert(!young.calls.includes('create') && !incomplete.calls.includes('create'));
});

Deno.test('signed out, a weak password creates nothing', async () => {
    const h = harness();
    const response = await handleShareInviteAccept(post(accept({ password: 'short' })), h.deps);
    assert(response.status === 400 && (await response.json()).error === 'weak_password');
    assert(!h.calls.includes('create'));
});

Deno.test('signed out, the account is created confirmed with the age gate, then the invite attached', async () => {
    const h = harness();
    const response = await handleShareInviteAccept(post(accept()), h.deps);
    assert(response.status === 200);
    assert(JSON.stringify(await response.json()) === JSON.stringify({ ok: true, document_id: DOC }));
    assert(
        JSON.stringify(h.created) ===
            JSON.stringify([{ email: 'jane@example.com', password: 'Correct1horse', ageGate: GATE }]),
    );
    assert(h.calls.indexOf('create') < h.calls.indexOf(`consume:${NEW_USER}`));
    assert(h.deleted.length === 0);
});

Deno.test('if the attach fails, the account just created is deleted again', async () => {
    for (const consume of [{ ok: false as const, state: 'used' }, null]) {
        const h = harness({ consume });
        const response = await handleShareInviteAccept(post(accept()), h.deps);
        assert(response.status === (consume ? 410 : 503));
        assert(JSON.stringify(h.deleted) === JSON.stringify([NEW_USER]));
    }
});

Deno.test('maskEmail keeps one letter of each part and the TLD', () => {
    assert(maskEmail('jane@example.com') === 'j***@e***.com');
    assert(maskEmail('a.b@mail.example.co.uk') === 'a***@m***.uk');
    assert(maskEmail('x@localhost') === 'x***@l***');
});
