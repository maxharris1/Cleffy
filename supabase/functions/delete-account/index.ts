import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type Stripe from 'npm:stripe@18';

import {
    DELETE_CONFIRMATION,
    deleteAccount,
    type DeletionPorts,
    type StripeMode,
    type StripePort,
} from '../_shared/accountDeletion.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { checkRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { servedModes, stripeClient } from '../_shared/stripe.ts';

/**
 * Deletes the calling user's account and everything it owns. The decisions —
 * what is refused, what is deleted, and in which order — live in
 * _shared/accountDeletion.ts, where they are tested; this file binds them to
 * the service-role client, Storage and Stripe.
 *
 * Two gates ahead of it, both because this is the one irreversible action in
 * the product:
 *  * the body must carry `confirm: "DELETE"`, the word the user typed, so no
 *    other client code path can reach this by accident;
 *  * the body must carry the account's current password, verified against
 *    GoTrue. A leaked access token (an XSS, a borrowed device) can do a lot of
 *    damage in an hour, but it must not be able to erase a paying teacher's
 *    library and roster for good.
 *
 * A retry after success is answered 200 `already_deleted`: the JWT still
 * verifies until it expires, and GoTrue then says the user no longer exists,
 * which is exactly the state the caller asked for.
 */

const FN = 'delete-account';
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Storage list() page size; folders hold a handful of objects, but never assume. */
const LIST_PAGE = 1000;

interface DeleteBody {
    confirm?: unknown;
    password?: unknown;
}

const readBody = async (req: Request): Promise<DeleteBody | null> => {
    try {
        const parsed = await req.json();
        return parsed && typeof parsed === 'object' ? (parsed as DeleteBody) : null;
    } catch {
        return null;
    }
};

const isStripeMissing = (err: unknown): boolean =>
    Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'resource_missing');

const stripePort = (stripe: Stripe): StripePort => ({
    listSubscriptions: async (customerId) => {
        const out: { id: string; status: string }[] = [];
        for await (const sub of stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
            out.push({ id: sub.id, status: sub.status });
        }
        return out;
    },
    retrieveSubscription: async (subscriptionId) => {
        try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            return { id: sub.id, status: sub.status };
        } catch (err) {
            if (isStripeMissing(err)) {
                return null;
            }
            throw err;
        }
    },
    cancelSubscription: async (subscriptionId) => {
        try {
            // Immediate, not at period end: the account is about to stop existing,
            // so there is nothing left for a remaining period to pay for.
            await stripe.subscriptions.cancel(subscriptionId);
            return 'canceled';
        } catch (err) {
            if (isStripeMissing(err)) {
                return 'missing';
            }
            throw err;
        }
    },
    expireOpenCheckoutSessions: async (customerId) => {
        let expired = 0;
        for await (const session of stripe.checkout.sessions.list({
            customer: customerId,
            status: 'open',
            limit: 100,
        })) {
            await stripe.checkout.sessions.expire(session.id);
            expired += 1;
        }
        return expired;
    },
    findCustomersByUserId: async (userId) => {
        // The id is a GoTrue uuid (validated below), so it cannot break out of
        // the quoted search term.
        if (!uuidRe.test(userId)) {
            return [];
        }
        const result = await stripe.customers.search({ query: `metadata['user_id']:'${userId}'`, limit: 100 });
        return result.data.map((customer) => customer.id);
    },
});

/**
 * Every object under `prefix/`, however deep. Storage's list() returns one
 * level, with sub-folders as entries whose `id` is null; those are walked
 * rather than handed to remove(), which would accept them and delete nothing.
 * Re-lists from the top after each removal instead of paging by offset, since
 * removing shifts the listing and an offset would skip objects — and stops with
 * an error if a pass removes nothing, so a listing that never empties cannot
 * spin forever.
 */
