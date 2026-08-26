import {
    isUnlimited,
    LIMIT_REACHED_STATUS,
    limitReachedBody,
    monthKeyOf,
    resolveEntitlements,
    type Entitlements,
    type LimitReachedBody,
    type QuotaBackend,
    type SubscriptionLike,
    type UsageMetric,
} from '../../supabase/functions/_shared/entitlements';
import type { AssignmentAccess, MemberRole } from '../../src/types/database';

/**
 * In-memory stand-in for the billing and roster tables, implementing the
 * contract that supabase/migrations/20260826193902_billing.sql and
 * 20260826194426_roster.sql define.
 *
 * Same idea as `FakeApi` in src/sync/syncEngine.test.ts: the production code
 * under test is real, only the storage behind it is faked. What it reproduces
 * deliberately:
 *  - consume_quota()'s atomicity, as an increment that only happens when the
 *    check passes, so "rejected" and "not incremented" cannot come apart;
 *  - the calendar-month key, so rollover is exercised;
 *  - the cloud-score cap as a stock (count of live rows), not a counter;
 *  - the roster as a second stock of the same kind, including the restore path,
 *    which has to re-run the check or archive/restore launders the cap.
 *
 * What it deliberately does NOT reproduce is the product logic that only exists
 * in SQL — assign_score()'s membership upsert, unassign_score()'s owner guard,
 * and the practice_notes policies. Those are not re-implemented here; they are
 * asserted as data-driven expectations in roster.test.ts, with the role mapping
 * below as the one shared piece, so a test can never pass against a second
 * implementation of a rule Postgres owns.
 *
 * Postgres remains the real authority — this is how the rules get exercised in
 * CI without one.
 */

export interface FakeBillingOptions {
    now?: Date;
}

/** One managed_students row, reduced to what the stock rules turn on. */
export interface FakeRosterRow {
    id: string;
    studentUserId: string;
    /** `archived_at is not null`: keeps its history, stops holding a seat. */
    archived: boolean;
}

/**
 * What student-provision answers with when it refuses — the 402 carrying the
 * shared `limitReachedBody`, or the flat 404 that covers "no such row" and "not
 * yours" alike. Same body union as `EnforceOutcome`, for the same reason: a
 * refusal is a typed pricing state, not an error string.
 */
export interface FakeProvisionError {
    status: number;
    body: LimitReachedBody | { error: string };
}

/**
 * The role assign_score() writes, mirroring its two CASE expressions: 'edit'
 * grants editor, 'view' grants viewer, and an existing owner row survives
 * untouched — the same guard redeem_share_link carries, because assigning a
 * score must never cost anyone ownership of it. Below owner, the teacher's
 * toggle wins outright, editor -> viewer included: flipping an assignment to
 * view-only has to demote or the toggle is a lie.
 */
export const assignRole = (current: MemberRole | null, access: AssignmentAccess): MemberRole => {
    if (current === 'owner') {
        return 'owner';
    }
    return access === 'view' ? 'viewer' : 'editor';
};

/**
 * What unassign_score() leaves behind. It withdraws the access the assignment
 * granted, `and role <> 'owner'` — an owner row was never the assignment's to
 * give and is not its to take away. Null means no membership survives.
 *
 * `hadAssignment` is the guard: the membership delete only runs when the
 * assignment delete actually removed a row. document_members has no client write
 * policy, so an unguarded delete would quietly make this the app's general
 * revocation primitive, taking any user id — a share-link collaborator's editor
 * row would disappear on an unassign that withdrew nothing.
 */
export const unassignRole = (current: MemberRole | null, hadAssignment: boolean): MemberRole | null => {
    if (!hadAssignment) {
        return current;
    }
    return current === 'owner' ? 'owner' : null;
};

export class FakeBilling implements QuotaBackend {
    subscriptions: SubscriptionLike[] = [];
    /**
     * user id -> owner ids of the studios they hold a seat in. The tables keep
     * their v1 names; only the tier that pays for them is now 'academy'.
     */
    studioSeats = new Map<string, string[]>();
    counters = new Map<string, number>();
    /** owner id -> ids of their non-archived documents. */
    activeScores = new Map<string, string[]>();
    /** teacher id -> their managed_students rows, ARCHIVED ONES INCLUDED: archiving deletes nothing. */
    roster = new Map<string, FakeRosterRow[]>();

    now: Date;

    private nextRosterId = 1;

    constructor(options: FakeBillingOptions = {}) {
        this.now = options.now ?? new Date('2026-08-11T12:00:00Z');
    }

    private counterKey(userId: string, metric: UsageMetric): string {
        return `${userId}|${metric}|${monthKeyOf(this.now)}`;
    }

    countOf(userId: string, metric: UsageMetric): number {
        return this.counters.get(this.counterKey(userId, metric)) ?? 0;
    }

    /** Mirrors get_entitlements(): own live subscription, then a live Academy seat, then free. */
    getEntitlements = async (userId: string): Promise<Entitlements | null> =>
        resolveEntitlements(
            {
                userId,
                subscriptions: this.subscriptions,
                studioOwnerIds: this.studioSeats.get(userId) ?? [],
                ownerSubscriptions: this.subscriptions,
            },
            this.now.getTime(),
        );

    /**
     * Mirrors consume_quota(). The check and the increment are one step here for
     * the same reason they are one statement in SQL: a caller must never be told
     * "no" after the counter already moved.
     */
    consumeQuota = async (
        userId: string,
        metric: UsageMetric,
        limit: number,
    ): Promise<{ ok: boolean; count: number } | null> => {
        if (limit === 0) {
            return { ok: false, count: 0 };
        }
        const key = this.counterKey(userId, metric);
        const current = this.counters.get(key) ?? 0;
        if (limit > 0 && current >= limit) {
            return { ok: false, count: current };
        }
        const next = current + 1;
        this.counters.set(key, next);
        return { ok: true, count: next };
    };

