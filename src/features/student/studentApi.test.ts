import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudentAuthError, claimStudentAccount, loginStudent } from '@/features/student/studentApi';

const signInWithPassword = vi.fn();
const setSession = vi.fn();

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
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
