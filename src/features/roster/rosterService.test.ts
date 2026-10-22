import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as billingApiModule from '@/features/billing/billingApi';
import {
    attestationFor,
    deleteStudent,
    provisionStudent,
    RESET_INCOMPLETE_MESSAGE,
    RESET_UNCONFIRMED_MESSAGE,
    resetStudentAccess,
    restoreStudent,
} from '@/features/roster/rosterService';

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

const ATTESTATION = attestationFor('DE', 'Germany');

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

        const result = await provisionStudent('  Ada Lovelace  ', { method: 'code', attestation: ATTESTATION });

        expect(result).toEqual({ student: STUDENT, loginCode: 'ABCD-EFGH-JKMN' });
        expect(sentPayload()).toEqual({
            action: 'create',
            displayName: 'Ada Lovelace',
            method: 'code',
            attestation: ATTESTATION,
        });
    });

    it('sends the invite branch the address and the page the link has to land on', async () => {
        callEdgeFunction.mockResolvedValue(
            jsonResponse({ student: STUDENT, invited: true, studentEmail: 'ada@example.com' }),
        );

        const result = await provisionStudent('Ada Lovelace', {
            method: 'email',
            studentEmail: ' ada@example.com ',
            parentEmail: ' parent@example.com ',
            attestation: ATTESTATION,
        });

        expect(result).toEqual({ student: STUDENT, invited: true, studentEmail: 'ada@example.com' });
        // The function cannot know which origin the teacher is on, so the client
        // is the only one who can say where its own /student/welcome lives.
        expect(sentPayload()).toEqual({
            action: 'create',
            displayName: 'Ada Lovelace',
            method: 'email',
            attestation: ATTESTATION,
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
            provisionStudent('Ada Lovelace', {
                method: 'email',
                studentEmail: 'ada@example.com',
                attestation: ATTESTATION,
            }),
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
    it('a reset that fails part-way says the card is held for up to 10 minutes, and the retry resumes its hold', async () => {
        const token = '6f1c2a40-1b2c-4d3e-8f90-0123456789ab';
        callEdgeFunction.mockResolvedValueOnce(
            jsonResponse({ error: 'whatever the server said', code: 'reset_incomplete', resetToken: token }, 502),
        );
        await expect(resetStudentAccess('s-held')).rejects.toThrow(RESET_INCOMPLETE_MESSAGE);
        expect(RESET_INCOMPLETE_MESSAGE).toContain('held for up to 10 minutes');

        callEdgeFunction.mockResolvedValueOnce(jsonResponse({ loginCode: 'PQRS-TUVW-XYZ2', username: null }));
        await expect(resetStudentAccess('s-held')).resolves.toMatchObject({ loginCode: 'PQRS-TUVW-XYZ2' });
        expect((callEdgeFunction.mock.calls[1] as [string, Record<string, unknown>])[1]).toMatchObject({
            action: 'reset',
            studentId: 's-held',
            resetToken: token,
        });

        // Done: the next reset of that student starts afresh.
        callEdgeFunction.mockResolvedValueOnce(jsonResponse({ loginCode: 'AAAA-BBBB-CCCC', username: null }));
        await resetStudentAccess('s-held');
        expect((callEdgeFunction.mock.calls[2] as [string, Record<string, unknown>])[1]).not.toHaveProperty(
            'resetToken',
        );
    });

    it('a reset whose password write could not be confirmed says to try again in a few minutes, and keeps the token', async () => {
        // 20261022110800: the server quarantines the attempt, so the next try
        // is held off until the write is confirmed or the hold runs out.
        const token = '7a2d3b51-2c3d-4e4f-9a01-123456789abc';
        callEdgeFunction.mockResolvedValueOnce(
            jsonResponse({ error: 'whatever the server said', code: 'reset_unconfirmed', resetToken: token }, 502),
        );
        await expect(resetStudentAccess('s-unsure')).rejects.toThrow(RESET_UNCONFIRMED_MESSAGE);
        expect(RESET_UNCONFIRMED_MESSAGE).toContain('held for up to 10 minutes');
        expect(RESET_UNCONFIRMED_MESSAGE).toContain('Try the reset again in a few minutes.');

        // The retry is told the reset is still finishing, in the server's words, and still sends the token.
        callEdgeFunction.mockResolvedValueOnce(
            jsonResponse(
                {
                    error: 'Another reset of this student is still finishing. Try again in a few minutes.',
                    code: 'reset_in_progress',
                },
                409,
            ),
        );
        await expect(resetStudentAccess('s-unsure')).rejects.toThrow('Try again in a few minutes.');
        expect((callEdgeFunction.mock.calls[1] as [string, Record<string, unknown>])[1]).toMatchObject({
            resetToken: token,
        });
    });

    it('a deletion check that could not be answered keeps the token it hands back', async () => {
        const token = '8b3e4c62-3d4e-4f50-8b12-23456789abcd';
        callEdgeFunction.mockResolvedValueOnce(
            jsonResponse(
                {
                    error: 'We could not check your account just now, so nothing was changed. Please try again in a minute.',
                    code: 'deletion_check_unavailable',
                    resetToken: token,
                },
                503,
            ),
        );
        await expect(resetStudentAccess('s-check')).rejects.toThrow('Please try again in a minute.');
        callEdgeFunction.mockResolvedValueOnce(jsonResponse({ loginCode: 'PQRS-TUVW-XYZ2', username: null }));
        await resetStudentAccess('s-check');
        expect((callEdgeFunction.mock.calls[1] as [string, Record<string, unknown>])[1]).toMatchObject({
            resetToken: token,
        });
    });

    it('another reset still finishing is reported in the server’s words, with no token sent', async () => {
        callEdgeFunction.mockResolvedValue(
            jsonResponse(
                { error: 'Another reset of this student is still finishing.', code: 'reset_in_progress' },
                409,
            ),
        );
        await expect(resetStudentAccess('s-other')).rejects.toThrow(
            'Another reset of this student is still finishing.',
        );
        expect(sentPayload()).not.toHaveProperty('resetToken');
    });
});

describe('the age attestation', () => {
    it('is the exact sentence for the country’s age, versioned', () => {
        expect(ATTESTATION).toEqual({
            country: 'DE',
            countryName: 'Germany',
            confirmed: true,
            wording: 'I confirm this student is at least 16 years old, the minimum age to use Cleffy in Germany.',
            version: '2026-10-21',
        });
    });

    it('goes with a restore', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ ok: true }));
        await restoreStudent('s1', ATTESTATION);
        expect(sentPayload()).toEqual({ action: 'restore', studentId: 's1', attestation: ATTESTATION });
    });
});

describe('deleteStudent', () => {
    it('asks student-provision to delete, and surfaces a refusal', async () => {
        callEdgeFunction.mockResolvedValue(jsonResponse({ ok: true }));
        await deleteStudent('s1');
        expect(sentPayload()).toEqual({ action: 'delete', studentId: 's1' });

        callEdgeFunction.mockResolvedValue(jsonResponse({ error: 'Could not delete the student' }, 502));
        await expect(deleteStudent('s1')).rejects.toThrow('Could not delete the student');
    });
});
