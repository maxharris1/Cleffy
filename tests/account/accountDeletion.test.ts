import { describe, expect, it } from 'vitest';

import {
    cancelBilling,
    deleteAccount,
    MAX_SWEEP_PASSES,
    type DeletionCaller,
    type DeletionPorts,
    type StoredSubscriptionRef,
    type StripeCustomerRef,
    type StripeMode,
    type StripePort,
    type StripeSubscriptionRef,
    type StudentAccountRef,
} from '../../supabase/functions/_shared/accountDeletion';

/**
 * Self-serve account deletion, driven through the exact module the
 * delete-account Edge Function runs, against an in-memory world.
 *
 * What these pin down is the safety argument in accountDeletion.ts: money is
 * stopped before anything is deleted (and a failure to stop it deletes
 * nothing), files go before the rows that find them, only this teacher's own
 * flagged students are taken with them, and every step can be re-run.
 */

const TEACHER = 'teacher-1';

/** One Stripe account (live or test) as the deletion sees it. */
class FakeStripe implements StripePort {
    subscriptions = new Map<string, StripeSubscriptionRef & { customerId: string }>();
    openSessions = new Map<string, string[]>();
    searchable = new Map<string, string[]>();
    failCancel = false;
    failSearch = false;
    calls: string[] = [];

    constructor(private readonly log: string[]) {}

    listSubscriptions = async (customerId: string) => {
        this.log.push(`stripe.list:${customerId}`);
        return [...this.subscriptions.values()]
            .filter((sub) => sub.customerId === customerId)
            .map(({ id, status }) => ({ id, status }));
    };
    retrieveSubscription = async (id: string) => {
        const sub = this.subscriptions.get(id);
        return sub ? { id: sub.id, status: sub.status } : null;
    };
    cancelSubscription = async (id: string): Promise<'canceled' | 'missing'> => {
        if (this.failCancel) {
            throw new Error('stripe is down');
        }
        const sub = this.subscriptions.get(id);
        if (!sub) {
            return 'missing';
        }
        this.log.push(`stripe.cancel:${id}`);
        sub.status = 'canceled';
        return 'canceled';
    };
    expireOpenCheckoutSessions = async (customerId: string) => {
        const open = this.openSessions.get(customerId) ?? [];
        this.openSessions.set(customerId, []);
        if (open.length > 0) {
            this.log.push(`stripe.expire:${customerId}`);
        }
        return open.length;
    };
    findCustomersByUserId = async (userId: string) => {
        if (this.failSearch) {
            throw new Error('search unavailable');
        }
        return this.searchable.get(userId) ?? [];
    };
}

interface FakeUser {
    userType: 'student' | null;
    teacherId: string | null;
}

/** The database, Storage and auth as the deletion's ports reach them. */
class FakeWorld {
    log: string[] = [];
    users = new Map<string, FakeUser>([[TEACHER, { userType: null, teacherId: null }]]);
    documents = new Map<string, string>(); // id -> owner
    /** document_storage_cleanup: id -> former owner, written by every documents delete. */
    tombstones = new Map<string, string>();
    objects = new Set<string>(); // `${bucket}/${documentId}/${name}`
    roster = new Map<string, string>(); // student -> teacher
    memberships = new Set<string>(); // `${documentId}:${userId}`
    studios = new Map<string, string>(); // studio -> owner
    seats = new Set<string>(); // `${studioId}:${userId}`
    customers: Array<StripeCustomerRef & { userId: string }> = [];
    /**
     * account_deletions and account_deletion_attempts, as 20261022110100 and
     * 20261022110400 keep them: `attempts` is the history; `active` holds the
     * attempts that have not ended, by lease expiry (on `now`).
     */
    pending = new Map<
        string,
        { attempts: number; lastError: string | null; destructive: boolean; active: Map<string, number> }
    >();
    /** The database clock, in ms, for attempt leases. */
    now = 0;
    static readonly LEASE_MS = 600_000;
    private attemptIds = 0;
    failBeginDeletion = false;
    failMarkDestructive = false;
    stored: Array<StoredSubscriptionRef & { userId: string }> = [];
    stripe: Record<StripeMode, FakeStripe | null> = { live: new FakeStripe(this.log), test: new FakeStripe(this.log) };

    /**
     * score_analyses.created_by, by document. A row authored by a user being
     * deleted makes the auth delete fail, as guard_score_analyses_client_write
     * refuses GoTrue's JWT-less ON DELETE SET NULL; only releaseAuthorship (the
     * service role) clears it.
     */
    analysisAuthors = new Map<string, string | null>();
    /** Runs once, right after the first releaseAuthorship — "another tab" again. */
    onFirstRelease: (() => void) | null = null;

    failStorageFor: string | null = null;
    failAuthDelete = false;
    failBillingRead = false;
    /** Runs once, the first time a document listing happens — "another tab". */
    onFirstDocumentListing: (() => void) | null = null;

    /** account_deletion_pending(): an active attempt, or destructive cleanup begun. */
    isPending(owner: string): boolean {
        const marker = this.pending.get(owner);
        if (!marker) {
            return false;
        }
        return marker.destructive || [...marker.active.values()].some((leaseUntil) => leaseUntil > this.now);
    }

    /** documents_refuse_during_account_deletion / managed_students_refuse_during_account_deletion. */
    private refuseWhilePending(owner: string) {
        if (this.isPending(owner)) {
            this.log.push(`refused:${owner}`);
            throw new Error('account_deletion_pending');
        }
    }

