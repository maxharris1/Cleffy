import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as authStorageModule from '@/features/auth/authStorage';
import type * as sessionModule from '@/features/auth/session';
import { AssignmentsPage } from '@/features/student/AssignmentsPage';
import type { ManagedStudentRow } from '@/types/database';
import { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';

/**
 * The teacher ended this sign-in (a reset, or an archive) while the student
 * had changes queued on the device. Unlike the page's other tests, sign-out
 * here is the real one, against a real Dexie: what matters is what is left on
 * the device afterwards.
 */

const DOC = 'c0ffee00-0000-4000-8000-0000000000aa';
const STUDENT = 'student-1';

const authSignOut = vi.fn(async (_options?: { scope?: string }) => ({ error: null }));
const syncBeforeSignOut = vi.fn();
const fetchMyRosterProfile = vi.fn();
const forgetStoredSessions = vi.fn();

const studentSession = {
    access_token: 'a',
    user: { id: STUDENT, is_anonymous: false, app_metadata: { user_type: 'student' }, user_metadata: {} },
} as unknown as Session;

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
    getSupabase: () => ({
        auth: {
            signOut: authSignOut,
            getSession: async () => ({ data: { session: studentSession } }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        },
    }),
}));

vi.mock('@/features/auth/authStorage', async (importOriginal) => ({
    ...(await importOriginal<typeof authStorageModule>()),
    forgetStoredSessions: (...args: unknown[]) => forgetStoredSessions(...args),
}));

vi.mock('@/features/student/studentApi', () => ({
    fetchMyAssignments: async () => [],
    fetchMyRosterProfile: (...args: unknown[]) => fetchMyRosterProfile(...args),
    fetchSignInStillValid: async () => false,
}));

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: studentSession, loading: false, lastEvent: null }),
    syncBeforeSignOut: (...args: unknown[]) => syncBeforeSignOut(...args),
}));

const rosterRow: ManagedStudentRow = {
    id: 'roster-1',
    teacher_id: 'teacher-1',
    student_user_id: STUDENT,
    display_name: 'Ada',
    parent_email: null,
    auth_method: 'code',
    username: 'ada',
    student_email: null,
    // Reset: Invited again, not archived.
    claimed_at: null,
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-10-10T00:00:00Z',
};

/** Stands in for the login page, showing what it was told. */
const StudentLoginStub = () => {
    const state = useLocation().state as { signedOutByTeacher?: boolean; keptChanges?: number } | null;
    return <p>{`student login: teacher ${String(state?.signedOutByTeacher)}, kept ${String(state?.keptChanges)}`}</p>;
};

const renderAssignments = () =>
    render(
        <MemoryRouter initialEntries={['/assignments']}>
            <Routes>
                <Route path="/assignments" element={<AssignmentsPage />} />
                <Route path="/student" element={<StudentLoginStub />} />
            </Routes>
        </MemoryRouter>,
    );

const queueOfflineMark = async (id: string) => {
    const store = new AnnotationStore(getDb(), DOC);
    store.setAuthor(STUDENT);
    await store.create({
        id,
        docId: DOC,
        page: 0,
        kind: 'stroke',
        color: '#111111',
        payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
        createdBy: null,
        createdAt: '2026-10-10T00:00:00Z',
        updatedAt: '2026-10-10T00:00:00Z',
        deletedAt: null,
        seq: 0,
    });
};

beforeEach(async () => {
    vi.clearAllMocks();
    const db = getDb();
    await Promise.all([db.ops.clear(), db.annotations.clear(), db.pdfCache.clear()]);
    await db.pdfCache.put({
        docId: DOC,
        bytes: new ArrayBuffer(4),
        title: 'Prelude',
        cachedAt: '2026-10-10T00:00:00Z',
        myRole: 'editor',
        userId: STUDENT,
    });
});

afterEach(() => {
    cleanup();
});

describe('AssignmentsPage once the teacher has ended this sign-in', () => {
    it('keeps a reset student’s queued marks for their next sign-in, and says so', async () => {
        fetchMyRosterProfile.mockResolvedValue(rosterRow);
        await queueOfflineMark('offline-mark');
        // Queued by a build that did not stamp ops yet: theirs through the
        // cached PDF, which this sign-out clears.
        await queueOfflineMark('legacy-mark');
        const db = getDb();
        const legacy = await db.ops.filter((op) => op.annotationId === 'legacy-mark').first();
        await db.ops.update(legacy!.opId!, { userId: undefined });

        renderAssignments();

        expect(await screen.findByText('student login: teacher true, kept 2')).toBeInTheDocument();
        expect(authSignOut).toHaveBeenCalledWith({ scope: 'local' });
        // Nothing to upload with, so nothing to warn about: no drain was tried.
        expect(syncBeforeSignOut).not.toHaveBeenCalled();
        const ops = await db.ops.where('docId').equals(DOC).toArray();
        expect(ops.map((op) => [op.annotationId, op.userId]).sort()).toEqual([
            ['legacy-mark', STUDENT],
            ['offline-mark', STUDENT],
        ]);
        expect(await db.annotations.where('docId').equals(DOC).count()).toBe(2);
        // The scores themselves go, as on any sign-out.
        expect(await db.pdfCache.count()).toBe(0);
    });

    it('keeps them for an archived student too (a restore brings the account back)', async () => {
        fetchMyRosterProfile.mockResolvedValue({ ...rosterRow, archived_at: '2026-10-10T00:00:00Z' });
        await queueOfflineMark('offline-mark');

        renderAssignments();

        expect(await screen.findByText('student login: teacher true, kept 1')).toBeInTheDocument();
        expect(await getDb().ops.where('docId').equals(DOC).count()).toBe(1);
    });

    it('still signs this browser out when the logout request fails', async () => {
        fetchMyRosterProfile.mockResolvedValue(rosterRow);
        authSignOut.mockResolvedValueOnce({ error: new Error('Failed to fetch') } as never);
        await queueOfflineMark('offline-mark');

        renderAssignments();

        expect(await screen.findByText('student login: teacher true, kept 1')).toBeInTheDocument();
        expect(forgetStoredSessions).toHaveBeenCalled();
        expect(await getDb().ops.where('docId').equals(DOC).count()).toBe(1);
    });

    it('clears everything for a student whose account was deleted', async () => {
        fetchMyRosterProfile.mockResolvedValue(null);
        await queueOfflineMark('offline-mark');

        renderAssignments();

        expect(await screen.findByText('student login: teacher true, kept 0')).toBeInTheDocument();
        await vi.waitFor(async () => expect(await getDb().ops.where('docId').equals(DOC).count()).toBe(0));
        expect(await getDb().annotations.where('docId').equals(DOC).count()).toBe(0);
    });
});
