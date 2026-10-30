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
 *  1. Refuse what this endpoint must never delete. A provisioned student is not
 *     theirs to delete: the account was created, is paid for and is controlled
 *     by their teacher (20260826194426_roster.sql), and a child must not be able
 *     to orphan a roster seat or destroy work their teacher assigned. The UI
 *     explains this and points them at their teacher or support.
 *
 *     A share-link guest (an anonymous auth user) takes a short path of its
 *     own, deleteGuest below: signing out only drops the session from the
 *     browser, and the guest's name, memberships and auth user would otherwise
 *     stay on the server with nobody able to remove them. A guest can own
 *     nothing that bills or holds files -- stripe-checkout refuses anonymous
 *     callers and documents_insert refuses an anonymous JWT -- so steps 2 and 3
 *     do not apply, and a guest who added an email is no longer anonymous and
 *     goes the whole way, password and all.
 *
 *  1b. Mark the deletion PENDING (account_deletions,
 *     20261022110100_account_deletion_pending.sql) before anything else, as an
 *     ATTEMPT under a lease (20261022110400_account_deletion_attempts.sql).
 *     From that moment the database refuses any new score or roster row for
 *     this account, whoever inserts it -- another tab, an import,
 *     student-provision -- so steps 3 and 4 clean up a state that can no
 *     longer grow. Taking the marker waits for any such insert already in
 *     flight. Right before step 3 deletes anything the attempt records that
 *     destructive cleanup began. If this attempt then deletes nothing (step 2
 *     fails) it is settled abandoned, and once no attempt is active the marker
 *     is cleared and the account is exactly as it was -- however many attempts
 *     there were; a crashed attempt stops restricting when its lease runs out.
 *     Once cleanup began, the restriction stays until a retry completes, so a
 *     half-deleted account cannot grow while the person retries; when the auth
 *     user goes, the marker cascades with it.
 *
 *  1c. Refuse while a checkout another tab started is still in flight: it took
 *     its lease before the marker (which now refuses any new one) and could
 *     open a Stripe session after both billing sweeps. Nothing is deleted; the
 *     person tries again once it has finished or gone stale (5 minutes).
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
 *     account still flagged as a student of THIS teacher is deleted. That
 *     includes accounts a provisioning made that never got their roster row
 *     (student_provision_intents, 20261022110600): registered before the Auth
 *     account was created, so a crash in between is found here, not orphaned.
 *
 *  4. Delete every score the caller OWNS: Storage objects first (both buckets),
 *     then the row, whose FK cascades take members, share links, annotations,
 *     snapshots, favourites, tags and analyses. Storage first because a row
 *     deleted before its objects would leave files nothing can find again; the
 *     reverse order leaves at worst a row whose file is gone, which the retry
 *     then deletes. Then the owner's document_storage_cleanup tombstones
 *     (20261007120401): every documents delete writes one, including the ones
 *     just made, and a score deleted earlier from the library whose detached
 *     Storage cleanup never finished still has its folders on record there.
 *     Both folders of each are emptied and only then is the tombstone dropped.
 *     This has to happen here, while the account exists: the library's own
 *     retry runs in the owner's session, and once the auth user is gone
 *     nothing else knows those folders are orphaned. Steps 3 and 4 repeat
 *     until a pass finds nothing left; with the marker in place the second
 *     pass is the one that confirms it.
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
 *     as first written (20260803120000) treated any write without a
 *     service_role JWT as a client's, and GoTrue's admin delete carries no JWT
 *     at all, so a play-along analysis the caller requested on someone else's
 *     score aborted the auth delete on every retry. 20261007120100 re-keys that
 *     guard on the database role (the FK action runs as the table owner and
 *     passes); `releaseAuthorship` still clears that authorship first, as the
 *     service role, so deletion does not depend on which guard is deployed.
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

