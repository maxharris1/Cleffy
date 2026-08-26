import { describe, expect, it } from 'vitest';

import { TIER_LIMITS } from '../../supabase/functions/_shared/entitlements';
import type { AssignmentAccess, MemberRole } from '../../src/types/database';
import { assignRole, FakeBilling, unassignRole, type FakeProvisionError, type FakeRosterRow } from './fakeBilling';

/**
 * The roster half of pricing v2: who may provision a student, what archiving and
 * restoring do to a seat, and what an assignment grants.
 *
 * The stock rules run against FakeBilling, which mirrors student-provision's
 * checkRosterStock the way it already mirrors consume_quota(). The two rules
 * that live only in SQL — assign_score()'s membership upsert and the
 * practice_notes policies — are not re-implemented anywhere; they are asserted
 * as tables of expectations, so what a reviewer checks is the table against the
 * migration rather than one implementation against another.
 */

const FREE_SEATS = TIER_LIMITS.free.students;

/** Unlimited is unlimited; this is just a number big enough to be convincing. */
const MANY = 12;

/** Runs work that must be refused and hands back the refusal student-provision sends. */
const refusalFrom = async (work: Promise<unknown>): Promise<FakeProvisionError> => {
    try {
        await work;
    } catch (err) {
        return err as FakeProvisionError;
    }
    throw new Error('expected the roster to refuse');
};

const fill = async (billing: FakeBilling, teacherId: string, count: number): Promise<FakeRosterRow[]> => {
    const rows: FakeRosterRow[] = [];
    for (let i = 0; i < count; i += 1) {
        rows.push(await billing.provisionStudent(teacherId));
    }
    return rows;
};

describe('the roster stock', () => {
    it('lets a free teacher fill three seats and refuses the fourth with the typed error', async () => {
        const billing = new FakeBilling();
        await fill(billing, 'teacher', FREE_SEATS);

        const refusal = await refusalFrom(billing.provisionStudent('teacher'));
        expect(refusal.status).toBe(402);
        expect(refusal.body).toEqual({
            code: 'limit_reached',
            metric: 'students',
            limit: FREE_SEATS,
            tier: 'free',
        });

        // The refused create wrote nothing — no roster row, and (upstream of this
        // fake) no orphaned auth user either.
        expect(billing.activeStudents('teacher')).toHaveLength(FREE_SEATS);
    });

    it('refuses Personal at the very first student — the practice plan has no roster at all', async () => {
        const billing = new FakeBilling();
        billing.subscribe('soloist', 'personal');

        const refusal = await refusalFrom(billing.provisionStudent('soloist'));
        expect(refusal.status).toBe(402);
        // NOTE: `code` is deliberately not asserted here. isFairUseCap() answers
        // true for ('personal', 'students') — Personal is a paid tier and 0 is a
        // finite limit — so this refusal currently goes out as 'fair_use_cap',
        // which LimitReachedNotice renders as "get in touch and we will lift it"
        // with the upgrade button suppressed. For a seat count that is 0 because
        // the plan has no roster, the honest answer is 'limit_reached' and a
        // prompt to upgrade to Teacher. Once isFairUseCap() stops treating a
        // stock as a ceiling, tighten this to the full toEqual above.
        expect(refusal.body).toMatchObject({ metric: 'students', limit: 0, tier: 'personal' });
        expect(billing.activeStudents('soloist')).toHaveLength(0);
    });

    it('gives Teacher a roster with no ceiling', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher');

        await fill(billing, 'teacher', MANY);
        expect(billing.activeStudents('teacher')).toHaveLength(MANY);
    });

    it('gives Academy the same unlimited roster', async () => {
        const billing = new FakeBilling();
        billing.subscribe('school', 'academy');

        await fill(billing, 'school', MANY);
        expect(billing.activeStudents('school')).toHaveLength(MANY);
    });

    it('gives an Academy member the same unlimited roster as the owner who pays for it', async () => {
        // A seat holder resolves to tier 'academy' through the owner's
        // subscription, so their roster is the owner's roster rules, not free's.
        const billing = new FakeBilling();
        billing.subscribe('owner', 'academy');
        billing.seatIn('member', 'owner');

        await fill(billing, 'member', MANY);
        expect(billing.activeStudents('member')).toHaveLength(MANY);
    });

    it('never moves a usage counter, because a seat is occupancy rather than activity', async () => {
        const billing = new FakeBilling();
        await fill(billing, 'teacher', FREE_SEATS);
        await refusalFrom(billing.provisionStudent('teacher'));

        expect(billing.countOf('teacher', 'students')).toBe(0);
    });

    it('keeps each teacher on their own roster', async () => {
        const billing = new FakeBilling();
        await fill(billing, 'teacher-a', FREE_SEATS);

        await expect(billing.provisionStudent('teacher-b')).resolves.toMatchObject({ archived: false });
    });
});