    addDocument(id: string, owner: string, withThumbnail = true) {
        this.refuseWhilePending(owner);
        this.documents.set(id, owner);
        this.memberships.add(`${id}:${owner}`);
        this.objects.add(`scores/${id}/original.pdf`);
        if (withThumbnail) {
            this.objects.add(`thumbnails/${id}/0.jpg`);
        }
    }

    addStudent(id: string, teacher: string, user: Partial<FakeUser> = {}) {
        this.refuseWhilePending(teacher);
        this.users.set(id, { userType: 'student', teacherId: teacher, ...user });
        this.roster.set(id, teacher);
    }

    /** ON DELETE CASCADE / SET NULL, as the schema declares them. */
    private cascadeUser(userId: string) {
        this.users.delete(userId);
        this.pending.delete(userId);
        for (const [student, teacher] of this.roster) {
            if (student === userId || teacher === userId) {
                this.roster.delete(student);
            }
        }
        for (const [id, owner] of this.documents) {
            if (owner === userId) {
                // A row the deletion missed: cascaded, but its objects remain.
                this.documents.delete(id);
            }
        }
        for (const key of this.memberships) {
            if (key.endsWith(`:${userId}`)) {
                this.memberships.delete(key);
            }
        }
        this.customers = this.customers.filter((c) => c.userId !== userId);
        this.stored = this.stored.filter((s) => s.userId !== userId);
    }

    ports(): DeletionPorts {
        return {
            beginDeletion: async (userId) => {
                if (this.failBeginDeletion) {
                    throw new Error('db down');
                }
                if (!this.users.has(userId)) {
                    return null;
                }
                const marker = this.pending.get(userId) ?? {
                    attempts: 0,
                    lastError: null,
                    destructive: false,
                    active: new Map<string, number>(),
                };
                marker.attempts += 1;
                const attempt = `attempt-${(this.attemptIds += 1)}`;
                marker.active.set(attempt, this.now + FakeWorld.LEASE_MS);
                this.pending.set(userId, marker);
                this.log.push(`pending:${userId}`);
                return attempt;
            },
            markDestructive: async (userId, attempt) => {
                if (this.failMarkDestructive) {
                    throw new Error('db down');
                }
                const marker = this.pending.get(userId);
                const leaseUntil = marker?.active.get(attempt);
                if (!marker || leaseUntil === undefined || leaseUntil <= this.now) {
                    return false;
                }
                marker.destructive = true;
                this.log.push(`destructive:${userId}`);
                return true;
            },
            settleDeletion: async (userId, attempt, outcome, code) => {
                this.log.push(`settle:${outcome}:${code}`);
                const marker = this.pending.get(userId);
                if (!marker) {
                    return;
                }
                marker.active.delete(attempt);
                if (outcome === 'failed') {
                    marker.lastError = code;
                }
                // settle_account_deletion_attempt: gone once no attempt is
                // active and no cleanup ever began.
                if (!marker.destructive && ![...marker.active.values()].some((until) => until > this.now)) {
                    this.pending.delete(userId);
                }
            },
            billingCustomers: async (userId) => {
                if (this.failBillingRead) {
                    throw new Error('db down');
                }
                return this.customers.filter((c) => c.userId === userId);
            },
            storedSubscriptions: async (userId) => this.stored.filter((s) => s.userId === userId),
            stripeFor: (mode) => this.stripe[mode],
            managedStudents: async (teacherId) =>
                [...this.roster].filter(([, teacher]) => teacher === teacherId).map(([student]) => student),
            studentAccount: async (id): Promise<StudentAccountRef | null> => this.users.get(id) ?? null,
            ownedDocuments: async (userId) => {
                const ids = [...this.documents].filter(([, owner]) => owner === userId).map(([id]) => id);
                const hook = this.onFirstDocumentListing;
                this.onFirstDocumentListing = null;
                hook?.();
                return ids;
            },
            removeStorageFolder: async (bucket, documentId) => {
                if (this.failStorageFor === documentId) {
                    throw new Error('storage unavailable');
                }
                let removed = 0;
                for (const key of this.objects) {
                    if (key.startsWith(`${bucket}/${documentId}/`)) {
                        this.objects.delete(key);
                        removed += 1;
                    }
                }
                this.log.push(`storage:${bucket}/${documentId}`);
                return removed;
            },
            deleteDocument: async (documentId) => {
                this.log.push(`row:${documentId}`);
                const owner = this.documents.get(documentId);
                if (owner !== undefined) {
                    // documents_record_storage_cleanup (AFTER DELETE).
                    this.tombstones.set(documentId, owner);
                }
                this.documents.delete(documentId);
                for (const key of this.memberships) {
                    if (key.startsWith(`${documentId}:`)) {
                        this.memberships.delete(key);
                    }
                }
            },
            storageCleanups: async (ownerId) =>
                [...this.tombstones]
                    .filter(([id, owner]) => owner === ownerId && !this.documents.has(id))
                    .map(([id]) => id),
            clearStorageCleanup: async (documentId, ownerId) => {
                if (this.tombstones.get(documentId) === ownerId) {
                    this.log.push(`tombstone:${documentId}`);
                    this.tombstones.delete(documentId);
                }
            },
            deleteStudiosAndMemberships: async (userId) => {
                this.log.push(`memberships:${userId}`);
                for (const [studio, owner] of this.studios) {
                    if (owner === userId) {
                        this.studios.delete(studio);
                        for (const seat of this.seats) {
                            if (seat.startsWith(`${studio}:`)) {
                                this.seats.delete(seat);
                            }
                        }
                    }
                }
                for (const seat of this.seats) {
                    if (seat.endsWith(`:${userId}`)) {
                        this.seats.delete(seat);
                    }
                }
                for (const key of this.memberships) {
                    if (key.endsWith(`:${userId}`)) {
                        this.memberships.delete(key);
                    }
                }
            },
            releaseAuthorship: async (userId) => {
                this.log.push(`release:${userId}`);
                for (const [doc, author] of this.analysisAuthors) {
                    if (author === userId) {
                        this.analysisAuthors.set(doc, null);
                    }
                }
                const hook = this.onFirstRelease;
                this.onFirstRelease = null;
                hook?.();
            },
            deleteAuthUser: async (userId) => {
                if (this.failAuthDelete) {
                    throw new Error('gotrue down');
                }
                if ([...this.analysisAuthors.values()].includes(userId)) {
                    throw new Error('score_analyses: clients may only set pending or failed');
                }
                if (!this.users.has(userId)) {
                    return 'not_found';
                }
                this.log.push(`auth:${userId}`);
                this.cascadeUser(userId);
                return 'deleted';
            },
            log: (message) => this.log.push(`log:${message}`),
        };
    }

