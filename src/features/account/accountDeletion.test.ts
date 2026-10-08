import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AccountDeletionError,
    DELETE_ACCOUNT_CONFIRMATION,
    clearLocalAccountData,
    requestAccountDeletion,
} from '@/features/account/accountDeletion';
import { AUTH_RESTORE_COOKIE } from '@/features/auth/authStorage';
import { getDb } from '@/sync/db';

const callEdgeFunction = vi.fn();
const signOut = vi.fn();

vi.mock('@/features/billing/billingApi', () => ({
    callEdgeFunction: (...args: unknown[]) => callEdgeFunction(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ auth: { signOut: (...args: unknown[]) => signOut(...args) } }),
}));

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('requestAccountDeletion', () => {
    beforeEach(() => {
        callEdgeFunction.mockReset();
    });

    it('sends the typed confirmation and the password to delete-account', async () => {
        callEdgeFunction.mockResolvedValue(json(200, { deleted: true }));
        await requestAccountDeletion('hunter22');
        expect(callEdgeFunction).toHaveBeenCalledWith('delete-account', {
            confirm: DELETE_ACCOUNT_CONFIRMATION,
            password: 'hunter22',
        });
    });

    it('resolves for an account that was already deleted', async () => {
        callEdgeFunction.mockResolvedValue(json(200, { deleted: true, alreadyDeleted: true }));
        await expect(requestAccountDeletion('pw')).resolves.toBeUndefined();
    });

    it('surfaces the server’s own explanation and code', async () => {
        callEdgeFunction.mockResolvedValue(
            json(403, { error: 'That password is not correct.', code: 'reauthentication_failed' }),
        );
        const error = await requestAccountDeletion('wrong').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AccountDeletionError);
        expect(error).toMatchObject({
            message: 'That password is not correct.',
            code: 'reauthentication_failed',
            status: 403,
        });
    });

    it('falls back to a generic message for a non-JSON failure', async () => {
        callEdgeFunction.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
        await expect(requestAccountDeletion('pw')).rejects.toMatchObject({ code: null, status: 502 });
    });

    it('does not claim nothing was deleted when the connection failed', async () => {
        // The request may have reached the server before the connection dropped,
        // so the outcome is unknown; a retry finishes it (the endpoint is idempotent).
        callEdgeFunction.mockRejectedValue(new TypeError('Failed to fetch'));
        const failure = requestAccountDeletion('pw');
        await expect(failure).rejects.toThrow(/could not confirm whether your account was deleted/);
        await expect(failure).rejects.not.toThrow(/nothing has been deleted/);
        await expect(failure).rejects.toThrow(/try again to finish/);
    });
});

describe('clearLocalAccountData', () => {
    beforeEach(() => {
        signOut.mockReset().mockResolvedValue({ error: null });
        localStorage.clear();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('signs out locally and empties every store Cleffy keeps in the browser', async () => {
        const db = getDb();
        await db.ops.add({
            docId: 'doc-1',
            type: 'create',
            annotationId: 'a1',
            annotation: {
                id: 'a1',
                docId: 'doc-1',
                page: 0,
                kind: 'stroke',
                color: '#000',
                payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
                createdBy: null,
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                deletedAt: null,
                seq: 0,
            },
            queuedAt: '2026-01-01T00:00:00Z',
        });
        await db.syncState.put({ docId: 'doc-1', watermarkSeq: 4 });
        localStorage.setItem('cleffy:library-view', 'grid');
        localStorage.setItem('sb-project-auth-token', '{"access_token":"x"}');
        localStorage.setItem('some-other-site-key', 'kept');
        document.cookie = `${AUTH_RESTORE_COOKIE}=abc; Path=/`;

        await clearLocalAccountData();

        expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
        for (const table of db.tables) {
            expect(await table.count()).toBe(0);
        }
        expect(localStorage.getItem('cleffy:library-view')).toBeNull();
        expect(localStorage.getItem('sb-project-auth-token')).toBeNull();
        expect(localStorage.getItem('some-other-site-key')).toBe('kept');
        expect(document.cookie).not.toContain(`${AUTH_RESTORE_COOKIE}=abc`);
    });

    it('still clears the device when signing out throws', async () => {
        signOut.mockRejectedValue(new Error('user not found'));
        localStorage.setItem('cleffy:page-columns', '2');
        await expect(clearLocalAccountData()).resolves.toBeUndefined();
        expect(localStorage.getItem('cleffy:page-columns')).toBeNull();
    });
});