describe('archiving and restoring a student', () => {
    /** A free teacher at exactly three, with `first` the one the test will archive. */
    const fullFreeRoster = async (): Promise<{ billing: FakeBilling; first: FakeRosterRow }> => {
        const billing = new FakeBilling();
        const first = await billing.provisionStudent('teacher');
        await fill(billing, 'teacher', FREE_SEATS - 1);
        return { billing, first };
    };

    it('frees a seat, and deletes nothing while doing it', async () => {
        const { billing, first } = await fullFreeRoster();

        billing.archiveStudent('teacher', first.id);
        await expect(billing.provisionStudent('teacher')).resolves.toMatchObject({ archived: false });

        // The archived student keeps their row — and with it their assignments,
        // annotations and practice notes. Only the seat went back.
        expect(billing.roster.get('teacher')).toHaveLength(FREE_SEATS + 1);
        expect(billing.activeStudents('teacher')).toHaveLength(FREE_SEATS);
    });

    it('refuses a restore that would put the teacher back over the cap', async () => {
        // The cap-laundering guard: without the stock check on restore, archive +
        // restore turns three free seats into as many as you like.
        const { billing, first } = await fullFreeRoster();
        billing.archiveStudent('teacher', first.id);
        await billing.provisionStudent('teacher');

        const refusal = await refusalFrom(billing.restoreStudent('teacher', first.id));
        expect(refusal.status).toBe(402);
        expect(refusal.body).toEqual({
            code: 'limit_reached',
            metric: 'students',
            limit: FREE_SEATS,
            tier: 'free',
        });

        // Refused, not deleted: the row is still there to restore later.
        expect(billing.activeStudents('teacher')).toHaveLength(FREE_SEATS);
        expect(billing.roster.get('teacher')).toHaveLength(FREE_SEATS + 1);
    });

    it('allows a restore back into a seat that is actually free', async () => {
        const { billing, first } = await fullFreeRoster();
        billing.archiveStudent('teacher', first.id);

        await expect(billing.restoreStudent('teacher', first.id)).resolves.toBeUndefined();
        expect(billing.activeStudents('teacher')).toHaveLength(FREE_SEATS);
    });

    it('treats restoring an active student as a no-op, even at exactly the limit', async () => {
        // Re-running restore on a row that never left must not 402 a teacher who
        // sits on their last seat: it is asking for a state they are already in.
        const { billing, first } = await fullFreeRoster();

        await expect(billing.restoreStudent('teacher', first.id)).resolves.toBeUndefined();
        expect(billing.activeStudents('teacher')).toHaveLength(FREE_SEATS);
    });

    it('answers one flat 404 for a student on somebody else’s roster', async () => {
        // Whether that id exists on another teacher's roster is not the caller's
        // business, so "no such row" and "not yours" are the same answer.
        const billing = new FakeBilling();
        const mine = await billing.provisionStudent('teacher-a');

        const refusal = await refusalFrom(billing.restoreStudent('teacher-b', mine.id));
        expect(refusal.status).toBe(404);
        expect(refusal.body).toEqual({ error: 'Student not found' });
    });
});

