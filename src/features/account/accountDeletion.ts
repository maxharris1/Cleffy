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
 *
 * `password` is required for a registered account and absent for a share-link
 * guest, who has none (the server tells the two apart, not this argument).
 */
export const requestAccountDeletion = async (password?: string): Promise<void> => {
    let response: Response;
    try {
        response = await callEdgeFunction(
            'delete-account',
            password === undefined
                ? { confirm: DELETE_ACCOUNT_CONFIRMATION }
                : { confirm: DELETE_ACCOUNT_CONFIRMATION, password },
        );
    } catch (err) {
        throw new AccountDeletionError(
            err instanceof Error && err.message === 'Not signed in'
                ? 'Your session has ended. Sign in again to delete your account.'
                : // The request may have gone out before the connection dropped (a
                  // long deletion, a network switch on a phone), so the server may
                  // have finished. Retrying is safe: the endpoint is idempotent and
                  // answers an already-deleted account with success.
                  'We could not confirm whether your account was deleted. Check your connection and try again to finish.',
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

/**
 * Drop this browser's session for an account the server has just deleted,
 * WITHOUT asking the server. supabase-js has no such call: signOut() — even
 * with `scope: 'local'` — first POSTs /auth/v1/logout, which for a deleted
 * user can only fail (GoTrue answers 403 user_not_found), and is a request to
 * a server that has already done everything there was to do.
 *
 * The client reads its session from storage on every use (persistSession), so
 * removing the stored copy — each `*-auth-token` key and the iOS restore
 * cookie — is what signs this tab out; stopping the refresh ticker keeps it
 * from trying to refresh a token that no longer exists in the meantime. The
 * React tree still holds the session it last saw, so callers finish with a
 * full page load.
 */
export const forgetLocalSession = (): void => {
    try {
        void getSupabase()
            .auth.stopAutoRefresh()
            .catch(() => undefined);
    } catch {
        // The client is unavailable: there is no ticker to stop.
    }
    forgetStoredSessions();
};

/**
 * Stop what writes this account's rows into Dexie on its own before the
 * clear, as sign-out does: the app-wide background outbox drain (a flush in
 * flight would write a synced or rolled-back mark back after the clear) and
 * snapshot uploads it or a viewer started. The page is reloaded afterwards,
 * but not before an in-flight write could land.
 */
const stopLocalWriters = async (): Promise<void> => {
    try {
        const [{ stopSnapshotWrites }, { stopAllBackgroundDrains }] = await Promise.all([
            import('@/features/viewer/history/snapshotService'),
            import('@/sync/backgroundDrain'),
        ]);
        stopSnapshotWrites();
        stopAllBackgroundDrains();
    } catch {
        // Not loaded and cannot be (offline, a stale bundle): none of them is running.
    }
};

/** Where a deleted guest profile lands: the same page, worded for a guest. */
export const GUEST_DELETED_PATH = `${ACCOUNT_DELETED_PATH}?guest=1`;

/**
 * A share-link guest leaving for good: removed from every score shared with
 * them and their anonymous account deleted, by the same delete-account
 * function (it needs no password from a guest and makes no billing calls).
 *
 * Marks they made stay on the scores — so what has not reached the server yet
 * is uploaded first, best effort, the same way sign-out does it. Afterwards
 * the device forgets the guest the way sign-out forgets an account: their
 * cached scores and cloud-score marks go, and anything opened from this device
 * (not the guest's) stays. Throws an AccountDeletionError, with nothing
 * deleted locally, when the server did not finish.
 */
export const deleteGuestProfile = async (): Promise<void> => {
    const { clearAccountCachesFromDevice, syncBeforeSignOut } = await import('@/features/auth/session');
    await syncBeforeSignOut().catch(() => undefined);
    await requestAccountDeletion();
    forgetLocalSession();
    await stopLocalWriters();
    try {
        await clearAccountCachesFromDevice();
    } catch {
        // IndexedDB unavailable: there is nothing cached to clear.
    }
};

/** Preference keys the app writes (imslpPrefs, libraryPrefs, viewerPrefs, installPrefs). */
const APP_KEY_PREFIX = 'cleffy:';

/**
 * Everything Cleffy keeps in this browser, gone — after the account is.
 *
 * Wider than sign-out on purpose. Sign-out (session.ts signOut) clears the
 * account's cloud-score data -- marks, outbox, watermarks, day snapshots --
 * after syncBeforeSignOut has uploaded what it could and the user has been
 * warned about the rest, but it keeps what is not the account's: marks on
 * device-only (`local-…`) scores, and the app's display preferences. Here the
 * account is gone, and nothing on the device should outlive it, so every
 * Dexie table is cleared -- device-only scores' marks included -- every app
 * preference key and stored session removed, and the restore cookie expired.
 *
 * Each step is best-effort and independent: the server-side deletion has
 * already happened, and one store failing to clear must not stop the others.
 */
export const clearLocalAccountData = async (): Promise<void> => {
    forgetLocalSession();
    await stopLocalWriters();

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
