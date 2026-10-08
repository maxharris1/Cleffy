import { forgetStoredSessions, localStorageKeys } from '@/features/auth/authStorage';
import { callEdgeFunction } from '@/features/billing/billingApi';
import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';

/**
 * Client half of self-serve account deletion. The server half — what is
 * refused, cancelled and deleted, and in which order — is
 * supabase/functions/_shared/accountDeletion.ts behind the delete-account
 * Edge Function.
 */

/**
 * The word the user types to confirm, sent along as `confirm`. Must equal
 * DELETE_CONFIRMATION in _shared/accountDeletion.ts (tests/account checks).
 */
export const DELETE_ACCOUNT_CONFIRMATION = 'DELETE';

/** Where a finished deletion lands: a public page, loaded fresh. */
export const ACCOUNT_DELETED_PATH = '/account-deleted';

export class AccountDeletionError extends Error {
    constructor(
        message: string,
        /** The function's machine-readable code (`reauthentication_failed`, …), when it sent one. */
        readonly code: string | null,
        readonly status: number,
    ) {
        super(message);
        this.name = 'AccountDeletionError';
    }
}

/**
 * Ask the server to delete the signed-in account. Resolves only once the
 * account is gone (or was already gone); otherwise throws an
 * AccountDeletionError carrying the server's own explanation, which is written
 * for the person reading it and says whether anything was deleted.
 */
export const requestAccountDeletion = async (password: string): Promise<void> => {
    let response: Response;
    try {
        response = await callEdgeFunction('delete-account', { confirm: DELETE_ACCOUNT_CONFIRMATION, password });
    } catch (err) {
        throw new AccountDeletionError(
            err instanceof Error && err.message === 'Not signed in'
                ? 'Your session has ended. Sign in again to delete your account.'
                : 'Could not reach Cleffy. Check your connection and try again — nothing has been deleted.',
            null,
            0,
        );
    }
    if (response.ok) {
        return;
    }
    let body: { error?: unknown; code?: unknown } = {};
    try {
        body = (await response.json()) as typeof body;
    } catch {
        // Not JSON (a gateway error page): fall through to the generic message.
    }
    throw new AccountDeletionError(
        typeof body.error === 'string' && body.error
            ? body.error
            : `Account deletion did not finish (error ${response.status}). Please try again.`,
        typeof body.code === 'string' ? body.code : null,
        response.status,
    );
};

/** Preference keys the app writes (imslpPrefs, libraryPrefs, viewerPrefs, installPrefs). */
const APP_KEY_PREFIX = 'cleffy:';

/**
 * Everything Cleffy keeps in this browser, gone — after the account is.
 *
 * Wider than sign-out on purpose. Sign-out keeps the annotation mirror and the
 * outbox so marks made offline are not lost; here the account those marks
 * belonged to no longer exists, its scores are deleted, and nothing in the
 * outbox can ever be accepted again, so keeping it would only leave the
 * deleted account's content on the device. Every Dexie table is cleared, every
 * app preference key and stored session removed, and the restore cookie
 * expired.
 *
 * Each step is best-effort and independent: the server-side deletion has
 * already happened, and one store failing to clear must not stop the others.
 */
export const clearLocalAccountData = async (): Promise<void> => {
    try {
        // Local scope: the server deleted every session along with the user,
        // so there is nothing to revoke there — only this tab's copy to drop.
        await getSupabase().auth.signOut({ scope: 'local' });
    } catch {
        // Already signed out, or the client is unavailable: storage is cleared below regardless.
    }

    try {
        const db = getDb();
        await Promise.all(db.tables.map((table) => table.clear().catch(() => undefined)));
    } catch {
        // IndexedDB unavailable (private mode): there is nothing stored to clear.
    }

    const keys = localStorageKeys();
    forgetStoredSessions(undefined, keys);
    for (const key of keys) {
        if (key.startsWith(APP_KEY_PREFIX)) {
            try {
                globalThis.localStorage.removeItem(key);
            } catch {
                // Storage went away mid-loop; nothing more to do.
            }
        }
    }
};