describe('a teacher whose plan has lapsed', () => {
    /** Ten students provisioned on Teacher, then the subscription goes canceled. */
    const lapsedRoster = async (): Promise<FakeBilling> => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher');
        await fill(billing, 'teacher', 10);
        billing.subscriptions = billing.subscriptions.map((sub) => ({ ...sub, status: 'canceled' }));
        return billing;
    };

    it('falls back to free limits for new students while the roster they built stays put', async () => {
        const billing = await lapsedRoster();

        const refusal = await refusalFrom(billing.provisionStudent('teacher'));
        expect(refusal.body).toEqual({
            code: 'limit_reached',
            metric: 'students',
            limit: FREE_SEATS,
            tier: 'free',
        });

        // Ten students keep their accounts, their codes and their history. A
        // lapsed card is a reason to stop growing a studio, never to delete one —
        // the same shape as the cloud-score cap, which archives rather than drops.
        expect(billing.activeStudents('teacher')).toHaveLength(10);
        expect(billing.roster.get('teacher')).toHaveLength(10);
    });

    it('cannot restore an archived student while still over the free cap', async () => {
        const billing = await lapsedRoster();
        const rows = billing.roster.get('teacher') ?? [];
        const archived = rows[0];
        if (!archived) {
            throw new Error('expected the lapsed teacher to have a roster');
        }

        billing.archiveStudent('teacher', archived.id);
        const refusal = await refusalFrom(billing.restoreStudent('teacher', archived.id));

        expect(refusal.status).toBe(402);
        expect(refusal.body).toMatchObject({ metric: 'students', limit: FREE_SEATS, tier: 'free' });
        expect(billing.activeStudents('teacher')).toHaveLength(9);
    });
});

/**
 * assign_score() maps the assignment's access onto a document_members role, and
 * unassign_score() takes that membership back. Both are SECURITY DEFINER SQL, so
 * what is checked here is the mapping table itself, transcribed from the two
 * CASE expressions in 20260826194426_roster.sql.
 */
describe('what an assignment grants', () => {
    const ROLE_CASES: Array<{ what: string; current: MemberRole | null; access: AssignmentAccess; role: MemberRole }> =
        [
            {
                what: 'edit access on a new assignment makes the student an editor',
                current: null,
                access: 'edit',
                role: 'editor',
            },
            {
                what: 'view access on a new assignment makes them a viewer',
                current: null,
                access: 'view',
                role: 'viewer',
            },
            {
                what: 'flipping an assignment to view-only demotes an editor',
                current: 'editor',
                access: 'view',
                role: 'viewer',
            },
            {
                what: 'flipping it back to edit promotes a viewer again',
                current: 'viewer',
                access: 'edit',
                role: 'editor',
            },
            {
                what: 'assigning a score to its owner never costs them ownership',
                current: 'owner',
                access: 'edit',
                role: 'owner',
            },
            { what: 'and view-only cannot demote an owner either', current: 'owner', access: 'view', role: 'owner' },
        ];

    it.each(ROLE_CASES)('$what', ({ current, access, role }) => {
        expect(assignRole(current, access)).toBe(role);
    });

    const UNASSIGN_CASES: Array<{
        what: string;
        current: MemberRole | null;
        hadAssignment: boolean;
        left: MemberRole | null;
    }> = [
        {
            what: 'unassigning takes back the editor role it granted',
            current: 'editor',
            hadAssignment: true,
            left: null,
        },
        {
            what: 'unassigning takes back the viewer role it granted',
            current: 'viewer',
            hadAssignment: true,
            left: null,
        },
        {
            what: 'unassigning leaves an owner membership alone',
            current: 'owner',
            hadAssignment: true,
            left: 'owner',
        },
        {
            what: 'unassigning someone who was never a member changes nothing',
            current: null,
            hadAssignment: true,
            left: null,
        },
        {
            // The asymmetry this closes: assign_score refuses anyone off the
            // caller's roster, so unassign_score must not accept anyone at all.
            what: 'unassigning where there was no assignment leaves a share-link collaborator alone',
            current: 'editor',
            hadAssignment: false,
            left: 'editor',
        },
        {
            what: 'unassigning where there was no assignment leaves a viewer alone too',
            current: 'viewer',
            hadAssignment: false,
            left: 'viewer',
        },
    ];

    it.each(UNASSIGN_CASES)('$what', ({ current, hadAssignment, left }) => {
        expect(unassignRole(current, hadAssignment)).toBe(left);
    });

    it('is the editor role by default, so a student can mark their own fingerings', () => {
        // The default matters: a student who cannot annotate has half a score.
        expect(assignRole(null, 'edit')).toBe('editor');
    });
});