    /** True when nothing about any of these users or their scores remains. */
    holdsNothingFor(...userIds: string[]) {
        return (
            userIds.every((id) => !this.users.has(id)) &&
            [...this.documents.values()].every((owner) => !userIds.includes(owner)) &&
            [...this.tombstones.values()].every((owner) => !userIds.includes(owner)) &&
            this.objects.size === 0
        );
    }
}

const teacher = (overrides: Partial<DeletionCaller> = {}): DeletionCaller => ({
    userId: TEACHER,
    isAnonymous: false,
    userType: null,
    ...overrides,
});

/** A teacher paying in live mode, with one score and an open checkout tab. */
const payingTeacher = () => {
    const world = new FakeWorld();
    world.customers.push({ userId: TEACHER, customerId: 'cus_live', mode: 'live' });
    world.stored.push({ userId: TEACHER, subscriptionId: 'sub_live', mode: 'live', status: 'active' });
    world.stripe.live?.subscriptions.set('sub_live', { id: 'sub_live', status: 'active', customerId: 'cus_live' });
    world.stripe.live?.openSessions.set('cus_live', ['cs_open']);
    world.addDocument('doc-1', TEACHER);
    return world;
};

describe('who may delete', () => {
    it('deletes a share-link guest: their memberships and the anonymous auth user, nothing else', async () => {
        const world = new FakeWorld();
        world.addDocument('doc-1', TEACHER);
        world.addDocument('doc-2', TEACHER);
        world.users.set('guest-1', { userType: null, teacherId: null });
        world.memberships.add('doc-1:guest-1');
        world.memberships.add('doc-2:guest-1');
        world.analysisAuthors.set('doc-1', 'guest-1');

        const result = await deleteAccount({ userId: 'guest-1', isAnonymous: true, userType: null }, world.ports());

        expect(result).toMatchObject({
            ok: true,
            summary: { authUser: 'deleted', subscriptionsCanceled: 0, studentsDeleted: 0, documentsDeleted: 0 },
        });
        expect(world.users.has('guest-1')).toBe(false);
        expect([...world.memberships].filter((key) => key.endsWith(':guest-1'))).toEqual([]);
        // The owner's scores, files and access are untouched.
        expect(world.documents.size).toBe(2);
        expect(world.memberships.has('doc-1:teacher-1')).toBe(true);
        expect(world.objects.size).toBe(4);
        // Nothing about billing is asked: a guest cannot have checked out.
        expect(world.log.some((line) => line.startsWith('stripe.'))).toBe(false);
        expect(world.log).toEqual(['memberships:guest-1', 'release:guest-1', 'auth:guest-1']);
    });

    it('never touches Stripe for a guest, even with no Stripe key configured', async () => {
        const world = new FakeWorld();
        world.stripe = { live: null, test: null };
        world.users.set('guest-1', { userType: null, teacherId: null });
        const result = await deleteAccount({ userId: 'guest-1', isAnonymous: true, userType: null }, world.ports());
        expect(result).toMatchObject({ ok: true });
        expect(world.users.has('guest-1')).toBe(false);
    });

    it('answers a guest retry after success as done', async () => {
        const world = new FakeWorld();
        const result = await deleteAccount({ userId: 'guest-1', isAnonymous: true, userType: null }, world.ports());
        expect(result).toMatchObject({ ok: true, summary: { authUser: 'not_found' } });
    });

    it('reports a guest deletion that could not remove the auth user', async () => {
        const world = new FakeWorld();
        world.users.set('guest-1', { userType: null, teacherId: null });
        world.failAuthDelete = true;
        const result = await deleteAccount({ userId: 'guest-1', isAnonymous: true, userType: null }, world.ports());
        expect(result).toMatchObject({ ok: false, status: 502, code: 'auth_delete_failed' });
    });

    it('refuses a provisioned student: their teacher controls the account', async () => {
        const world = new FakeWorld();
        world.addStudent('student-1', TEACHER);
        const result = await deleteAccount(
            { userId: 'student-1', isAnonymous: false, userType: 'student' },
            world.ports(),
        );
        expect(result).toMatchObject({ ok: false, status: 403, code: 'managed_student' });
        expect(world.users.has('student-1')).toBe(true);
        expect(world.log).toEqual([]);
    });
});

