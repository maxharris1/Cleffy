/**
 * Self-serve account deletion: the decisions and their order.
 *
 * NO imports, and every side effect arrives through `DeletionPorts`, so vitest
 * drives this exact file against in-memory fakes (tests/account) and the
 * delete-account Edge Function binds the ports to Stripe, Storage and the
 * service-role client. Same split as stripeEvents.ts / stripe-webhook.
 *
 * THE ORDER IS THE SAFETY ARGUMENT:
 *
 *  1. Refuse what this endpoint must never delete. A share-link guest has no
 *     account to delete (signing out discards it). A provisioned student is not
 *     theirs to delete: the account was created, is paid for and is controlled
 *     by their teacher (20260826194426_roster.sql), and a child must not be able
 *     to orphan a roster seat or destroy work their teacher assigned. The UI
 *     explains this and points them at their teacher or support.
 *
 *  2. Stop the money FIRST, and completely, before a single row is touched.
 *     Every subscription the caller has, in every Stripe account (live and
 *     test, see stripeMode.ts) we hold a customer for, is cancelled immediately,
 *     and open Checkout sessions are expired so a tab left open cannot start a
 *     new one afterwards. If any of that fails — or the live key is missing —
 *     the whole request fails with nothing deleted. The worst outcome a paying
 *     customer can suffer here is "my data is gone and I am still being
 *     charged", and this ordering makes it unreachable.
 *
 *  3. Delete the teacher's provisioned students. Their accounts exist only as
 *     part of this teacher's roster; once the teacher is gone nobody can reset,
 *     archive or pay for them, so they go too (each the same way: their own
 *     scores — none, by policy, but checked — then the auth user, whose FK
 *     cascades take the roster row, assignments and practice notes). Only an
 *     account still flagged as a student of THIS teacher is deleted.
 *
 *  4. Delete every score the caller OWNS: Storage objects first (both buckets),
 *     then the row, whose FK cascades take members, share links, annotations,
 *     snapshots, favourites, tags and analyses. Storage first because a row
 *     deleted before its objects would leave files nothing can find again; the
 *     reverse order leaves at worst a row whose file is gone, which the retry
 *     then deletes. Steps 3 and 4 run twice, the second pass sweeping up
 *     anything another tab created while the first was running.
 *
 *  5. Remove the caller's memberships and dissolve any Academy studio they own.
 *     The auth delete would cascade these too; doing it explicitly first means
 *     collaborators lose access the moment the request is accepted rather than
 *     depending on cascade behaviour this file cannot see.
 *
 *  6. Delete the auth user. Marks the caller drew on OTHER people's scores
 *     survive with their author cleared (20261007120600_account_deletion.sql):
 *     they are part of a score somebody else owns, and silently erasing them
 *     from a paying teacher's copy is the worse failure. Every other
 *     user-keyed FK is CASCADE or SET NULL, but SET NULL is an UPDATE, and an
 *     UPDATE trigger can still refuse it: score_analyses' client-write guard
 *     (20260803120000) treats any write without a service_role JWT as a
 *     client's, and GoTrue's admin delete carries no JWT at all, so a play-along
 *     analysis the caller requested on someone else's score would abort the
 *     auth delete on every retry. `releaseAuthorship` clears that authorship
 *     first, as the service role the guard admits.
 *
 *  7. Sweep billing once more. Step 2 ran while the caller's tokens were still
 *     valid, so a Checkout opened from another tab in between (stripe-checkout
 *     reuses the existing customer) could still complete and start a
 *     subscription for an account that no longer exists. Once the auth user is
 *     gone no new session can be minted, so expiring and cancelling again for
 *     every customer step 2 knew closes that window for good. The account is
 *     already deleted by then, so a failure here is reported, not returned —
 *     and stripe-webhook cancels any subscription that resolves to a deleted
 *     account as a last line (deletedAccountBilling.ts).
 *
 * Every step is idempotent, so a request that times out or fails part-way is
 * safely retried: cancelled subscriptions are skipped, deleted rows are no
 * longer listed, and an auth user that is already gone counts as deleted.
 */