export interface ProvisionIntent {
    rosterId: string;
    /**
     * The Auth account the intent points at: the one it recorded, or one at its
     * address made inside its window. Null when there is none.
     */
    studentUserId: string | null;
    /** True while the request that registered it may still be running. */
    live: boolean;
    /**
     * True only when studentUserId is the account the intent recorded and it
     * was made inside the intent's window (DEPLOY.md's proof (A),
     * 20261022140400). Nothing else permits deleting it: an address match
     * also fits another intent's account or a separate signup.
     */
    proven: boolean;
    /**
     * studentUserId is null, but an account with no roster row sits at the
     * intent's address all the same (outside the window, or another intent's):
     * 'unproven_match' (20261022140400). Not "nothing was created": DEPLOY.md's
     * case 5, so the intent is kept for the runbook.
     */
    unprovenMatch: boolean;
}

/** One row of student_provision_intents_proven() (20261022140400), as the RPC returns it. */
export interface ProvisionIntentRow {
    roster_id: string;
    student_user_id: string | null;
    live: boolean;
    proven?: boolean;
    status?: string;
}

/**
 * A student_provision_intents_proven() row as the deletion reads it. Only
 * proof (A) is `proven`, and only 'unproven_match' is `unprovenMatch`: a
 * missing or unknown column reads as neither, so an older or garbled row is
 * never taken as proof, nor as "nothing was created" past a match.
 */
export const provisionIntentFromRow = (row: ProvisionIntentRow): ProvisionIntent => ({
    rosterId: row.roster_id,
    studentUserId: row.student_user_id,
    live: row.live === true,
    proven: row.proven === true,
    unprovenMatch: row.status === 'unproven_match',
});

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
    /**
     * begin_account_deletion_attempt(): writes (or re-counts) the pending
     * marker and starts this attempt under a lease, after any score or roster
     * insert for this account still in flight. Returns the attempt's id, or
     * null when the account is already gone (nothing to guard). Throws on
     * failure; nothing has been touched then.
     */
    beginDeletion: (userId: string) => Promise<string | null>;
    /**
     * mark_account_deletion_destructive(): records, right before the first
     * delete, that destructive cleanup began, so the restriction outlives this
     * attempt. False when the attempt is no longer active (its lease ran out):
     * it must not start deleting. Throws on failure.
     */
    markDestructive: (userId: string, attempt: string) => Promise<boolean>;
    /**
     * settle_account_deletion_attempt(): 'abandoned' when this attempt deleted
     * nothing, 'failed' when it stopped part-way (the code is recorded). The
     * marker is cleared once no attempt is active and no cleanup ever began.
     * Best effort: an unsettled attempt stops restricting when its lease runs out.
     */
    settleDeletion: (
        userId: string,
        attempt: string,
        outcome: 'abandoned' | 'failed',
        code: DeletionFailureCode,
    ) => Promise<void>;
    /**
     * checkout_attempt_in_flight(): whether a checkout from another tab holds a
     * live attempt lease. Asked once the marker is in place, so no new lease can
     * start (20261022110600_account_deletion_barrier.sql); one that started
     * before could still open a Stripe session after the billing sweeps, so the
     * deletion does not go on while it is live. Throws on failure.
     */
    checkoutInFlight: (userId: string) => Promise<boolean>;
    billingCustomers: (userId: string) => Promise<StripeCustomerRef[]>;
    storedSubscriptions: (userId: string) => Promise<StoredSubscriptionRef[]>;
    /** Null when no usable key is configured for that account. */
    stripeFor: (mode: StripeMode) => StripePort | null;
    /** student_user_id of every roster row this teacher owns, archived or not. */
    managedStudents: (teacherId: string) => Promise<string[]>;
    /**
     * student_provision_intents_proven(): provisionings of this teacher that have
     * no roster row (yet), with the Auth account each made, if any, and whether
     * the request that wrote it can still be running.
     */
    provisionIntents: (teacherId: string) => Promise<ProvisionIntent[]>;
    /** finish_student_provision(): the intent is cleaned up. */
    clearProvisionIntent: (rosterId: string) => Promise<void>;
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
    /**
     * Ids of this owner's deleted scores whose folders may still hold bytes:
     * their document_storage_cleanup tombstones, minus any id a live score has
     * since reclaimed (that folder is the live score's again).
     */
    storageCleanups: (ownerId: string) => Promise<string[]>;
    /** Drops the owner's tombstone for a folder that is now empty in both buckets. */
    clearStorageCleanup: (documentId: string, ownerId: string) => Promise<void>;
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
    /** document_storage_cleanup tombstones drained (deleted scores' folders emptied). */
    storageCleanupsCleared: number;
    authUser: 'deleted' | 'not_found';
    /** Step 7, after the auth user is gone. 'failed' is logged loudly by the caller. */
    lateBillingSweep: 'done' | 'failed';
    /** Subscriptions step 7 found and cancelled: started from another tab mid-deletion. */
    lateSubscriptionsCanceled: number;
}