describe('billing comes first', () => {
    it('cancels the subscription and expires open checkouts before deleting any data', async () => {
        const world = payingTeacher();
        const result = await deleteAccount(teacher(), world.ports());

        expect(result).toMatchObject({
            ok: true,
            summary: { subscriptionsCanceled: 1, checkoutSessionsExpired: 1, documentsDeleted: 1, authUser: 'deleted' },
        });
        expect(world.stripe.live?.subscriptions.get('sub_live')?.status).toBe('canceled');
        const firstDeletion = world.log.findIndex((entry) => entry.startsWith('storage:'));
        expect(world.log.indexOf('stripe.cancel:sub_live')).toBeLessThan(firstDeletion);
        // Expired before the subscriptions were listed, so a checkout completing
        // in between cannot leave a subscription behind.
        expect(world.log.indexOf('stripe.expire:cus_live')).toBeLessThan(world.log.indexOf('stripe.list:cus_live'));
        expect(world.holdsNothingFor(TEACHER)).toBe(true);
    });

    it('deletes nothing when the subscription cannot be cancelled', async () => {
        const world = payingTeacher();
        if (world.stripe.live) {
            world.stripe.live.failCancel = true;
        }
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, status: 502, code: 'billing_cancel_failed' });
        expect(world.documents.has('doc-1')).toBe(true);
        expect(world.objects.size).toBe(2);
        expect(world.users.has(TEACHER)).toBe(true);
    });

    it('deletes nothing when the billing tables cannot be read', async () => {
        const world = payingTeacher();
        world.failBillingRead = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, code: 'billing_cancel_failed' });
        expect(world.documents.has('doc-1')).toBe(true);
    });

    it('refuses rather than strand a live subscription when the live key is missing', async () => {
        const world = payingTeacher();
        world.stripe.live = null;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, status: 503, code: 'billing_unavailable' });
        expect(world.documents.has('doc-1')).toBe(true);
        expect(world.users.has(TEACHER)).toBe(true);
    });

    it('does not let a missing sandbox key keep someone’s data', async () => {
        const world = new FakeWorld();
        world.customers.push({ userId: TEACHER, customerId: 'cus_test', mode: 'test' });
        world.stripe.test = null;
        world.addDocument('doc-1', TEACHER);
        const result = await deleteAccount(teacher(), world.ports());
        expect(result.ok).toBe(true);
        expect(world.log.some((entry) => entry.includes('no test-mode key'))).toBe(true);
    });

    it('leaves terminal subscriptions alone and cancels everything that can still bill', async () => {
        const world = new FakeWorld();
        const live = world.stripe.live as FakeStripe;
        world.customers.push({ userId: TEACHER, customerId: 'cus_live', mode: 'live' });
        for (const [id, status] of [
            ['sub_old', 'canceled'],
            ['sub_expired', 'incomplete_expired'],
            ['sub_due', 'past_due'],
            ['sub_trial', 'trialing'],
            ['sub_unpaid', 'unpaid'],
        ] as const) {
            live.subscriptions.set(id, { id, status, customerId: 'cus_live' });
        }
        const result = await cancelBilling(TEACHER, world.ports());
        expect(result).toMatchObject({ ok: true, canceled: 3 });
        expect(world.log.filter((entry) => entry.startsWith('stripe.cancel:')).sort()).toEqual([
            'stripe.cancel:sub_due',
            'stripe.cancel:sub_trial',
            'stripe.cancel:sub_unpaid',
        ]);
    });

    it('cancels a recorded subscription whose customer row is missing, after asking Stripe', async () => {
        const world = new FakeWorld();
        const live = world.stripe.live as FakeStripe;
        world.stored.push({ userId: TEACHER, subscriptionId: 'sub_orphan', mode: 'live', status: 'active' });
        world.stored.push({ userId: TEACHER, subscriptionId: 'sub_gone', mode: 'live', status: 'active' });
        live.subscriptions.set('sub_orphan', { id: 'sub_orphan', status: 'active', customerId: 'cus_x' });
        // sub_gone: our row says active, Stripe has never heard of it.
        const result = await cancelBilling(TEACHER, world.ports());
        expect(result).toMatchObject({ ok: true, canceled: 1 });
        expect(live.subscriptions.get('sub_orphan')?.status).toBe('canceled');
    });

    it('finds a customer the checkout created but never recorded', async () => {
        const world = new FakeWorld();
        const live = world.stripe.live as FakeStripe;
        live.searchable.set(TEACHER, ['cus_unrecorded']);
        live.subscriptions.set('sub_x', { id: 'sub_x', status: 'active', customerId: 'cus_unrecorded' });
        const result = await cancelBilling(TEACHER, world.ports());
        expect(result).toMatchObject({ ok: true, canceled: 1 });
    });

    it('tolerates an unavailable customer search when the tables already describe everything', async () => {
        const world = payingTeacher();
        (world.stripe.live as FakeStripe).failSearch = true;
        (world.stripe.test as FakeStripe).failSearch = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { subscriptionsCanceled: 1 } });
    });
});