export type StripeMode = 'live' | 'test';

/** Subscription statuses that can never bill again. Everything else is cancelled. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export interface DeletionCaller {
    userId: string;
    isAnonymous: boolean;
    userType: 'student' | null;
}

export interface StripeCustomerRef {
    customerId: string;
    mode: StripeMode;
}

export interface StoredSubscriptionRef {
    subscriptionId: string;
    mode: StripeMode;
    status: string;
}

export interface StudentAccountRef {
    userType: 'student' | null;
    teacherId: string | null;
}

export interface StripeSubscriptionRef {
    id: string;
    status: string;
}

/** The slice of the Stripe API deletion needs, per account. */
export interface StripePort {
    listSubscriptions: (customerId: string) => Promise<StripeSubscriptionRef[]>;
    /** Null when Stripe has no such subscription (already gone). */
    retrieveSubscription: (subscriptionId: string) => Promise<StripeSubscriptionRef | null>;
    /** Immediate cancellation. 'missing' when Stripe no longer has it. */
    cancelSubscription: (subscriptionId: string) => Promise<'canceled' | 'missing'>;
    /** Expires every open Checkout session for the customer; returns how many. */
    expireOpenCheckoutSessions: (customerId: string) => Promise<number>;
    /**
     * Customers carrying metadata.user_id = userId, as stripe-checkout creates
     * them. A redundancy for a customer whose billing_customers row was never
     * written; failures are tolerated by the caller.
     */
    findCustomersByUserId: (userId: string) => Promise<string[]>;
}

export interface DeletionPorts {
    billingCustomers: (userId: string) => Promise<StripeCustomerRef[]>;
    storedSubscriptions: (userId: string) => Promise<StoredSubscriptionRef[]>;
    /** Null when no usable key is configured for that account. */
    stripeFor: (mode: StripeMode) => StripePort | null;
    /** student_user_id of every roster row this teacher owns, archived or not. */
    managedStudents: (teacherId: string) => Promise<string[]>;
    /**
     * The auth user behind a roster row, as the admin API reports it: its
     * admin-set app_metadata flag and owning teacher. Null when the auth user no
     * longer exists (a retry after it was already deleted).
     */
    studentAccount: (studentUserId: string) => Promise<StudentAccountRef | null>;
    ownedDocuments: (userId: string) => Promise<string[]>;
    /** Removes every object under `{documentId}/` in the bucket. Throws on failure. */
    removeStorageFolder: (bucket: 'scores' | 'thumbnails', documentId: string) => Promise<number>;
    deleteDocument: (documentId: string) => Promise<void>;
    /** Studios the user owns (cascading their seats), and every seat and membership they hold. */
    deleteStudiosAndMemberships: (userId: string) => Promise<void>;
    /**
     * Clears created_by on the rows whose triggers would refuse the auth
     * delete's own ON DELETE SET NULL (score_analyses), as the service role.
     */
    releaseAuthorship: (userId: string) => Promise<void>;
    deleteAuthUser: (userId: string) => Promise<'deleted' | 'not_found'>;
    log: (message: string) => void;
}

export interface DeletionSummary {
    subscriptionsCanceled: number;
    checkoutSessionsExpired: number;
    studentsDeleted: number;
    documentsDeleted: number;
    storageObjectsRemoved: number;
    authUser: 'deleted' | 'not_found';
    /** Step 7, after the auth user is gone. 'failed' is logged loudly by the caller. */
    lateBillingSweep: 'done' | 'failed';
    /** Subscriptions step 7 found and cancelled: started from another tab mid-deletion. */
    lateSubscriptionsCanceled: number;
}

