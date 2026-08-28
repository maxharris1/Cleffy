import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as billingApiModule from '@/features/billing/billingApi';
import { provisionStudent, resetStudentAccess } from '@/features/roster/rosterService';

const callEdgeFunction = vi.fn();

// limitErrorFrom stays real: a 402 has to keep its type through failFrom, and
// that is the one failure this module is not allowed to flatten into an Error.
vi.mock('@/features/billing/billingApi', async (importOriginal) => ({
    ...(await importOriginal<typeof billingApiModule>()),
    callEdgeFunction: (...args: unknown[]) => callEdgeFunction(...args),
}));

const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const STUDENT = { id: 's1', studentUserId: 's1-user', displayName: 'Ada Lovelace' };

/** The payload the page never sees, read back off the one call that was made. */
const sentPayload = (): Record<string, unknown> =>
    (callEdgeFunction.mock.calls[0] as [string, Record<string, unknown>])[1];

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('provisionStudent', () => {
    it('asks for a code and gets one, without offering the server an address', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ student: STUDENT, loginCode: 'ABCD-EFGH-JKMN' }));

        const result = await provisionStudent('  Ada Lovelace  ', { method: 'code' });

        expect(result).toEqual({ student: STUDENT, loginCode: 'ABCD-EFGH-JKMN' });
        expect(sentPayload()).toEqual({ action: 'create', displayName: 'Ada Lovelace', method: 'code' });
    });

    it('sends the invite branch the address and the page the link has to land on', async () => {
        callEdgeFunction.mockResolvedValue(
            jsonResponse({ student: STUDENT, invited: true, studentEmail: 'ada@example.com' }),
        );

        const result = await provisionStudent('Ada Lovelace', {
            method: 'email',
            studentEmail: ' ada@example.com ',
            parentEmail: ' parent@example.com ',
        });

        expect(result).toEqual({ student: STUDENT, invited: true, studentEmail: 'ada@example.com' });
        // The function cannot know which origin the teacher is on, so the client
        // is the only one who can say where its own /student/welcome lives.
        expect(sentPayload()).toEqual({
            action: 'create',
            displayName: 'Ada Lovelace',
            method: 'email',
            parentEmail: 'parent@example.com',
            studentEmail: 'ada@example.com',
            redirectTo: `${window.location.origin}/student/welcome`,
        });
    });

    it('surfaces the server’s own words when the address already belongs to someone', async () => {
        callEdgeFunction.mockResolvedValue(
            jsonResponse({ error: 'That email address is already in use.', code: 'email_in_use' }, 409),
        );

        await expect(
            provisionStudent('Ada Lovelace', { method: 'email', studentEmail: 'ada@example.com' }),
        ).rejects.toThrow('That email address is already in use.');
    });
});

describe('resetStudentAccess', () => {
    it('returns the new card and the username the student keeps', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ loginCode: 'PQRS-TUVW-XYZ2', username: 'ada_lovelace' }));

        await expect(resetStudentAccess('s1')).resolves.toEqual({
            loginCode: 'PQRS-TUVW-XYZ2',
            username: 'ada_lovelace',
        });
        expect(sentPayload()).toEqual({
            action: 'reset',
            studentId: 's1',
            redirectTo: `${window.location.origin}/student/welcome`,
        });
    });

    it('reads a never-claimed code student as having no username to keep', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ loginCode: 'PQRS-TUVW-XYZ2' }));
        await expect(resetStudentAccess('s1')).resolves.toEqual({ loginCode: 'PQRS-TUVW-XYZ2', username: null });
    });

    it('reports an emailed link as sent rather than as a card', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ invited: true, studentEmail: 'clara@example.com' }));
        await expect(resetStudentAccess('s1')).resolves.toEqual({ invited: true, studentEmail: 'clara@example.com' });
    });
});