export type DeletionFailureCode =
    | 'managed_student'
    | 'deletion_unavailable'
    | 'checkout_in_progress'
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

/**
 * Step 4 for one owner: every score's files, then its row; then every folder
 * still on record as a deleted score's (tombstone), then that record. Returns
 * scores deleted, objects removed and tombstones cleared.
 */
export const purgeOwnedDocuments = async (
    userId: string,
    ports: DeletionPorts,
): Promise<{ documents: number; objects: number; cleanups: number }> => {
    let documents = 0;
    let objects = 0;
    let cleanups = 0;
    for (const documentId of await ports.ownedDocuments(userId)) {
        objects += await ports.removeStorageFolder('scores', documentId);
        objects += await ports.removeStorageFolder('thumbnails', documentId);
        await ports.deleteDocument(documentId);
        documents += 1;
    }
    // Includes the tombstones the deletes above just wrote: their folders were
    // emptied first, so this re-lists them (catching anything written in
    // between) and drops the record.
    for (const documentId of await ports.storageCleanups(userId)) {
        objects += await ports.removeStorageFolder('scores', documentId);
        objects += await ports.removeStorageFolder('thumbnails', documentId);
        await ports.clearStorageCleanup(documentId, userId);
        cleanups += 1;
    }
    return { documents, objects, cleanups };
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

    // Accounts a provisioning created that never got a roster row
    // (student_provision_intents): a request that crashed between the Auth
    // create and the roster insert, or whose undo failed. The same check
    // before anything irreversible: only a student of THIS teacher goes.
    for (const intent of await ports.provisionIntents(teacherId)) {
        if (!intent.studentUserId && intent.unprovenMatch) {
            // Nothing named, but an account at the address may be what it
            // made: kept, with its intent, for a person (case 5).
            ports.log(
                `provisioning ${intent.rosterId} of ${teacherId} names no account, but an account at its address ` +
                    'has no roster row (unproven_match); leaving its intent for review',
            );
            continue;
        }
        if (!intent.studentUserId) {
            // Nothing was created. A provisioning still running keeps its
            // intent: its roster insert is refused by the marker, and it undoes
            // its own account.
            if (!intent.live) {
                await ports.clearProvisionIntent(intent.rosterId);
            }
            continue;
        }
        const account = await ports.studentAccount(intent.studentUserId);
        if (!account) {
            await ports.clearProvisionIntent(intent.rosterId);
            continue;
        }
        if (!intent.proven) {
            // Named by address only, or recorded but made outside the window:
            // it may be another intent's account or a separate signup at the
            // same address. Never deleted here, whatever its flag says; left,
            // with its intent, for a person (the orphaned-provisioning runbook).
            ports.log(
                `provisioning ${intent.rosterId} of ${teacherId} names ${intent.studentUserId} without proof that it ` +
                    'made it; leaving it, and its intent, for review',
            );
            continue;
        }
        if (account.userType !== 'student' || account.teacherId !== teacherId) {
            // An invite whose student flag never landed, or an account that is
            // not this teacher's: left for a person (the intent stays on record).
            ports.log(
                `provisioning ${intent.rosterId} of ${teacherId} names ${intent.studentUserId}, which is not ` +
                    'flagged as their student; leaving it, and its intent, for review',
            );
            continue;
        }
        const purged = await purgeOwnedDocuments(intent.studentUserId, ports);
        objects += purged.objects;
        await ports.deleteStudiosAndMemberships(intent.studentUserId);
        if ((await closeAuthUser(intent.studentUserId, ports)) === 'deleted') {
            students += 1;
        }
        await ports.clearProvisionIntent(intent.rosterId);
    }
    return { students, objects };
};

