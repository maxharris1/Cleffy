/**
 * Is this account being deleted? The one check every Edge Function that writes
 * for a user with the service role calls before it writes.
 *
 * NO imports, like studentSessions.ts: Deno loads it with the `.ts` extension
 * and vitest without. The client is anything with supabase-js's `rpc` shape.
 *
 * Why the functions ask at all. The database guards
 * (20261022110100_account_deletion_pending.sql, 20261022110600_account_deletion_barrier.sql)
 * are triggers on documents, managed_students, document_members and
 * checkout_attempts, which fire for the service role too, and restrictive RLS
 * policies on storage.objects, which do NOT: the service role bypasses RLS. And
 * some of what a function does for a user is outside the database altogether
 * (an Auth account's password, a Stripe customer, an OMR job). So each
 * service-role writer asks account_deletion_pending() -- the same predicate
 * every trigger and policy uses (20261022110400_account_deletion_attempts.sql)
 * -- before its first write, and refuses with 409 while it is pending. The
 * triggers stay the in-transaction backstop.
 *
 * Fails closed: an unanswered check is `ok: false`, and the callers refuse.
 */

export interface PendingRpcClient {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

export type DeletionPendingCheck = { ok: true; pending: boolean } | { ok: false; message: string };

/** The refusal body, with the code every trigger's refusal is answered with. */
export const ACCOUNT_DELETION_PENDING = {
    error: 'This account is being deleted, so nothing can be added to or changed in it now.',
    code: 'account_deletion_pending',
} as const;

const messageOf = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error);

export const accountDeletionPending = async (
    client: PendingRpcClient,
    userId: string,
): Promise<DeletionPendingCheck> => {
    try {
        const { data, error } = await client.rpc('account_deletion_pending', { p_user: userId });
        if (error) {
            return { ok: false, message: messageOf(error) };
        }
        return { ok: true, pending: data === true };
    } catch (err) {
        return { ok: false, message: messageOf(err) };
    }
};
