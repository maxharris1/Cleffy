import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_LINK_EXPIRY,
    DEFAULT_LINK_ROLE,
    createShareLink,
    expiresAtFor,
    isLinkExpired,
    leaveDocument,
    linkExpiryLabel,
    listDocumentMembers,
    memberLabel,
    peekShareLink,
    redeemShareLink,
    removeMember,
    revokeShareLink,
    setMemberRole,
} from '@/features/share/shareService';
import { getSupabase } from '@/lib/supabase';

vi.mock('@/lib/supabase', () => ({
    getSupabase: vi.fn(),
    isSupabaseConfigured: () => true,
}));

const NOW = new Date('2026-10-07T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const inFuture = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const stubRpc = (result: { data?: unknown; error?: { message: string; details?: string; code?: string } | null }) => {
    const rpc = vi.fn(() => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }));
    vi.mocked(getSupabase).mockReturnValue({ rpc } as never);
    return rpc;
};

beforeEach(() => {
    vi.mocked(getSupabase).mockReset();
});

describe('link defaults', () => {
    it('makes a new link view-only and short-lived unless the owner says otherwise', () => {
        expect(DEFAULT_LINK_ROLE).toBe('viewer');
        expect(DEFAULT_LINK_EXPIRY).toBe('7d');
    });

    it('turns an expiry choice into expires_at', () => {
        expect(expiresAtFor('7d', NOW)).toBe(inFuture(7 * DAY));
        expect(expiresAtFor('30d', NOW)).toBe(inFuture(30 * DAY));
        expect(expiresAtFor('never', NOW)).toBeNull();
    });

    it('sends the chosen role and expiry with the insert', async () => {
        const single = vi.fn(() => Promise.resolve({ data: { token: 't' }, error: null }));
        const insert = vi.fn(() => ({ select: () => ({ single }) }));
        vi.mocked(getSupabase).mockReturnValue({ from: () => ({ insert }) } as never);

        await createShareLink('doc-1', 'viewer', 'owner-1', 'never');
        await createShareLink('doc-1', 'editor', 'owner-1', '30d');

        expect(insert).toHaveBeenNthCalledWith(1, {
            document_id: 'doc-1',
            role: 'viewer',
            created_by: 'owner-1',
            expires_at: null,
        });
        const second = (insert.mock.calls[1] as unknown as [{ role: string; expires_at: string }])[0];
        expect(second.role).toBe('editor');
        const days = (new Date(second.expires_at).getTime() - Date.now()) / DAY;
        expect(days).toBeGreaterThan(29.9);
        expect(days).toBeLessThanOrEqual(30);
    });
});

describe('link expiry display', () => {
    it('labels never, future, nearly-due and past links', () => {
        expect(linkExpiryLabel({ expires_at: null }, NOW)).toBe('Never expires');
        expect(linkExpiryLabel({ expires_at: inFuture(6.2 * DAY) }, NOW)).toBe('Expires in 7 days');
        expect(linkExpiryLabel({ expires_at: inFuture(20 * 60 * 60 * 1000) }, NOW)).toBe('Expires in 1 day');
        expect(linkExpiryLabel({ expires_at: inFuture(2 * 60 * 60 * 1000) }, NOW)).toBe('Expires today');
        expect(linkExpiryLabel({ expires_at: inFuture(-1000) }, NOW)).toBe('Expired');
    });

    it('treats the expiry instant itself as expired, matching redeem_share_link', () => {
        expect(isLinkExpired({ expires_at: NOW.toISOString() }, NOW)).toBe(true);
        expect(isLinkExpired({ expires_at: inFuture(1000) }, NOW)).toBe(false);
        expect(isLinkExpired({ expires_at: null }, NOW)).toBe(false);
    });
});

describe('member management RPCs', () => {
    it('revokes through the RPC, passing whether to remove the people who joined', async () => {
        const rpc = stubRpc({ data: 3 });
        await expect(revokeShareLink('tok', { removeMembers: true })).resolves.toBe(3);
        expect(rpc).toHaveBeenCalledWith('revoke_share_link', { p_token: 'tok', p_remove_members: true });

        await revokeShareLink('tok', { removeMembers: false });
        expect(rpc).toHaveBeenLastCalledWith('revoke_share_link', { p_token: 'tok', p_remove_members: false });
    });

    it('lists, re-roles and removes members by document and user', async () => {
        const rows = [{ user_id: 'u1', role: 'owner' }];
        const rpc = stubRpc({ data: rows });
        await expect(listDocumentMembers('doc-1')).resolves.toBe(rows);
        expect(rpc).toHaveBeenCalledWith('list_document_members', { p_document: 'doc-1' });

        await setMemberRole('doc-1', 'u2', 'viewer');
        expect(rpc).toHaveBeenCalledWith('set_document_member_role', {
            p_document: 'doc-1',
            p_user: 'u2',
            p_role: 'viewer',
        });

        await removeMember('doc-1', 'u2');
        expect(rpc).toHaveBeenCalledWith('remove_document_member', { p_document: 'doc-1', p_user: 'u2' });
    });

    it('surfaces a refused management call as an error', async () => {
        stubRpc({ error: { message: 'only the score owner can remove collaborators' } });
        await expect(removeMember('doc-1', 'u2')).rejects.toThrow('only the score owner');
    });
});