/**
 * The most times steps 3 and 4 run. They repeat until a pass finds nothing:
 * with the pending marker refusing new scores and roster rows, the first pass
 * takes everything and the second confirms it. The bound is only a backstop
 * against a fake or a bug that keeps producing rows; reaching it is logged.
 */
export const MAX_SWEEP_PASSES = 4;

/**
 * A share-link guest: steps 4 to 6 only. No billing (stripe-checkout refuses
 * guests, so there is nothing to stop and no Stripe call is made) and no
 * roster (student-provision is a teacher's). Step 4 still runs: a guest cannot
 * create a score, so it finds nothing, but if one ever did own a score its
 * files must go before the auth delete cascades the row that finds them.
 */
const deleteGuest = async (userId: string, ports: DeletionPorts): Promise<DeletionResult> => {
    let purged: Awaited<ReturnType<typeof purgeOwnedDocuments>>;
    try {
        purged = await purgeOwnedDocuments(userId, ports);
    } catch (err) {
        return fail(
            502,
            'document_delete_failed',
            'We could not finish deleting your guest profile. Please try again.',
            err,
        );
    }
    try {
        await ports.deleteStudiosAndMemberships(userId);
    } catch (err) {
        return fail(
            502,
            'membership_delete_failed',
            'We could not remove you from the scores shared with you. Nothing else was changed; please try again.',
            err,
        );
    }
    let authUser: 'deleted' | 'not_found';
    try {
        authUser = await closeAuthUser(userId, ports);
    } catch (err) {
        return fail(
            502,
            'auth_delete_failed',
            'You were removed from every shared score, but we could not delete the guest profile itself. Please try again to finish.',
            err,
        );
    }
    return {
        ok: true,
        summary: {
            subscriptionsCanceled: 0,
            checkoutSessionsExpired: 0,
            studentsDeleted: 0,
            documentsDeleted: purged.documents,
            storageObjectsRemoved: purged.objects,
            storageCleanupsCleared: purged.cleanups,
            authUser,
            lateBillingSweep: 'done',
            lateSubscriptionsCanceled: 0,
        },
    };
};