export type DeletionFailureCode =
    | 'anonymous_session'
    | 'managed_student'
    | 'billing_unavailable'
    | 'billing_cancel_failed'
    | 'student_delete_failed'
    | 'document_delete_failed'
    | 'membership_delete_failed'
    | 'auth_delete_failed';

export type DeletionResult =
    | { ok: true; summary: DeletionSummary; lateBillingFailure?: unknown }
    | { ok: false; status: number; code: DeletionFailureCode; error: string; cause?: unknown };

export type DeletionFailure = Extract<DeletionResult, { ok: false }>;

const fail = (status: number, code: DeletionFailureCode, error: string, cause?: unknown): DeletionFailure => ({
    ok: false,
    status,
    code,
    error,
    cause,
});

export interface BillingCancellation {
    ok: true;
    canceled: number;
    expired: number;
    /** Every customer swept, so step 7 can sweep them again once the tables have cascaded away. */
    customers: StripeCustomerRef[];
}

/**
 * Step 2 (and step 7). Cancels everything that can still bill, in every account
 * we have a customer in, or reports why it could not — in which case, in step
 * 2, nothing has been deleted. `knownCustomers` adds customers the tables may
 * no longer list: after the auth delete, billing_customers has cascaded away.
 */
export const cancelBilling = async (
    userId: string,
    ports: DeletionPorts,
    knownCustomers: readonly StripeCustomerRef[] = [],
): Promise<BillingCancellation | DeletionFailure> => {
    let customers: StripeCustomerRef[];
    let stored: StoredSubscriptionRef[];
    try {
        customers = [...knownCustomers, ...(await ports.billingCustomers(userId))];
        stored = await ports.storedSubscriptions(userId);
    } catch (err) {
        // Not knowing whether someone pays is the same as not being able to stop it.
        return fail(
            502,
            'billing_cancel_failed',
            'We could not check your subscription, so nothing has been deleted. Please try again, or contact support.',
            err,
        );
    }

    // Accounts in play: any we hold a customer in, or a subscription that can
    // still bill. A mode with neither needs no key at all.
    const modes = new Set<StripeMode>();
    for (const customer of customers) {
        modes.add(customer.mode);
    }
    for (const sub of stored) {
        if (!TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
            modes.add(sub.mode);
        }
    }

    // Also look for a customer the checkout created but never recorded, in
    // every account this deployment can reach. Best effort: search is a
    // redundancy, and an unavailable search must not block a deletion the
    // billing tables already fully describe.
    const searched = new Map<StripeMode, string[]>();
    for (const mode of ['live', 'test'] as const) {
        const stripe = ports.stripeFor(mode);
        if (!stripe) {
            continue;
        }
        try {
            const found = await stripe.findCustomersByUserId(userId);
            if (found.length > 0) {
                searched.set(mode, found);
                modes.add(mode);
            }
        } catch (err) {
            ports.log(`customer search in ${mode} mode failed for ${userId}: ${String(err)}`);
        }
    }

    let canceled = 0;
    let expired = 0;
    const swept: StripeCustomerRef[] = [];

    for (const mode of modes) {
        const stripe = ports.stripeFor(mode);
        if (!stripe) {
            if (mode === 'live') {
                // A real card may still be charged. Refuse rather than delete the
                // account out from under a subscription we cannot stop.
                return fail(
                    503,
                    'billing_unavailable',
                    'Billing is temporarily unavailable, so your subscription could not be cancelled. Nothing has been deleted — please try again later or contact support.',
                );
            }
            // Test mode never moves real money; a missing sandbox key (production
            // serves live only) is not a reason to keep someone's data.
            ports.log(`skipping test-mode billing cleanup for ${userId}: no test-mode key configured`);
            continue;
        }

        try {
            const customerIds = new Set<string>([
                ...customers.filter((c) => c.mode === mode).map((c) => c.customerId),
                ...(searched.get(mode) ?? []),
            ]);
            const handled = new Set<string>();

            for (const customerId of customerIds) {
                swept.push({ customerId, mode });
                // Expire first: a Checkout session completed between the list and
                // the cancel below would otherwise create a subscription after it.
                expired += await stripe.expireOpenCheckoutSessions(customerId);
                for (const sub of await stripe.listSubscriptions(customerId)) {
                    handled.add(sub.id);
                    if (TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
                        continue;
                    }
                    if ((await stripe.cancelSubscription(sub.id)) === 'canceled') {
                        canceled += 1;
                    }
                }
            }

            // Our own record, for a subscription whose customer row is missing.
            // Stripe is asked for the live status rather than trusting the stored
            // one, which is only as fresh as the last webhook.
            for (const sub of stored) {
                if (sub.mode !== mode || handled.has(sub.subscriptionId)) {
                    continue;
                }
                if (TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
                    continue;
                }
                const remote = await stripe.retrieveSubscription(sub.subscriptionId);
                if (!remote || TERMINAL_SUBSCRIPTION_STATUSES.has(remote.status)) {
                    continue;
                }
                if ((await stripe.cancelSubscription(sub.subscriptionId)) === 'canceled') {
                    canceled += 1;
                }
            }
        } catch (err) {
            return fail(
                502,
                'billing_cancel_failed',
                'We could not cancel your subscription, so nothing has been deleted. Please try again, or contact support.',
                err,
            );
        }
    }

    return { ok: true, canceled, expired, customers: swept };
};