describe('what goes with the account', () => {
    it('removes both buckets’ objects before the row that finds them', async () => {
        const world = new FakeWorld();
        world.addDocument('doc-1', TEACHER);
        await deleteAccount(teacher(), world.ports());
        const order = world.log.filter((entry) => entry.includes('doc-1'));
        expect(order.slice(0, 3)).toEqual(['storage:scores/doc-1', 'storage:thumbnails/doc-1', 'row:doc-1']);
    });

    it('keeps a score’s row when its files could not be removed, so a retry can still find them', async () => {
        const world = new FakeWorld();
        world.addDocument('doc-1', TEACHER);
        world.addDocument('doc-2', TEACHER);
        world.failStorageFor = 'doc-2';
        const first = await deleteAccount(teacher(), world.ports());
        expect(first).toMatchObject({ ok: false, code: 'document_delete_failed' });
        expect(world.documents.has('doc-2')).toBe(true);
        expect(world.users.has(TEACHER)).toBe(true);

        world.failStorageFor = null;
        const retry = await deleteAccount(teacher(), world.ports());
        expect(retry.ok).toBe(true);
        expect(world.holdsNothingFor(TEACHER)).toBe(true);
    });

    it('does not touch scores owned by someone else, only the membership in them', async () => {
        const world = new FakeWorld();
        world.users.set('colleague', { userType: null, teacherId: null });
        world.addDocument('theirs', 'colleague');
        world.memberships.add(`theirs:${TEACHER}`);
        await deleteAccount(teacher(), world.ports());
        expect(world.documents.get('theirs')).toBe('colleague');
        expect(world.objects.has('scores/theirs/original.pdf')).toBe(true);
        expect(world.memberships.has(`theirs:${TEACHER}`)).toBe(false);
        expect(world.memberships.has('theirs:colleague')).toBe(true);
    });

    it('dissolves a studio the teacher owns and frees its seats', async () => {
        const world = new FakeWorld();
        world.studios.set('studio-1', TEACHER);
        world.seats.add(`studio-1:${TEACHER}`);
        world.seats.add('studio-1:colleague');
        world.studios.set('studio-2', 'someone-else');
        world.seats.add(`studio-2:${TEACHER}`);
        await deleteAccount(teacher(), world.ports());
        expect([...world.studios.keys()]).toEqual(['studio-2']);
        expect(world.seats.size).toBe(0);
        expect(world.log.indexOf(`memberships:${TEACHER}`)).toBeLessThan(world.log.indexOf(`auth:${TEACHER}`));
    });

    it('deletes the teacher’s provisioned students, and only accounts that really are theirs', async () => {
        const world = new FakeWorld();
        world.addStudent('student-1', TEACHER);
        world.addStudent('student-2', TEACHER);
        // A roster row pointing at an ordinary account, or at another teacher's
        // student, must never cost that account its existence.
        world.addStudent('not-a-student', TEACHER, { userType: null, teacherId: null });
        world.addStudent('someone-elses', TEACHER, { teacherId: 'teacher-2' });

        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { studentsDeleted: 2 } });
        expect(world.users.has('student-1')).toBe(false);
        expect(world.users.has('student-2')).toBe(false);
        expect(world.users.has('not-a-student')).toBe(true);
        expect(world.users.has('someone-elses')).toBe(true);
        // Students go before their teacher, whose cascade would otherwise take
        // the roster rows and leave the student accounts unreachable.
        expect(world.log.indexOf('auth:student-1')).toBeLessThan(world.log.indexOf(`auth:${TEACHER}`));
    });

    it('refuses a score uploaded from another tab while the deletion runs, so nothing is left behind', async () => {
        const world = new FakeWorld();
        world.addDocument('doc-1', TEACHER);
        let refused: unknown = null;
        world.onFirstDocumentListing = () => {
            try {
                world.addDocument('late-upload', TEACHER);
            } catch (err) {
                refused = err;
            }
        };
        const result = await deleteAccount(teacher(), world.ports());
        expect(String(refused)).toContain('account_deletion_pending');
        expect(result).toMatchObject({ ok: true, summary: { documentsDeleted: 1 } });
        expect(world.holdsNothingFor(TEACHER)).toBe(true);
    });
});

describe('deleted scores’ leftover folders (document_storage_cleanup)', () => {
    it('drops the tombstones its own score deletes write, after their folders are empty', async () => {
        const world = payingTeacher();
        const result = await deleteAccount(teacher(), world.ports());

        expect(result).toMatchObject({ ok: true, summary: { documentsDeleted: 1, storageCleanupsCleared: 1 } });
        expect(world.tombstones.size).toBe(0);
        expect(world.log.indexOf('row:doc-1')).toBeLessThan(world.log.indexOf('tombstone:doc-1'));
        expect(world.log.indexOf('tombstone:doc-1')).toBeLessThan(world.log.indexOf(`auth:${TEACHER}`));
        expect(world.holdsNothingFor(TEACHER)).toBe(true);
    });

    it('empties the folders of a score deleted earlier whose library cleanup never finished', async () => {
        const world = payingTeacher();
        // Deleted from the library row-first; its detached Storage purge died.
        world.tombstones.set('old-doc', TEACHER);
        world.objects.add('scores/old-doc/original.pdf');
        world.objects.add('scores/old-doc/pre-import-original.pdf');
        world.objects.add('thumbnails/old-doc/2.jpg');

        const result = await deleteAccount(teacher(), world.ports());

        expect(result).toMatchObject({ ok: true, summary: { storageCleanupsCleared: 2 } });
        expect(world.objects.size).toBe(0);
        expect(world.tombstones.size).toBe(0);
        // Files first, record after: a failure in between leaves the record to retry from.
        expect(world.log.indexOf('storage:thumbnails/old-doc')).toBeLessThan(world.log.indexOf('tombstone:old-doc'));
    });

    it('keeps the account, and the record, when a leftover folder cannot be emptied', async () => {
        const world = payingTeacher();
        world.tombstones.set('old-doc', TEACHER);
        world.objects.add('scores/old-doc/original.pdf');
        world.failStorageFor = 'old-doc';

        const result = await deleteAccount(teacher(), world.ports());

        expect(result).toMatchObject({ ok: false, code: 'document_delete_failed' });
        expect(world.users.has(TEACHER)).toBe(true);
        expect(world.tombstones.get('old-doc')).toBe(TEACHER);

        world.failStorageFor = null;
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: true });
        expect(world.holdsNothingFor(TEACHER)).toBe(true);
    });

    it('leaves a folder alone once a live score has reclaimed its id, and other owners’ records', async () => {
        const world = payingTeacher();
        world.tombstones.set('reused', TEACHER);
        world.addDocument('reused', 'someone-else');
        world.tombstones.set('theirs', 'someone-else');
        world.objects.add('scores/theirs/original.pdf');

        await deleteAccount(teacher(), world.ports());

        expect(world.objects.has('scores/reused/original.pdf')).toBe(true);
        expect(world.objects.has('scores/theirs/original.pdf')).toBe(true);
        expect(world.tombstones.get('theirs')).toBe('someone-else');
    });

    it('drains a provisioned student’s records too', async () => {
        const world = payingTeacher();
        world.addStudent('student-1', TEACHER);
        world.tombstones.set('student-old', 'student-1');
        world.objects.add('scores/student-old/original.pdf');

        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: true });
        expect(world.holdsNothingFor(TEACHER, 'student-1')).toBe(true);
    });
});

