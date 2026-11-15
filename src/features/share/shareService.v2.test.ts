import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_LINK_EXPIRY_V2,
    DEFAULT_LINK_GUEST_RETENTION,
    LINK_EXPIRY_CHOICES_V2,
    LINK_GUEST_RETENTION_CHOICES,
    ShareError,
    changeGeneralLinkRole,
    inviteByEmail,
    linkExpiryText,
    loadOwnerSharing,
    renewLink,
    resetGeneralLink,
    setGeneralAccess,
    setLinkGuestRetention,
    shareUrlFor,
} from '@/features/share/shareService';
import { getSupabase } from '@/lib/supabase';

const flags = vi.hoisted(() => ({ shareV2: true }));
vi.mock('@/lib/features', () => ({ features: flags }));
vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn(), isSupabaseConfigured: () => true }));
const callEdgeFunction = vi.hoisted(() => vi.fn());
vi.mock('@/features/billing/billingApi', () => ({ callEdgeFunction }));

const stubRpc = (result: { data?: unknown; error?: { message: string; details?: string; code?: string } | null }) => {
    const rpc = vi.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }));
    vi.mocked(getSupabase).mockReturnValue({ rpc } as never);
    return rpc;
};

beforeEach(() => {
    vi.mocked(getSupabase).mockReset();
    callEdgeFunction.mockReset();
    flags.shareV2 = true;
});

describe('D15 and D8 choices', () => {
    it('offers 1 day, 7 days (default), 30 days, 90 days, 1 year and Never, as server intervals', () => {
        expect(LINK_EXPIRY_CHOICES_V2.map((c) => [c.label, c.interval])).toEqual([
            ['1 day', '1 day'],
            ['7 days', '7 days'],
            ['30 days', '30 days'],
            ['90 days', '90 days'],
            ['1 year', '365 days'],
            ['Never', null],
        ]);
        expect(DEFAULT_LINK_EXPIRY_V2).toBe('7d');
        expect(LINK_GUEST_RETENTION_CHOICES).toEqual([7, 14, 30, 60, 90]);
        expect(DEFAULT_LINK_GUEST_RETENTION).toBe(30);
    });

    it('writes the absolute date and the time left', () => {
        const now = new Date('2026-11-13T12:00:00Z');
        expect(linkExpiryText('2026-11-20T12:00:00Z', now)).toBe('Expires 20 Nov 2026 (in 7 days)');
        expect(linkExpiryText('2026-11-14T12:00:00Z', now)).toBe('Expires 14 Nov 2026 (in 1 day)');
        expect(linkExpiryText('2026-11-13T15:00:00Z', now)).toBe('Expires 13 Nov 2026 (today)');
        expect(linkExpiryText('2026-11-12T12:00:00Z', now)).toBe('Expired on 12 Nov 2026');
        expect(linkExpiryText(null, now)).toBe('Never expires');
    });
});

describe('link URLs', () => {
    it('puts the token in the fragment under Share v2, and keeps /join without it', () => {
        expect(shareUrlFor('abc')).toBe(`${window.location.origin}/s#abc`);
        flags.shareV2 = false;
        expect(shareUrlFor('abc')).toBe(`${window.location.origin}/join/abc`);
    });
});

