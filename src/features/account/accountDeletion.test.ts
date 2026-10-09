import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AccountDeletionError,
    DELETE_ACCOUNT_CONFIRMATION,
    clearLocalAccountData,
    deleteGuestProfile,
    requestAccountDeletion,
} from '@/features/account/accountDeletion';
import { AUTH_RESTORE_COOKIE } from '@/features/auth/authStorage';
import { getDb } from '@/sync/db';

const callEdgeFunction = vi.fn();
const signOut = vi.fn();
const stopAutoRefresh = vi.fn();
const syncBeforeSignOut = vi.fn();
const clearAccountCachesFromDevice = vi.fn();

vi.mock('@/features/billing/billingApi', () => ({
    callEdgeFunction: (...args: unknown[]) => callEdgeFunction(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            signOut: (...args: unknown[]) => signOut(...args),
            stopAutoRefresh: () => stopAutoRefresh(),
        },
    }),
}));

vi.mock('@/features/auth/session', () => ({
    syncBeforeSignOut: () => syncBeforeSignOut(),
    clearAccountCachesFromDevice: () => clearAccountCachesFromDevice(),
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

    it('sends no password for a guest, who has none', async () => {
        callEdgeFunction.mockResolvedValue(json(200, { deleted: true }));
        await requestAccountDeletion();
        expect(callEdgeFunction).toHaveBeenCalledWith('delete-account', { confirm: DELETE_ACCOUNT_CONFIRMATION });
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
        stopAutoRefresh.mockReset().mockResolvedValue(undefined);
        localStorage.clear();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('drops the session without asking the server, and empties every store Cleffy keeps in the browser', async () => {
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

        // signOut() — any scope — POSTs /auth/v1/logout, which 403s for a
        // user the server has just deleted. The account is gone; only this
        // browser's copy of the session is left to drop.
        expect(signOut).not.toHaveBeenCalled();
        expect(stopAutoRefresh).toHaveBeenCalled();
        for (const table of db.tables) {
            expect(await table.count()).toBe(0);
        }
        expect(localStorage.getItem('cleffy:library-view')).toBeNull();
        expect(localStorage.getItem('sb-project-auth-token')).toBeNull();
        expect(localStorage.getItem('some-other-site-key')).toBe('kept');
        expect(document.cookie).not.toContain(`${AUTH_RESTORE_COOKIE}=abc`);
    });

    it('still clears the device when the auth client fails', async () => {
        stopAutoRefresh.mockRejectedValue(new Error('client gone'));
        localStorage.setItem('cleffy:page-columns', '2');
        localStorage.setItem('sb-project-auth-token', '{"access_token":"x"}');
        await expect(clearLocalAccountData()).resolves.toBeUndefined();
        expect(localStorage.getItem('cleffy:page-columns')).toBeNull();
        expect(localStorage.getItem('sb-project-auth-token')).toBeNull();
    });
});

describe('deleteGuestProfile', () => {
    beforeEach(() => {
        callEdgeFunction.mockReset();
        signOut.mockReset().mockResolvedValue({ error: null });
        stopAutoRefresh.mockReset().mockResolvedValue(undefined);
        syncBeforeSignOut.mockReset().mockResolvedValue({ pending: 0, refused: 0 });
        clearAccountCachesFromDevice.mockReset().mockResolvedValue(undefined);
        localStorage.clear();
    });

    afterEach(() => {
        localStorage.clear();
    });

    it('uploads unsynced marks, deletes the guest without a password, then forgets them on this device', async () => {
        const order: string[] = [];
        syncBeforeSignOut.mockImplementation(() => {
            order.push('sync');
            return Promise.resolve({ pending: 0, refused: 0 });
        });
        callEdgeFunction.mockImplementation(() => {
            order.push('delete');
            return Promise.resolve(json(200, { deleted: true }));
        });
        clearAccountCachesFromDevice.mockImplementation(() => {
            order.push('clear');
            return Promise.resolve();
        });
        localStorage.setItem('sb-project-auth-token', '{"access_token":"x"}');
        localStorage.setItem('cleffy:library-view', 'grid');

        await deleteGuestProfile();

        expect(order).toEqual(['sync', 'delete', 'clear']);
        expect(callEdgeFunction).toHaveBeenCalledWith('delete-account', { confirm: DELETE_ACCOUNT_CONFIRMATION });
        expect(signOut).not.toHaveBeenCalled();
        expect(localStorage.getItem('sb-project-auth-token')).toBeNull();
        // Sign-out's scope, not deletion's: preferences are the device's, not the guest's.
        expect(localStorage.getItem('cleffy:library-view')).toBe('grid');
    });

    it('keeps the session and the device untouched when the server did not finish', async () => {
        callEdgeFunction.mockResolvedValue(
            json(502, { error: 'We could not finish deleting your guest profile.', code: 'auth_delete_failed' }),
        );
        localStorage.setItem('sb-project-auth-token', '{"access_token":"x"}');

        await expect(deleteGuestProfile()).rejects.toMatchObject({ code: 'auth_delete_failed', status: 502 });
        expect(localStorage.getItem('sb-project-auth-token')).not.toBeNull();
        expect(clearAccountCachesFromDevice).not.toHaveBeenCalled();
    });
});