    /** Mirrors release_quota(): never below zero. */
    releaseQuota(userId: string, metric: UsageMetric): void {
        const key = this.counterKey(userId, metric);
        this.counters.set(key, Math.max(0, (this.counters.get(key) ?? 0) - 1));
    }

    subscribe(
        userId: string,
        tier: 'personal' | 'teacher' | 'academy',
        overrides: Partial<SubscriptionLike> = {},
    ): void {
        this.subscriptions.push({
            user_id: userId,
            tier,
            status: 'active',
            current_period_end: '2027-08-11T12:00:00Z',
            ...overrides,
        });
    }

    /** Gives `memberId` a seat in `ownerId`'s studio — entitling only if the owner pays for Academy. */
    seatIn(memberId: string, ownerId: string): void {
        this.studioSeats.set(memberId, [...(this.studioSeats.get(memberId) ?? []), ownerId]);
    }

    /**
     * Mirrors the documents_enforce_score_cap trigger: raises with the same
     * P0001 + JSON DETAIL shape PostgREST would surface to the client.
     */
    async insertScore(ownerId: string, scoreId: string): Promise<void> {
        const entitlements = await this.getEntitlements(ownerId);
        const limit = entitlements?.limits.cloud_scores ?? 0;
        const active = this.activeScores.get(ownerId) ?? [];
        if (limit >= 0 && active.length >= limit) {
            throw {
                code: 'P0001',
                message: 'limit_reached',
                details: JSON.stringify({
                    code: 'limit_reached',
                    metric: 'cloud_scores',
                    limit,
                    tier: entitlements?.tier ?? 'free',
                }),
            };
        }
        this.activeScores.set(ownerId, [...active, scoreId]);
    }

    /** Archiving frees a slot without deleting anything — the lapse behaviour. */
    archiveScore(ownerId: string, scoreId: string): void {
        this.activeScores.set(
            ownerId,
            (this.activeScores.get(ownerId) ?? []).filter((id) => id !== scoreId),
        );
    }

    /**
     * The roster stock: unarchived rows only, matching both the partial index
     * and the `.is('archived_at', null)` the Edge Function counts with.
     */
    activeStudents(teacherId: string): FakeRosterRow[] {
        return (this.roster.get(teacherId) ?? []).filter((row) => !row.archived);
    }

    /**
     * Mirrors checkRosterStock(): resolve the tier, then compare the live count
     * against limits.students. Shared by provision and restore because both
     * claim a seat — that sharing IS the cap-laundering guard.
     */
    private async checkRosterStock(teacherId: string): Promise<void> {
        const entitlements = await this.getEntitlements(teacherId);
        // Fail closed on an unresolvable tier, as the function does: an unreadable
        // plan must never be read as an open roster.
        const limit = entitlements?.limits.students ?? 0;
        if (isUnlimited(limit)) {
            return;
        }
        // limit === 0 is Personal, refused without ever counting: the solo
        // practice plan has no roster to be at the bottom of.
        if (limit === 0 || this.activeStudents(teacherId).length >= limit) {
            const error: FakeProvisionError = {
                status: LIMIT_REACHED_STATUS,
                body: limitReachedBody('students', limit, entitlements?.tier ?? 'free'),
            };
            throw error;
        }
    }

    /** One 404 for "no such row" and "on somebody else's roster" alike. */
    private ownedRow(teacherId: string, studentId: string): FakeRosterRow {
        const row = (this.roster.get(teacherId) ?? []).find((entry) => entry.id === studentId);
        if (!row) {
            const error: FakeProvisionError = { status: 404, body: { error: 'Student not found' } };
            throw error;
        }
        return row;
    }

    /**
     * Mirrors student-provision's 'create': the stock check comes first, before
     * any write, so a refused teacher is never left with an account nothing
     * points at. Ids are deterministic here where the function mints uuids —
     * nothing in the rules turns on their shape.
     */
    async provisionStudent(teacherId: string): Promise<FakeRosterRow> {
        await this.checkRosterStock(teacherId);

        const seq = this.nextRosterId;
        this.nextRosterId += 1;
        const row: FakeRosterRow = { id: `roster-${seq}`, studentUserId: `student-${seq}`, archived: false };
        this.roster.set(teacherId, [...(this.roster.get(teacherId) ?? []), row]);
        return row;
    }

    /**
     * Mirrors 'archive': frees the seat and revokes the code, deletes nothing,
     * and needs no stock check — giving a seat back can never exceed a limit.
     * Idempotent, like the guarded update it stands in for.
     */
    archiveStudent(teacherId: string, studentId: string): void {
        this.ownedRow(teacherId, studentId).archived = true;
    }

    /**
     * Mirrors 'restore', which is where the cap could be laundered: archive +
     * restore would turn three free seats into any number if a restore did not
     * claim its seat exactly as a create does.
     */
    async restoreStudent(teacherId: string, studentId: string): Promise<void> {
        const row = this.ownedRow(teacherId, studentId);
        // An active row already holds its seat, so there is nothing to re-occupy —
        // and checking anyway would 402 a teacher sitting exactly at their limit
        // for what is a no-op.
        if (!row.archived) {
            return;
        }
        await this.checkRosterStock(teacherId);
        row.archived = false;
    }
}