const removeFolder = async (admin: SupabaseClient, bucket: string, prefix: string): Promise<number> => {
    let removed = 0;
    for (;;) {
        const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: LIST_PAGE });
        if (error) {
            throw new Error(`could not list ${bucket}/${prefix}: ${error.message}`);
        }
        const entries = data ?? [];
        const files = entries.filter((entry) => entry.id !== null).map((entry) => `${prefix}/${entry.name}`);
        const folders = entries.filter((entry) => entry.id === null).map((entry) => `${prefix}/${entry.name}`);
        for (const folder of folders) {
            removed += await removeFolder(admin, bucket, folder);
        }
        if (files.length === 0) {
            return removed;
        }
        const { data: gone, error: removeError } = await admin.storage.from(bucket).remove(files);
        if (removeError) {
            throw new Error(`could not remove objects under ${bucket}/${prefix}: ${removeError.message}`);
        }
        if ((gone ?? []).length === 0) {
            throw new Error(`removing objects under ${bucket}/${prefix} made no progress`);
        }
        removed += (gone ?? []).length;
    }
};

const ports = (admin: SupabaseClient): DeletionPorts => ({
    billingCustomers: async (userId) => {
        const { data, error } = await admin
            .from('billing_customers')
            .select('stripe_customer_id, mode')
            .eq('user_id', userId);
        if (error) {
            throw new Error(`could not read billing customers: ${error.message}`);
        }
        return (data ?? []).map((row) => ({
            customerId: row.stripe_customer_id as string,
            mode: row.mode as StripeMode,
        }));
    },
    storedSubscriptions: async (userId) => {
        const { data, error } = await admin
            .from('subscriptions')
            .select('stripe_subscription_id, mode, status')
            .eq('user_id', userId);
        if (error) {
            throw new Error(`could not read subscriptions: ${error.message}`);
        }
        return (data ?? []).map((row) => ({
            subscriptionId: row.stripe_subscription_id as string,
            mode: row.mode as StripeMode,
            status: row.status as string,
        }));
    },
    stripeFor: (mode) => {
        // An account this deployment does not serve (test on production) has no
        // key here by design; answer null without stripeClient's config error.
        if (!servedModes().includes(mode)) {
            return null;
        }
        const client = stripeClient(mode);
        return client ? stripePort(client) : null;
    },
    managedStudents: async (teacherId) => {
        const { data, error } = await admin
            .from('managed_students')
            .select('student_user_id')
            .eq('teacher_id', teacherId);
        if (error) {
            throw new Error(`could not read the roster: ${error.message}`);
        }
        return (data ?? []).map((row) => row.student_user_id as string);
    },
    studentAccount: async (studentUserId) => {
        const { data, error } = await admin.auth.admin.getUserById(studentUserId);
        if (error) {
            if (error.status === 404 || (error as { code?: string }).code === 'user_not_found') {
                return null;
            }
            throw new Error(`could not read student account ${studentUserId}: ${error.message}`);
        }
        if (!data.user) {
            return null;
        }
        const meta = (data.user.app_metadata ?? {}) as Record<string, unknown>;
        return {
            userType: meta['user_type'] === 'student' ? 'student' : null,
            teacherId: typeof meta['teacher_id'] === 'string' ? meta['teacher_id'] : null,
        };
    },
    ownedDocuments: async (userId) => {
        const ids: string[] = [];
        // Paged: PostgREST caps a response at max_rows (1000) however many exist.
        for (let from = 0; ; from += LIST_PAGE) {
            const { data, error } = await admin
                .from('documents')
                .select('id')
                .eq('owner_id', userId)
                .order('id')
                .range(from, from + LIST_PAGE - 1);
            if (error) {
                throw new Error(`could not list documents: ${error.message}`);
            }
            ids.push(...(data ?? []).map((row) => row.id as string));
            if ((data ?? []).length < LIST_PAGE) {
                return ids;
            }
        }
    },
    removeStorageFolder: async (bucket, documentId) => removeFolder(admin, bucket, documentId),
    deleteDocument: async (documentId) => {
        const { error } = await admin.from('documents').delete().eq('id', documentId);
        if (error) {
            throw new Error(`could not delete document ${documentId}: ${error.message}`);
        }
    },
    deleteStudiosAndMemberships: async (userId) => {
        for (const [table, column] of [
            ['studios', 'owner_id'],
            ['studio_members', 'user_id'],
            ['document_members', 'user_id'],
        ] as const) {
            const { error } = await admin.from(table).delete().eq(column, userId);
            if (error) {
                throw new Error(`could not delete ${table} rows: ${error.message}`);
            }
        }
    },
    releaseAuthorship: async (userId) => {
        // The service-role client's JWT carries role=service_role, which is what
        // guard_score_analyses_client_write admits; GoTrue's own ON DELETE SET
        // NULL arrives with no JWT and is refused as a client write. The other
        // SET NULL authorship columns (annotations, annotation_snapshots,
        // document_imports, omr_jobs) have no trigger that refuses it.
        const { error } = await admin.from('score_analyses').update({ created_by: null }).eq('created_by', userId);
        if (error) {
            throw new Error(`could not release score_analyses authorship: ${error.message}`);
        }
    },
    deleteAuthUser: async (userId) => {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (!error) {
            return 'deleted';
        }
        if (error.status === 404 || (error as { code?: string }).code === 'user_not_found') {
            return 'not_found';
        }
        throw new Error(`could not delete auth user: ${error.message}`);
    },
    log: (message) => console.log(`${FN}: ${message}`),
});

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const admin = serviceClient();
    if (!supabaseUrl || !anonKey || !admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // requireUser() collapses every failure to 401; this endpoint needs to tell
    // "the account is already gone" (a retry after success) from a bad token.
    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
        // GoTrue verified the token's signature before looking the user up, so
        // user_not_found means a genuine token for an account that no longer exists.
        if ((userError as { code?: string } | null)?.code === 'user_not_found') {
            return jsonResponse({ deleted: true, alreadyDeleted: true });
        }
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const user = userData.user;

    const rate = await checkRateLimit(`delete-account:${user.id}`, 5, 10 * 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many attempts', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const body = await readBody(req);
    if (!body || body.confirm !== DELETE_CONFIRMATION) {
        return jsonResponse({ error: `Type ${DELETE_CONFIRMATION} to confirm`, code: 'confirmation_required' }, 400);
    }

    const caller = {
        userId: user.id,
        isAnonymous: user.is_anonymous === true,
        userType: user.app_metadata?.user_type === 'student' ? ('student' as const) : null,
    };

    // The refusals need no password: answer them before asking GoTrue anything.
    if (!caller.isAnonymous && caller.userType !== 'student') {
        const password = typeof body.password === 'string' ? body.password : '';
        if (!user.email || password.length === 0) {
            return jsonResponse({ error: 'Enter your password to confirm', code: 'password_required' }, 400);
        }
        // A throwaway client: the verification session must not touch the
        // caller's, and is signed out (locally, this session only) right after.
        const verifier = createClient(supabaseUrl, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: verified, error: verifyError } = await verifier.auth.signInWithPassword({
            email: user.email,
            password,
        });
        if (verifyError?.status === 429) {
            return jsonResponse(
                { error: 'Too many attempts. Wait a few minutes and try again.', code: 'rate_limited' },
                429,
            );
        }
        if (verifyError && (!verifyError.status || verifyError.status >= 500)) {
            // GoTrue itself failed: "wrong password" would send the person off to
            // reset a password that was right all along.
            logError(FN, verifyError, { code: 'reauthentication_unavailable', userId: user.id });
            return jsonResponse(
                {
                    error: 'We could not check your password just now, so nothing has been deleted. Please try again.',
                    code: 'reauthentication_unavailable',
                },
                503,
            );
        }
        if (verifyError || verified.user?.id !== user.id) {
            return jsonResponse({ error: 'That password is not correct.', code: 'reauthentication_failed' }, 403);
        }
        await verifier.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }

    try {
        const result = await deleteAccount(caller, ports(admin));
        if (!result.ok) {
            if (result.status >= 500) {
                logError(FN, result.cause ?? new Error(result.error), { code: result.code, userId: user.id });
            }
            return jsonResponse({ error: result.error, code: result.code }, result.status);
        }
        console.log(
            JSON.stringify({ level: 'info', fn: FN, event: 'account_deleted', userId: user.id, ...result.summary }),
        );
        if (result.lateBillingFailure !== undefined) {
            // The account is gone, so the person is told it worked — it did. A
            // subscription started mid-deletion may still exist, though, so this
            // must reach a human (stripe-webhook cancels it too when it reports in).
            logError(FN, result.lateBillingFailure, { code: 'late_billing_sweep_failed', userId: user.id });
        }
        return jsonResponse({ deleted: true, summary: result.summary });
    } catch (err) {
        logError(FN, err, { code: 'unexpected', userId: user.id });
        return jsonResponse({ error: 'Account deletion did not finish. Please try again.', code: 'unexpected' }, 502);
    }
});