/**
 * Step 6's last moment: authorship that would block the delete is released,
 * then the auth user goes. One immediate second attempt, because the only
 * known way for the first to fail on data is a row authored by this user
 * landing between the release and the delete (another tab); anything else —
 * GoTrue down — fails the same way twice and is left to the caller's retry.
 */
const closeAuthUser = async (userId: string, ports: DeletionPorts): Promise<'deleted' | 'not_found'> => {
    await ports.releaseAuthorship(userId);
    try {
        return await ports.deleteAuthUser(userId);
    } catch (err) {
        ports.log(`auth delete for ${userId} failed once, releasing authorship and retrying: ${String(err)}`);
        await ports.releaseAuthorship(userId);
        return ports.deleteAuthUser(userId);
    }
};

/** Step 4 for one owner: every score's files, then its row. Returns objects removed. */
export const purgeOwnedDocuments = async (
    userId: string,
    ports: DeletionPorts,
): Promise<{ documents: number; objects: number }> => {
    let documents = 0;
    let objects = 0;
    for (const documentId of await ports.ownedDocuments(userId)) {
        objects += await ports.removeStorageFolder('scores', documentId);
        objects += await ports.removeStorageFolder('thumbnails', documentId);
        await ports.deleteDocument(documentId);
        documents += 1;
    }
    return { documents, objects };
};

/**
 * Step 3 for one teacher: every provisioned student on their roster.
 *
 * A roster row is only a pointer, so the auth user behind it is checked before
 * anything irreversible happens to it: it must still carry the admin-set
 * student flag AND name this teacher as its owner (student-provision writes
 * both). Anything else — an ordinary account somehow linked by a bad row — is
 * left alone and logged; the roster row itself still goes with the teacher.
 */
export const purgeManagedStudents = async (
    teacherId: string,
    ports: DeletionPorts,
): Promise<{ students: number; objects: number }> => {
    let students = 0;
    let objects = 0;
    for (const studentUserId of await ports.managedStudents(teacherId)) {
        const account = await ports.studentAccount(studentUserId);
        if (!account) {
            // Already gone (a retry); its roster row cascades with the teacher.
            continue;
        }
        if (account.userType !== 'student' || account.teacherId !== teacherId) {
            ports.log(
                `roster of ${teacherId} points at ${studentUserId}, which is not a student provisioned by them; ` +
                    'leaving that account in place',
            );
            continue;
        }
        const purged = await purgeOwnedDocuments(studentUserId, ports);
        objects += purged.objects;
        await ports.deleteStudiosAndMemberships(studentUserId);
        if ((await closeAuthUser(studentUserId, ports)) === 'deleted') {
            students += 1;
        }
    }
    return { students, objects };
};