describe('retries', () => {
    it('finishes on a retry after the auth delete failed, with nothing done twice', async () => {
        const world = payingTeacher();
        world.failAuthDelete = true;
        const first = await deleteAccount(teacher(), world.ports());
        expect(first).toMatchObject({ ok: false, code: 'auth_delete_failed' });
        expect(world.documents.size).toBe(0);

        world.failAuthDelete = false;
        world.log.length = 0;
        const retry = await deleteAccount(teacher(), world.ports());
        expect(retry).toMatchObject({
            ok: true,
            summary: { subscriptionsCanceled: 0, documentsDeleted: 0, authUser: 'deleted' },
        });
        expect(world.log.some((entry) => entry.startsWith('stripe.cancel:'))).toBe(false);
    });

    it('treats an account that is already gone as deleted', async () => {
        const world = payingTeacher();
        await deleteAccount(teacher(), world.ports());
        const again = await deleteAccount(teacher(), world.ports());
        expect(again).toMatchObject({ ok: true, summary: { authUser: 'not_found' } });
    });
});

describe('authorship that would block the auth delete', () => {
    it('releases a play-along analysis the user requested on someone else’s score before deleting them', async () => {
        const world = new FakeWorld();
        world.users.set('colleague', { userType: null, teacherId: null });
        world.addDocument('theirs', 'colleague');
        world.analysisAuthors.set('theirs', TEACHER);

        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { authUser: 'deleted' } });
        // The analysis belongs to the colleague's score: it stays, unattributed.
        expect(world.analysisAuthors.get('theirs')).toBeNull();
        expect(world.documents.get('theirs')).toBe('colleague');
        expect(world.log.indexOf(`release:${TEACHER}`)).toBeLessThan(world.log.indexOf(`auth:${TEACHER}`));
    });

    it('releases a student’s authorship before deleting the student too', async () => {
        const world = new FakeWorld();
        world.users.set('colleague', { userType: null, teacherId: null });
        world.addDocument('theirs', 'colleague');
        world.addStudent('student-1', TEACHER);
        world.analysisAuthors.set('theirs', 'student-1');
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { studentsDeleted: 1 } });
        expect(world.users.has('student-1')).toBe(false);
    });

    it('retries once when a row authored by the user lands between the release and the delete', async () => {
        const world = new FakeWorld();
        world.users.set('colleague', { userType: null, teacherId: null });
        world.addDocument('theirs', 'colleague');
        world.onFirstRelease = () => world.analysisAuthors.set('theirs', TEACHER);
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { authUser: 'deleted' } });
        expect(world.log.filter((entry) => entry === `release:${TEACHER}`)).toHaveLength(2);
    });

    it('reports auth_delete_failed, with the data already gone, when the delete keeps failing', async () => {
        const world = payingTeacher();
        world.failAuthDelete = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, status: 502, code: 'auth_delete_failed' });
        expect(world.users.has(TEACHER)).toBe(true);
        expect(world.log.filter((entry) => entry === `release:${TEACHER}`)).toHaveLength(2);
    });
});