describe('leaveDocument', () => {
    it('leaves through the RPC', async () => {
        const rpc = stubRpc({});
        await leaveDocument('doc-1');
        expect(rpc).toHaveBeenCalledWith('leave_document', { p_document: 'doc-1' });
    });

    it('explains the refusals a member can actually hit', async () => {
        stubRpc({ error: { message: 'x', details: '{"code":"assigned_score"}' } });
        await expect(leaveDocument('doc-1')).rejects.toThrow('Your teacher assigned this score');

        stubRpc({ error: { message: 'x', details: '{"code":"owner_cannot_leave"}' } });
        await expect(leaveDocument('doc-1')).rejects.toThrow('delete it instead');

        stubRpc({ error: { message: 'network down', details: 'not json' } });
        await expect(leaveDocument('doc-1')).rejects.toThrow('Could not leave this score: network down');
    });
});

describe('memberLabel', () => {
    it('prefers a name, then the email the owner can see, then a generic label', () => {
        expect(memberLabel({ display_name: 'Ana', email: 'ana@x.test', is_anonymous: false })).toBe('Ana');
        expect(memberLabel({ display_name: null, email: 'ana@x.test', is_anonymous: false })).toBe('ana@x.test');
        expect(memberLabel({ display_name: null, email: null, is_anonymous: true })).toBe('Guest');
        expect(memberLabel({ display_name: null, email: null, is_anonymous: false })).toBe('Collaborator');
    });
});

describe('redeemShareLink', () => {
    it('joins and reports the granted role', async () => {
        const rpc = stubRpc({ data: [{ document_id: 'doc-1', granted_role: 'editor' }] });
        await expect(redeemShareLink('tok')).resolves.toEqual({ documentId: 'doc-1', role: 'editor' });
        expect(rpc).toHaveBeenCalledWith('redeem_share_link', { p_token: 'tok' });
    });

    it('recognises a dead link by its stable code, not its wording', async () => {
        // 20261009120200: PT404 (HTTP 404) with the code in detail. The message
        // could be reworded tomorrow; the code is the contract.
        stubRpc({
            error: { code: 'PT404', message: 'that link is no good', details: '{"code" : "invalid_share_link"}' },
        });
        await expect(redeemShareLink('tok')).rejects.toThrow('invalid_link');
    });

    it('still recognises the pre-migration refusal (P0002 + message)', async () => {
        stubRpc({ error: { code: 'P0002', message: 'invalid or expired share link' } });
        await expect(redeemShareLink('tok')).rejects.toThrow('invalid_link');
    });

    it('passes any other failure through as itself', async () => {
        stubRpc({ error: { code: '28000', message: 'not authenticated' } });
        await expect(redeemShareLink('tok')).rejects.toThrow('not authenticated');
        stubRpc({ error: { code: 'P0002', message: 'not a member of this score' } });
        await expect(redeemShareLink('tok')).rejects.toThrow('not a member of this score');
    });
});

describe('peekShareLink', () => {
    it('reports a live link and the role it grants', async () => {
        const rpc = stubRpc({ data: [{ valid: true, role: 'viewer' }] });
        await expect(peekShareLink('tok')).resolves.toEqual({ valid: true, role: 'viewer' });
        expect(rpc).toHaveBeenCalledWith('peek_share_link', { p_token: 'tok' });
    });

    it('reports a dead link as just invalid', async () => {
        stubRpc({ data: [{ valid: false, role: null }] });
        await expect(peekShareLink('tok')).resolves.toEqual({ valid: false });
    });

    it('answers null — "could not tell" — when the server could not say', async () => {
        // A backend without the function yet: PostgREST's 404 for a missing RPC.
        stubRpc({ error: { code: 'PGRST202', message: 'Could not find the function public.peek_share_link' } });
        await expect(peekShareLink('tok')).resolves.toBeNull();

        stubRpc({ data: [] });
        await expect(peekShareLink('tok')).resolves.toBeNull();

        vi.mocked(getSupabase).mockReturnValue({
            rpc: () => Promise.reject(new TypeError('Failed to fetch')),
        } as never);
        await expect(peekShareLink('tok')).resolves.toBeNull();
    });
});
