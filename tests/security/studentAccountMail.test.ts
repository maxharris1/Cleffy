import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mailLimit, MAIL_WINDOW_MS } from '../../supabase/functions/_shared/mailBudget';
import {
    recipientKey,
    reserveStudentAccountMail,
    STUDENT_ACCOUNT_MAIL_LIMITS,
    type StudentAccountMailDeps,
    studentMailRefusal,
} from '../../supabase/functions/_shared/studentAccountMail';

/**
 * Student invitations and email-method reset links (Codex r1 Part A finding
 * 3, decision 51): budgeted per address, per teacher and in the project's
 * studentAccountMail share before GoTrue sends them, so they cannot spend the
 * auth reserve.
 */
const limiter = () => {
    const counts = new Map<string, number>();
    const deps: StudentAccountMailDeps = {
        checkRateLimit: async (key, limit) => {
            const used = counts.get(key) ?? 0;
            if (used >= limit) {
                return { ok: false, retryAfterSec: 1800 };
            }
            counts.set(key, used + 1);
            return { ok: true };
        },
        refundRateLimit: async (key) => {
            counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
        },
        projectLimits: { hour: mailLimit('studentAccountMail', 'hour'), day: mailLimit('studentAccountMail', 'day') },
    };
    return { counts, deps };
};

describe('the student account mail budget', () => {
    it('has a share of its own in the split, under the per-teacher and per-address limits', () => {
        expect(mailLimit('studentAccountMail', 'hour')).toEqual({ limit: 6, windowMs: MAIL_WINDOW_MS.hour });
        expect(mailLimit('studentAccountMail', 'day')).toEqual({ limit: 30, windowMs: MAIL_WINDOW_MS.day });
        expect(STUDENT_ACCOUNT_MAIL_LIMITS.perTeacher.hour.limit).toBeLessThan(6);
        expect(STUDENT_ACCOUNT_MAIL_LIMITS.perRecipient.hour.limit).toBeLessThan(
            STUDENT_ACCOUNT_MAIL_LIMITS.perTeacher.hour.limit,
        );
    });

    it('reserves in every scope and window, keyed by a hash of the address, never the address', async () => {
        const { counts, deps } = limiter();
        const reserved = await reserveStudentAccountMail(deps, 'teacher-1', 'Clara@Example.com ');
        expect(reserved.ok).toBe(true);
        const keys = [...counts.keys()];
        expect(keys).toHaveLength(6);
        expect(keys.join(' ')).not.toMatch(/clara|example/i);
        expect(keys).toContain(`mail:student-account:to:${await recipientKey('clara@example.com')}:hour`);
        expect(keys).toContain('mail:student-account:teacher:teacher-1:day');
        expect(keys).toContain('mail:student-account:hour');
        expect(await recipientKey('clara@example.com')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stops one address being mailed over and over, whoever asks, and hands back what it took', async () => {
        const { counts, deps } = limiter();
        for (let i = 0; i < STUDENT_ACCOUNT_MAIL_LIMITS.perRecipient.hour.limit; i += 1) {
            expect((await reserveStudentAccountMail(deps, `teacher-${i}`, 'kid@example.com')).ok).toBe(true);
        }
        const refused = await reserveStudentAccountMail(deps, 'teacher-x', 'kid@example.com');
        expect(refused).toMatchObject({ ok: false, scope: 'recipient' });
        expect(counts.get('mail:student-account:teacher:teacher-x:hour') ?? 0).toBe(0);
        expect(counts.get('mail:student-account:hour')).toBe(STUDENT_ACCOUNT_MAIL_LIMITS.perRecipient.hour.limit);
    });

    it('stops one teacher before they can spend the whole project share', async () => {
        const { counts, deps } = limiter();
        const perTeacher = STUDENT_ACCOUNT_MAIL_LIMITS.perTeacher.hour.limit;
        for (let i = 0; i < perTeacher; i += 1) {
            expect((await reserveStudentAccountMail(deps, 'teacher-1', `kid${i}@example.com`)).ok).toBe(true);
        }
        expect(await reserveStudentAccountMail(deps, 'teacher-1', 'one-more@example.com')).toMatchObject({
            ok: false,
            scope: 'teacher',
        });
        expect(counts.get('mail:student-account:hour')).toBe(perTeacher);
    });

    it('stops at the project share however many teachers ask, and the auth reserve is never lent', async () => {
        const { deps } = limiter();
        const share = mailLimit('studentAccountMail', 'hour').limit;
        for (let i = 0; i < share; i += 1) {
            expect((await reserveStudentAccountMail(deps, `t${i}`, `k${i}@example.com`)).ok).toBe(true);
        }
        expect(await reserveStudentAccountMail(deps, 'late', 'late@example.com')).toMatchObject({
            ok: false,
            scope: 'project',
        });
    });

    it('release hands back every scope', async () => {
        const { counts, deps } = limiter();
        const reserved = await reserveStudentAccountMail(deps, 'teacher-1', 'kid@example.com');
        if (!reserved.ok) {
            throw new Error('expected a reservation');
        }
        await reserved.release();
        expect([...counts.values()].every((n) => n === 0)).toBe(true);
    });

    it('says what was refused, that nothing changed, and when to try again', () => {
        const body = studentMailRefusal({ scope: 'recipient', retryAfterSec: 1800 });
        expect(body).toMatchObject({ code: 'mail_budget_spent', retryAfterSec: 1800 });
        expect(body.error).toContain('Nothing was changed');
        expect(body.error).toContain('30 minutes');
    });
});

describe('student-provision spends it before GoTrue sends anything', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-provision/index.ts'), 'utf8');

    it('an invitation reserves before inviteUserByEmail, and an address already in use hands it back', () => {
        const invite = source.slice(source.indexOf('const createEmailStudent = async'));
        const reserve = invite.indexOf('await reserveStudentMail(userId, studentEmail)');
        expect(reserve).toBeGreaterThan(-1);
        expect(reserve).toBeLessThan(invite.indexOf('inviteUserByEmail('));
        const inUse = invite.indexOf('isEmailInUse(inviteError)');
        expect(invite.slice(inUse, inUse + 200)).toContain('await mail.release()');
    });

    it('a reset link reserves before the old password is scrambled, so a spent budget revokes nothing', () => {
        const reset = source.slice(source.indexOf('const resetStudentAccess = async'));
        const reserve = reset.indexOf('await reserveStudentMail(userId, row.student_email)');
        expect(reserve).toBeGreaterThan(-1);
        expect(reserve).toBeLessThan(reset.indexOf('password: generateProvisionPassword()'));
        expect(reset.indexOf('password: generateProvisionPassword()')).toBeLessThan(reset.indexOf('signInWithOtp('));
        expect(source).toContain('jsonResponse(studentMailRefusal(mail), 429)');
    });
});