describe('billing after the account is gone', () => {
    it('cancels a subscription a checkout in another tab started mid-deletion', async () => {
        const world = payingTeacher();
        const live = world.stripe.live as FakeStripe;
        // After step 2 has run: the customer completes a Checkout that was
        // opened (on the existing customer) while the deletion was under way.
        world.onFirstDocumentListing = () =>
            live.subscriptions.set('sub_late', { id: 'sub_late', status: 'active', customerId: 'cus_live' });

        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({
            ok: true,
            summary: { lateBillingSweep: 'done', lateSubscriptionsCanceled: 1, subscriptionsCanceled: 2 },
        });
        expect(live.subscriptions.get('sub_late')?.status).toBe('canceled');
        // Swept after the auth user was deleted, when no new Checkout can be opened.
        expect(world.log.indexOf('stripe.cancel:sub_late')).toBeGreaterThan(world.log.indexOf(`auth:${TEACHER}`));
    });

    it('expires a checkout opened mid-deletion, from the customers step 2 knew', async () => {
        const world = payingTeacher();
        const live = world.stripe.live as FakeStripe;
        world.onFirstDocumentListing = () => live.openSessions.set('cus_live', ['cs_late']);
        const result = await deleteAccount(teacher(), world.ports());
        // billing_customers cascaded with the user; the customer was carried over.
        expect(world.customers).toEqual([]);
        expect(result).toMatchObject({ ok: true, summary: { checkoutSessionsExpired: 2 } });
        expect(live.openSessions.get('cus_live')).toEqual([]);
    });

    it('still reports success when the late sweep fails, with the failure handed back to be logged', async () => {
        const world = payingTeacher();
        const live = world.stripe.live as FakeStripe;
        world.onFirstDocumentListing = () => {
            live.subscriptions.set('sub_late', { id: 'sub_late', status: 'active', customerId: 'cus_live' });
            live.failCancel = true;
        };
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: true, summary: { lateBillingSweep: 'failed', authUser: 'deleted' } });
        expect(result.ok && result.lateBillingFailure).toBeTruthy();
        expect(world.users.has(TEACHER)).toBe(false);
    });

    it('leaves a clean deletion’s late sweep with nothing to do', async () => {
        const world = payingTeacher();
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({
            ok: true,
            summary: { lateBillingSweep: 'done', lateSubscriptionsCanceled: 0, subscriptionsCanceled: 1 },
        });
        expect(result.ok && 'lateBillingFailure' in result).toBe(false);
    });
});

