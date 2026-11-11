import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARCHIVED } from '../../../supabase/functions/student-login/handler';
import {
    STUDENT_ARCHIVED_MESSAGE,
    StudentAuthError,
    claimStudentAccount,
    fetchAccountDeleted,
    fetchSignInStillValid,
    loginStudent,
} from '@/features/student/studentApi';
import type { ManagedStudentRow } from '@/types/database';

const signInWithPassword = vi.fn();
const setSession = vi.fn();
const rpc = vi.fn();
/** What the caller's own managed_students read answers. */
const rosterRead = vi.fn();

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        rpc: (...args: unknown[]) => rpc(...args),
        from: () => ({
            select: () => ({ limit: () => ({ maybeSingle: () => rosterRead() }) }),
        }),
        auth: {
            signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
            setSession: (...args: unknown[]) => setSession(...args),
        },
    }),
    requireSupabaseConfig: () => ({ url: 'https://test.supabase.co', anonKey: 'test-anon-key' }),
}));

const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1', displayName: 'Ada Lovelace' };

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    signInWithPassword.mockReset();
    setSession.mockReset();
    setSession.mockResolvedValue({ error: null });
    fetchMock.mockResolvedValue(jsonResponse(TOKENS));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('loginStudent', () => {
    it('refuses a wrong email-student password the way student-login refuses a username', async () => {
        signInWithPassword.mockResolvedValue({
            data: { session: null },
            error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 },
        });

        const failure = loginStudent('kid@example.com', 'wrong');

        await expect(failure).rejects.toBeInstanceOf(StudentAuthError);
        await expect(failure).rejects.toMatchObject({ code: 'invalid_credentials' });
    });

    it('signs an email student in client-side, without touching the edge function', async () => {
        signInWithPassword.mockResolvedValue({
            data: { session: { user: { user_metadata: { display_name: 'Ada Lovelace' } } } },
            error: null,
        });

        await expect(loginStudent(' kid@example.com ', 'hunter2hunter2')).resolves.toBe('Ada Lovelace');

        // An email student is an ordinary auth user: GoTrue's own throttled
        // endpoint is theirs, which is also what makes /forgot-password work.
        expect(signInWithPassword).toHaveBeenCalledWith({ email: 'kid@example.com', password: 'hunter2hunter2' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps a rejected email sign-in to product copy rather than vendor prose', async () => {
        signInWithPassword.mockResolvedValue({
            data: { session: null },
            error: Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' }),
        });

        await expect(loginStudent('kid@example.com', 'nope')).rejects.toThrow('Email or password is incorrect.');
    });

    it('tells an archived email student why, in the same words student-login uses', async () => {
        // GoTrue refuses a banned account before it checks the password.
        signInWithPassword.mockResolvedValue({
            data: { session: null },
            error: Object.assign(new Error('User is banned'), { code: 'user_banned' }),
        });

        await expect(loginStudent('kid@example.com', 'hunter2hunter2')).rejects.toMatchObject({
            message: STUDENT_ARCHIVED_MESSAGE,
            code: 'student_archived',
        });
        expect(STUDENT_ARCHIVED_MESSAGE).toBe(ARCHIVED.error);
        expect(ARCHIVED.code).toBe('student_archived');
    });

    it('carries student-login’s archived answer through', async () => {
        fetchMock.mockResolvedValue(jsonResponse(ARCHIVED, 403));

        await expect(loginStudent('ada_lovelace', 'hunter2hunter2')).rejects.toMatchObject({
            message: STUDENT_ARCHIVED_MESSAGE,
            code: 'student_archived',
        });
        expect(setSession).not.toHaveBeenCalled();
    });

    it('posts a username to student-login with the anon key and no Authorization header', async () => {
        await expect(loginStudent('Ada_Lovelace', 'hunter2hunter2')).resolves.toBe('Ada Lovelace');

        expect(signInWithPassword).not.toHaveBeenCalled();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/functions/v1/student-login');
        // Sent verbatim — the function normalizes. An Authorization header would
        // only invite the function to trust an identity it must ignore.
        expect(JSON.parse(String(init.body))).toEqual({ username: 'Ada_Lovelace', password: 'hunter2hunter2' });
        expect(init.headers).not.toHaveProperty('Authorization');
        expect(setSession).toHaveBeenCalledWith({ access_token: 'access-1', refresh_token: 'refresh-1' });
    });

    it('carries the server’s refusal code without re-deriving what went wrong', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ error: 'That username and password did not work', code: 'invalid_credentials' }, 401),
        );

        await expect(loginStudent('ada_lovelace', 'nope')).rejects.toMatchObject({
            message: 'That username and password did not work',
            code: 'invalid_credentials',
        });
        expect(setSession).not.toHaveBeenCalled();
    });

    it('tells a dead network apart from a bad credential', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

        const error = await loginStudent('ada_lovelace', 'hunter2hunter2').catch((err: unknown) => err);
        // Deliberately NOT a StudentAuthError: nothing was said about the credential.
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(StudentAuthError);
        expect((error as Error).message).toMatch(/Could not reach Cleffy/);
    });
});