/**
 * How many times steps 3 and 4 run. The second pass is a sweep for anything
 * created while the first was running — a score uploaded, or a student
 * provisioned, from another tab with a still-valid token. Without it that row
 * would go with the auth user's cascade but leave its Storage objects, or its
 * student account, behind with nothing pointing at them.
 */
const SWEEP_PASSES = 2;

export const deleteAccount = async (caller: DeletionCaller, ports: DeletionPorts): Promise<DeletionResult> => {
    if (caller.isAnonymous) {
        return fail(
            403,
            'anonymous_session',
            'Guest sessions have no account to delete. Signing out removes the guest session.',
        );
    }
    if (caller.userType === 'student') {
        return fail(
            403,
            'managed_student',
            'This account is managed by your teacher. Ask your teacher to remove you from their roster, or contact support.',
        );
    }

    const billing = await cancelBilling(caller.userId, ports);
    if (!billing.ok) {
        return billing;
    }

    let studentsDeleted = 0;
    let documentsDeleted = 0;
    let storageObjectsRemoved = 0;
    for (let pass = 0; pass < SWEEP_PASSES; pass += 1) {
        try {
            const students = await purgeManagedStudents(caller.userId, ports);
            studentsDeleted += students.students;
            storageObjectsRemoved += students.objects;
        } catch (err) {
            return fail(
                502,
                'student_delete_failed',
                'We could not remove the student accounts on your roster. Your subscription is cancelled; please try again to finish deleting your account.',
                err,
            );
        }

        try {
            const purged = await purgeOwnedDocuments(caller.userId, ports);
            documentsDeleted += purged.documents;
            storageObjectsRemoved += purged.objects;
        } catch (err) {
            return fail(
                502,
                'document_delete_failed',
                'We could not delete all of your scores. Your subscription is cancelled; please try again to finish deleting your account.',
                err,
            );
        }
    }

    try {
        await ports.deleteStudiosAndMemberships(caller.userId);
    } catch (err) {
        return fail(
            502,
            'membership_delete_failed',
            'We could not remove you from shared scores. Your scores are deleted; please try again to finish deleting your account.',
            err,
        );
    }

    let authUser: 'deleted' | 'not_found';
    try {
        authUser = await closeAuthUser(caller.userId, ports);
    } catch (err) {
        return fail(
            502,
            'auth_delete_failed',
            'Your data is deleted but we could not close the account itself. Please try again to finish.',
            err,
        );
    }

    // Step 7. Nothing below can undo the deletion, so nothing below fails it.
    let lateBillingSweep: DeletionSummary['lateBillingSweep'] = 'done';
    let lateSubscriptionsCanceled = 0;
    let lateBillingFailure: unknown;
    let checkoutSessionsExpired = billing.expired;
    try {
        const late = await cancelBilling(caller.userId, ports, billing.customers);
        if (late.ok) {
            lateSubscriptionsCanceled = late.canceled;
            checkoutSessionsExpired += late.expired;
        } else {
            lateBillingSweep = 'failed';
            lateBillingFailure = late.cause ?? new Error(late.error);
        }
    } catch (err) {
        lateBillingSweep = 'failed';
        lateBillingFailure = err;
    }

    return {
        ok: true,
        summary: {
            subscriptionsCanceled: billing.canceled + lateSubscriptionsCanceled,
            checkoutSessionsExpired,
            studentsDeleted,
            documentsDeleted,
            storageObjectsRemoved,
            authUser,
            lateBillingSweep,
            lateSubscriptionsCanceled,
        },
        ...(lateBillingFailure === undefined ? {} : { lateBillingFailure }),
    };
};

/** The phrase the client must send, matching what the user typed to confirm. */
export const DELETE_CONFIRMATION = 'DELETE';