describe('the pending marker (account_deletions)', () => {
    it('is written before billing is touched or anything is deleted', async () => {
        const world = payingTeacher();
        await deleteAccount(teacher(), world.ports());
        const pending = world.log.indexOf(`pending:${TEACHER}`);
        expect(pending).toBe(0);
        expect(pending).toBeLessThan(world.log.findIndex((entry) => entry.startsWith('stripe.')));
        expect(pending).toBeLessThan(world.log.indexOf('row:doc-1'));
    });

    it('refuses a student provisioned mid-delete, and the sweep still closes every account', async () => {
        const world = new FakeWorld();
        world.addStudent('student-1', TEACHER);
        let refused: unknown = null;
        world.onFirstDocumentListing = () => {
            try {
                world.addStudent('student-late', TEACHER);
            } catch (err) {
                refused = err;
            }
        };
        const result = await deleteAccount(teacher(), world.ports());
        expect(String(refused)).toContain('account_deletion_pending');
        expect(result).toMatchObject({ ok: true, summary: { studentsDeleted: 1 } });
        expect(world.users.has('student-late')).toBe(false);
        expect(world.roster.size).toBe(0);
    });

    it('sweeps until a pass finds nothing: the second pass confirms, there is no third', async () => {
        const world = payingTeacher();
        const listings: number[] = [];
        const ports = world.ports();
        const ownedDocuments = ports.ownedDocuments;
        ports.ownedDocuments = async (userId) => {
            const ids = await ownedDocuments(userId);
            if (userId === TEACHER) {
                listings.push(ids.length);
            }
            return ids;
        };
        expect(await deleteAccount(teacher(), ports)).toMatchObject({ ok: true });
        expect(listings).toEqual([1, 0]);
        expect(MAX_SWEEP_PASSES).toBeGreaterThanOrEqual(2);
    });

    it('stops at the bound if rows keep appearing (a bug), and still closes the account', async () => {
        const world = new FakeWorld();
        let n = 0;
        const ports = world.ports();
        ports.ownedDocuments = async () => [`ghost-${(n += 1)}`];
        const result = await deleteAccount(teacher(), ports);
        expect(result).toMatchObject({ ok: true, summary: { documentsDeleted: MAX_SWEEP_PASSES } });
        expect(world.log.some((entry) => entry.includes(`after ${MAX_SWEEP_PASSES} sweeps`))).toBe(true);
    });

    it('is cleared when billing cannot be stopped: nothing was deleted, and the account works as before', async () => {
        const world = payingTeacher();
        world.failBillingRead = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, code: 'billing_cancel_failed' });
        expect(world.pending.has(TEACHER)).toBe(false);
        expect(world.log).toContain('settle:abandoned:billing_cancel_failed');
        expect(() => world.addDocument('new-score', TEACHER)).not.toThrow();
    });

    it('is kept, with the error, when the deletion stops part-way; the retry finishes and it goes with the account', async () => {
        const world = payingTeacher();
        world.failAuthDelete = true;
        const first = await deleteAccount(teacher(), world.ports());
        expect(first).toMatchObject({ ok: false, code: 'auth_delete_failed' });
        expect(world.pending.get(TEACHER)).toMatchObject({
            attempts: 1,
            lastError: 'auth_delete_failed',
            destructive: true,
        });
        expect(world.pending.get(TEACHER)?.active.size).toBe(0);
        expect(() => world.addDocument('while-half-deleted', TEACHER)).toThrow('account_deletion_pending');

        world.failAuthDelete = false;
        const retry = await deleteAccount(teacher(), world.ports());
        expect(retry).toMatchObject({ ok: true, summary: { authUser: 'deleted' } });
        expect(world.pending.has(TEACHER)).toBe(false);
    });

    it('a marker that cannot be written stops the deletion before anything else', async () => {
        const world = payingTeacher();
        world.failBeginDeletion = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, status: 502, code: 'deletion_unavailable' });
        expect(world.log.some((entry) => entry.startsWith('stripe.'))).toBe(false);
        expect(world.documents.has('doc-1')).toBe(true);
    });

    it('a retry that deletes nothing does not clear the marker an earlier part-way attempt left', async () => {
        const world = payingTeacher();
        world.failAuthDelete = true;
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: false, code: 'auth_delete_failed' });
        world.failAuthDelete = false;
        world.failBillingRead = true;
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({
            ok: false,
            code: 'billing_cancel_failed',
        });
        expect(world.pending.get(TEACHER)).toMatchObject({ attempts: 2, lastError: 'auth_delete_failed' });
        expect(() => world.addDocument('after-abandoned-retry', TEACHER)).toThrow('account_deletion_pending');
    });

    it('records that cleanup began after billing is stopped and before the first thing is deleted', async () => {
        const world = payingTeacher();
        world.addStudent('student-1', TEACHER);
        await deleteAccount(teacher(), world.ports());
        const destructive = world.log.indexOf(`destructive:${TEACHER}`);
        expect(destructive).toBeGreaterThan(world.log.findIndex((entry) => entry.startsWith('stripe.')));
        expect(destructive).toBeLessThan(world.log.indexOf('row:doc-1'));
        expect(destructive).toBeLessThan(world.log.indexOf('storage:scores/doc-1'));
        expect(destructive).toBeLessThan(world.log.indexOf('auth:student-1'));
    });

    it('does not start deleting when it cannot record that cleanup began: abandoned, nothing deleted', async () => {
        const world = payingTeacher();
        world.failMarkDestructive = true;
        const result = await deleteAccount(teacher(), world.ports());
        expect(result).toMatchObject({ ok: false, status: 502, code: 'deletion_unavailable' });
        expect(world.documents.has('doc-1')).toBe(true);
        expect(world.pending.has(TEACHER)).toBe(false);
        expect(() => world.addDocument('still-mine', TEACHER)).not.toThrow();
    });

    it('two attempts that both abandon clear the marker: the account works as before (Codex r1 finding 1)', async () => {
        const world = payingTeacher();
        world.failBillingRead = true;
        // Two tabs, both started before either gave up.
        const ports = world.ports();
        const first = deleteAccount(teacher(), ports);
        const second = deleteAccount(teacher(), ports);
        expect(await first).toMatchObject({ ok: false, code: 'billing_cancel_failed' });
        expect(await second).toMatchObject({ ok: false, code: 'billing_cancel_failed' });
        expect(world.pending.has(TEACHER)).toBe(false);
        expect(world.isPending(TEACHER)).toBe(false);
        expect(() => world.addDocument('after-two-abandoned', TEACHER)).not.toThrow();

        // A third abandoned attempt later on is no different: history is not a gate.
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: false });
        expect(world.isPending(TEACHER)).toBe(false);
    });

    it('one tab abandoning while another is still working keeps the restriction until that one ends', async () => {
        const world = payingTeacher();
        const ports = world.ports();
        const working = await ports.beginDeletion(TEACHER);
        world.failBillingRead = true;
        expect(await deleteAccount(teacher(), ports)).toMatchObject({ ok: false, code: 'billing_cancel_failed' });
        expect(world.isPending(TEACHER)).toBe(true);
        expect(() => world.addDocument('mid-other-tab', TEACHER)).toThrow('account_deletion_pending');
        await ports.settleDeletion(TEACHER, working as string, 'abandoned', 'billing_cancel_failed');
        expect(world.isPending(TEACHER)).toBe(false);
    });

    it('a crashed attempt that deleted nothing stops restricting once its lease runs out', async () => {
        const world = payingTeacher();
        const ports = world.ports();
        // The request dies right after begin: it never settles.
        await ports.beginDeletion(TEACHER);
        expect(() => world.addDocument('during-crash', TEACHER)).toThrow('account_deletion_pending');
        world.now += FakeWorld.LEASE_MS + 1;
        expect(world.isPending(TEACHER)).toBe(false);
        expect(() => world.addDocument('after-lease', TEACHER)).not.toThrow();

        // And a later deletion still works from the leftover row.
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: true });
        expect(world.pending.has(TEACHER)).toBe(false);
    });

    it('an attempt that crashes after cleanup began keeps the restriction, and a retry finishes it', async () => {
        const world = payingTeacher();
        world.addDocument('doc-2', TEACHER);
        const ports = world.ports();
        // The request dies inside the sweep, after deleting one score.
        ports.deleteDocument = async (documentId) => {
            world.documents.delete(documentId);
            throw new Error('isolate killed');
        };
        expect(await deleteAccount(teacher(), ports)).toMatchObject({ ok: false, code: 'document_delete_failed' });
        // Model the crash fully: the attempt's lease runs out unsettled.
        world.now += FakeWorld.LEASE_MS + 1;
        expect(world.pending.get(TEACHER)).toMatchObject({ destructive: true });
        expect(world.isPending(TEACHER)).toBe(true);
        expect(() => world.addDocument('into-half-deleted', TEACHER)).toThrow('account_deletion_pending');

        // A retry that deletes nothing cannot lift it either.
        world.failBillingRead = true;
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: false });
        expect(world.isPending(TEACHER)).toBe(true);

        // A retry that completes takes the marker away with the account.
        world.failBillingRead = false;
        expect(await deleteAccount(teacher(), world.ports())).toMatchObject({ ok: true });
        expect(world.pending.has(TEACHER)).toBe(false);
        expect(world.users.has(TEACHER)).toBe(false);
    });
});