describe('owner RPCs', () => {
    it('setGeneralAccess sends mode, role and the interval, and returns the link', async () => {
        const rpc = stubRpc({ data: [{ link_id: 'l1', token: 't1', role: 'viewer', expires_at: null }] });
        expect(await setGeneralAccess('d1', 'anyone', 'viewer', '365d')).toEqual({
            id: 'l1',
            token: 't1',
            role: 'viewer',
            expiresAt: null,
        });
        expect(rpc).toHaveBeenCalledWith('set_general_access', {
            p_document: 'd1',
            p_mode: 'anyone',
            p_role: 'viewer',
            p_expires_in: '365 days',
        });
        await setGeneralAccess('d1', 'anyone', 'editor', 'never');
        expect(rpc).toHaveBeenLastCalledWith('set_general_access', expect.objectContaining({ p_expires_in: null }));
    });

    it('changeGeneralLinkRole keeps the time left, never under an hour', async () => {
        const rpc = stubRpc({ data: [] });
        const now = Date.parse('2026-11-13T12:00:00Z');
        await changeGeneralLinkRole('d1', 'editor', '2026-11-14T12:00:00Z', now);
        expect(rpc).toHaveBeenLastCalledWith('set_general_access', {
            p_document: 'd1',
            p_mode: 'anyone',
            p_role: 'editor',
            p_expires_in: '86400 seconds',
        });
        await changeGeneralLinkRole('d1', 'viewer', '2026-11-13T12:10:00Z', now);
        expect(rpc).toHaveBeenLastCalledWith(
            'set_general_access',
            expect.objectContaining({ p_expires_in: '3600 seconds' }),
        );
        await changeGeneralLinkRole('d1', 'viewer', null, now);
        expect(rpc).toHaveBeenLastCalledWith('set_general_access', expect.objectContaining({ p_expires_in: null }));
    });

    it('maps the server bounds error to its message', async () => {
        stubRpc({ error: { message: 'bad', code: '22023', details: '{"code":"invalid_link_expiry"}' } });
        const err = await renewLink('l1', '7d').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ShareError);
        expect((err as ShareError).code).toBe('invalid_link_expiry');
        expect((err as ShareError).message).toMatch(/1 hour to 1 year/);

        stubRpc({ error: { message: 'bad', code: '22023', details: '{"code":"invalid_retention_days"}' } });
        await expect(setLinkGuestRetention(120)).rejects.toThrow('Choose between 1 and 90 days.');
    });

    it('renewLink sends the link id and interval', async () => {
        const rpc = stubRpc({ data: '2026-12-13T00:00:00Z' });
        expect(await renewLink('l1', '30d')).toBe('2026-12-13T00:00:00Z');
        expect(rpc).toHaveBeenCalledWith('renew_share_link', { p_link: 'l1', p_expires_in: '30 days' });
    });

    it('resetGeneralLink returns the new link', async () => {
        stubRpc({ data: [{ link_id: 'l2', token: 't2', role: 'editor', expires_at: '2026-11-20T00:00:00Z' }] });
        expect(await resetGeneralLink('d1')).toEqual({
            id: 'l2',
            token: 't2',
            role: 'editor',
            expiresAt: '2026-11-20T00:00:00Z',
        });
    });

    it('loadOwnerSharing splits the General access link from older ones', async () => {
        const order = vi.fn(() =>
            Promise.resolve({
                data: [
                    { token: 'g', general: true },
                    { token: 'o', general: false },
                ],
                error: null,
            }),
        );
        const chain = { select: () => chain, eq: () => chain, is: () => chain, order };
        vi.mocked(getSupabase).mockReturnValue({ from: () => chain } as never);
        const loaded = await loadOwnerSharing('d1');
        expect(loaded.general?.token).toBe('g');
        expect(loaded.older.map((l) => l.token)).toEqual(['o']);
    });
});

describe('invites', () => {
    const respond = (status: number, body: unknown) =>
        callEdgeFunction.mockResolvedValue(new Response(JSON.stringify(body), { status }));

    it('sends the action, score, trimmed email and role', async () => {
        respond(200, { ok: true });
        await inviteByEmail('d1', '  ana@example.org ', 'editor');
        expect(callEdgeFunction).toHaveBeenCalledWith('share-invite', {
            action: 'invite',
            document_id: 'd1',
            email: 'ana@example.org',
            role: 'editor',
        });
    });

    it('turns the refusals into messages', async () => {
        respond(403, { error: 'cannot_invite', hint: 'assign' });
        await expect(inviteByEmail('d1', 'kid@school.test', 'viewer')).rejects.toThrow(/use Assign/);
        respond(429, { error: 'rate_limited', retry_after: 90 });
        await expect(inviteByEmail('d1', 'a@b.co', 'viewer')).rejects.toThrow(
            'Too many invites just now. Try again in 2 min.',
        );
        respond(422, { error: 'invalid_email' });
        await expect(inviteByEmail('d1', 'nope', 'viewer')).rejects.toThrow('Enter a valid email address.');
    });
});