export const deleteAccount = async (caller: DeletionCaller, ports: DeletionPorts): Promise<DeletionResult> => {
    if (caller.isAnonymous) {
        return deleteGuest(caller.userId, ports);
    }
    if (caller.userType === 'student') {
        return fail(
            403,
            'managed_student',
            'This account is managed by your teacher, so it can’t be deleted here. Your teacher can archive it; to have it deleted, contact support.',
        );
    }

    let attempt: string | null;
    try {
        attempt = await ports.beginDeletion(caller.userId);
    } catch (err) {
        return fail(
            502,
            'deletion_unavailable',
            'We could not start deleting your account, so nothing has been deleted. Please try again.',
            err,
        );
    }

    // From here every failure settles the marker: cleared when nothing was
    // deleted, kept (with its code) when the deletion stopped part-way.
    const settle = async (outcome: 'abandoned' | 'failed', failure: DeletionFailure): Promise<DeletionFailure> => {
        if (attempt === null) {
            return failure;
        }
        try {
            await ports.settleDeletion(caller.userId, attempt, outcome, failure.code);
        } catch (err) {
            ports.log(`could not settle the deletion marker of ${caller.userId} (${outcome}): ${String(err)}`);
        }
        return failure;
    };

    // A checkout another tab started before the marker could still open a
    // Stripe session behind both billing sweeps. The marker now refuses any new
    // one; wait for (refuse while) the one in flight.
    let checkoutBusy: boolean;
    try {
        checkoutBusy = await ports.checkoutInFlight(caller.userId);
    } catch (err) {
        return settle(
            'abandoned',
            fail(
                502,
                'billing_cancel_failed',
                'We could not check your billing, so nothing has been deleted. Please try again, or contact support.',
                err,
            ),
        );
    }
    if (checkoutBusy) {
        return settle(
            'abandoned',
            fail(
                409,
                'checkout_in_progress',
                'A checkout is open in another tab or window. Close it, wait a few minutes, and try again. Nothing has been deleted.',
            ),
        );
    }

    const billing = await cancelBilling(caller.userId, ports);
    if (!billing.ok) {
        return settle('abandoned', billing);
    }

    // The last moment nothing has been deleted. From here the restriction must
    // outlive this attempt (a crash part-way leaves a half-deleted account),
    // so the attempt says so first -- and does not start if it cannot.
    if (attempt !== null) {
        let marked = false;
        let cause: unknown;
        try {
            marked = await ports.markDestructive(caller.userId, attempt);
        } catch (err) {
            cause = err;
        }
        if (!marked) {
            return settle(
                'abandoned',
                fail(
                    502,
                    'deletion_unavailable',
                    'We could not start deleting your data, so nothing has been deleted. Any subscription is cancelled; please try again.',
                    cause ?? new Error('the deletion attempt is no longer active'),
                ),
            );
        }
    }

    let studentsDeleted = 0;
    let documentsDeleted = 0;
    let storageObjectsRemoved = 0;
    let storageCleanupsCleared = 0;
    for (let pass = 1; ; pass += 1) {
        let found = 0;
        try {
            const students = await purgeManagedStudents(caller.userId, ports);
            studentsDeleted += students.students;
            storageObjectsRemoved += students.objects;
            found += students.students;
        } catch (err) {
            return settle(
                'failed',
                fail(
                    502,
                    'student_delete_failed',
                    'We could not remove the student accounts on your roster. Your subscription is cancelled; please try again to finish deleting your account.',
                    err,
                ),
            );
        }

        try {
            const purged = await purgeOwnedDocuments(caller.userId, ports);
            documentsDeleted += purged.documents;
            storageObjectsRemoved += purged.objects;
            storageCleanupsCleared += purged.cleanups;
            found += purged.documents + purged.cleanups;
        } catch (err) {
            return settle(
                'failed',
                fail(
                    502,
                    'document_delete_failed',
                    'We could not delete all of your scores. Your subscription is cancelled; please try again to finish deleting your account.',
                    err,
                ),
            );
        }

        if (found === 0) {
            break;
        }
        if (pass >= MAX_SWEEP_PASSES) {
            ports.log(`${caller.userId}: still finding rows after ${pass} sweeps; closing the account anyway`);
            break;
        }
    }

    try {
        await ports.deleteStudiosAndMemberships(caller.userId);
    } catch (err) {
        return settle(
            'failed',
            fail(
                502,
                'membership_delete_failed',
                'We could not remove you from shared scores. Your scores are deleted; please try again to finish deleting your account.',
                err,
            ),
        );
    }

    let authUser: 'deleted' | 'not_found';
    try {
        authUser = await closeAuthUser(caller.userId, ports);
    } catch (err) {
        return settle(
            'failed',
            fail(
                502,
                'auth_delete_failed',
                'Your data is deleted but we could not close the account itself. Please try again to finish.',
                err,
            ),
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
            storageCleanupsCleared,
            authUser,
            lateBillingSweep,
            lateSubscriptionsCanceled,
        },
        ...(lateBillingFailure === undefined ? {} : { lateBillingFailure }),
    };
};

/** The phrase the client must send, matching what the user typed to confirm. */
export const DELETE_CONFIRMATION = 'DELETE';