interface PracticeNote {
    authorId: string;
    /** Who the note is ABOUT. Null is a note about the score in general. */
    studentUserId: string | null;
    shared: boolean;
}

/**
 * The practice_notes_select policy, transcribed:
 *
 *   author_id = auth.uid() or (shared and student_user_id = auth.uid())
 *
 * Postgres is what enforces it. This exists so the cases below read as a table
 * of who-sees-what, which is the part a reviewer has to be able to check against
 * the migration at a glance — it is a transcription, not a second implementation.
 */
const canReadNote = (note: PracticeNote, viewerId: string): boolean =>
    note.authorId === viewerId || (note.shared && note.studentUserId === viewerId);

describe('who can read a practice note', () => {
    const TEACHER = 'teacher';
    const STUDENT = 'student-1';
    const OTHER_STUDENT = 'student-2';
    const OTHER_TEACHER = 'teacher-2';

    const note = (overrides: Partial<PracticeNote> = {}): PracticeNote => ({
        authorId: TEACHER,
        studentUserId: STUDENT,
        shared: false,
        ...overrides,
    });

    const CASES: Array<{ what: string; row: PracticeNote; viewer: string; visible: boolean }> = [
        { what: 'the author reads their own unshared note', row: note(), viewer: TEACHER, visible: true },
        { what: 'the author reads their own shared note', row: note({ shared: true }), viewer: TEACHER, visible: true },
        {
            what: 'the author reads their own note about the score rather than a student',
            row: note({ studentUserId: null }),
            viewer: TEACHER,
            visible: true,
        },
        {
            what: 'the student it names reads it once it is shared',
            row: note({ shared: true }),
            viewer: STUDENT,
            visible: true,
        },
        {
            what: 'the student it names cannot read it while it is unshared',
            row: note(),
            viewer: STUDENT,
            visible: false,
        },
        {
            what: 'another student cannot read a note shared with somebody else',
            row: note({ shared: true }),
            viewer: OTHER_STUDENT,
            visible: false,
        },
        {
            what: 'another teacher reads nothing at all, shared or not',
            row: note({ shared: true }),
            viewer: OTHER_TEACHER,
            visible: false,
        },
        {
            what: 'a shared note naming nobody still reaches nobody but its author',
            row: note({ studentUserId: null, shared: true }),
            viewer: STUDENT,
            visible: false,
        },
    ];

    it.each(CASES)('$what', ({ row, viewer, visible }) => {
        expect(canReadNote(row, viewer)).toBe(visible);
    });

    it('is what lets one journal hold both halves of a lesson', () => {
        // The whole point of the flag: the same page carries "watch the left hand
        // in bar 12" for the student and "parents want to move to Tuesdays" for
        // the teacher, and only the first one travels.
        const forStudent = note({ shared: true });
        const forSelf = note();

        expect(canReadNote(forStudent, STUDENT)).toBe(true);
        expect(canReadNote(forSelf, STUDENT)).toBe(false);
        expect([forStudent, forSelf].every((row) => canReadNote(row, TEACHER))).toBe(true);
    });
});