describe('claimStudentAccount', () => {
    it('spends the code on a username and password at student-claim', async () => {
        await expect(
            claimStudentAccount({ code: 'ABCD-EFGH-JKLM', username: 'ada_lovelace', password: 'hunter2hunter2' }),
        ).resolves.toBe('Ada Lovelace');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/functions/v1/student-claim');
        expect(JSON.parse(String(init.body))).toEqual({
            code: 'ABCD-EFGH-JKLM',
            username: 'ada_lovelace',
            password: 'hunter2hunter2',
        });
        expect(setSession).toHaveBeenCalledWith({ access_token: 'access-1', refresh_token: 'refresh-1' });
    });

    it('surfaces a taken username as the code the claim page acts on', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: 'That username is taken', code: 'username_taken' }, 409));

        await expect(
            claimStudentAccount({ code: 'ABCD-EFGH-JKLM', username: 'ada_lovelace', password: 'hunter2hunter2' }),
        ).rejects.toMatchObject({ message: 'That username is taken', code: 'username_taken' });
    });
});

describe('fetchSignInStillValid', () => {
    const row = (archivedAt: string | null): ManagedStudentRow => ({
        id: 'roster-1',
        teacher_id: 'teacher-1',
        student_user_id: 'student-1',
        display_name: 'Ada',
        parent_email: null,
        auth_method: 'code',
        username: 'ada',
        student_email: null,
        claimed_at: '2026-08-02T00:00:00Z',
        archived_at: archivedAt,
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        country: null,
        age_attested_at: null,
        age_attested_min_age: null,
    });

    beforeEach(() => rpc.mockReset());

    it('answers from an archived roster row without asking the server', async () => {
        await expect(fetchSignInStillValid(row('2026-10-10T00:00:00Z'))).resolves.toBe(false);
        expect(rpc).not.toHaveBeenCalled();
    });

    it('asks the server, which knows when a reset ended this session', async () => {
        rpc.mockResolvedValue({ data: true, error: null });
        await expect(fetchSignInStillValid(row(null))).resolves.toBe(false);
        expect(rpc).toHaveBeenCalledWith('student_access_revoked');

        rpc.mockResolvedValue({ data: false, error: null });
        await expect(fetchSignInStillValid(null)).resolves.toBe(true);
    });

    it('says it does not know when the server cannot answer', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
        await expect(fetchSignInStillValid(row(null))).resolves.toBeNull();
    });
});

describe('fetchAccountDeleted', () => {
    const rosterRow = { id: 'roster-1', archived_at: '2026-10-10T00:00:00Z' };

    beforeEach(() => {
        rpc.mockReset();
        rosterRead.mockReset();
    });

    it('is true only when the token is refused as a student’s AND no roster row answers it', async () => {
        rpc.mockResolvedValue({ data: true, error: null });
        rosterRead.mockResolvedValue({ data: null, error: null });
        await expect(fetchAccountDeleted()).resolves.toBe(true);
        expect(rpc).toHaveBeenCalledWith('student_access_revoked');
    });

    it('is false for an archived or reset student: the row is still there', async () => {
        rpc.mockResolvedValue({ data: true, error: null });
        rosterRead.mockResolvedValue({ data: rosterRow, error: null });
        await expect(fetchAccountDeleted()).resolves.toBe(false);
    });

    it('is false when no row answers but the token is not refused (a signed-out client reads nothing)', async () => {
        rpc.mockResolvedValue({ data: false, error: null });
        rosterRead.mockResolvedValue({ data: null, error: null });
        await expect(fetchAccountDeleted()).resolves.toBe(false);
    });

    it('is false whenever either question goes unanswered', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'offline' } });
        rosterRead.mockResolvedValue({ data: null, error: null });
        await expect(fetchAccountDeleted()).resolves.toBe(false);

        rpc.mockResolvedValue({ data: true, error: null });
        rosterRead.mockResolvedValue({ data: null, error: { message: 'offline' } });
        await expect(fetchAccountDeleted()).resolves.toBe(false);

        rosterRead.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(fetchAccountDeleted()).resolves.toBe(false);
    });
});
