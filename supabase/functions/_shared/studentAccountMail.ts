/**
 * The budget for the mail student-provision makes GoTrue send: the invitation
 * an email-method student gets on create, and the sign-in link a teacher's
 * reset sends them.
 *
 * GoTrue sends these itself, over the same Resend account and inside the same
 * `rate_limit_email_sent` ceiling as password resets and sign-up
 * confirmations, so without this nothing in our code counted them: one teacher
 * session (or a stolen one) could invite and re-reset until the auth mail
 * people are waiting on stopped going out. Now each send reserves, BEFORE it is
 * made:
 *
 *  * one unit of the recipient's own limit (an address cannot be mailed over
 *    and over, whoever asks);
 *  * one unit of the teacher's own limit;
 *  * one unit of `studentAccountMail` in every window of the project's split
 *    (_shared/mailBudget.ts), which the auth reserve never lends to.
 *
 * Any one refusing hands back what the others took and sends nothing; the
 * caller answers 429 with when to try again. On a reset that is checked before
 * the old password is scrambled, so a spent budget never leaves a student
 * locked out and waiting for a link that was not sent.
 *
 * What was counted is handed back only when GoTrue certainly sent nothing (the
 * caller decides: an "already registered" invite is one); any other failure
 * keeps it, the resendDelivery.ts rule that a refund is never made on doubt.
 *
 * NO runtime imports, for the reason mailBudget.ts gives: index.ts passes the
 * limiter and the split's limits in, and vitest loads this exact file.
 */

export interface MailWindowLimit {
    limit: number;
    windowMs: number;
}

export type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface StudentAccountMailDeps {
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    refundRateLimit: (key: string) => Promise<void>;
    /** mailLimit('studentAccountMail', window) for each window of the split. */
    projectLimits: { hour: MailWindowLimit; day: MailWindowLimit };
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The person-sized limits under the project share. A class onboarding of a few
 * email students an hour fits; a loop re-sending to one address does not.
 */
export const STUDENT_ACCOUNT_MAIL_LIMITS = {
    perTeacher: { hour: { limit: 4, windowMs: HOUR_MS }, day: { limit: 15, windowMs: DAY_MS } },
    perRecipient: { hour: { limit: 2, windowMs: HOUR_MS }, day: { limit: 3, windowMs: DAY_MS } },
} as const;

export type StudentMailScope = 'recipient' | 'teacher' | 'project';

export type StudentMailReservation =
    { ok: true; release: () => Promise<void> } | { ok: false; scope: StudentMailScope; retryAfterSec: number };

/** The limiter key for an address: a SHA-256 of it, never the address itself. */
export const recipientKey = async (address: string): Promise<string> => {
    const bytes = new TextEncoder().encode(address.trim().toLowerCase());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** The keys one send reserves, narrowest first, so one address or teacher is stopped before the shared share. */
export const studentMailKeys = async (
    teacherId: string,
    recipient: string,
): Promise<Array<{ key: string; scope: StudentMailScope; window: 'hour' | 'day' }>> => {
    const to = await recipientKey(recipient);
    return [
        { key: `mail:student-account:to:${to}:hour`, scope: 'recipient', window: 'hour' },
        { key: `mail:student-account:to:${to}:day`, scope: 'recipient', window: 'day' },
        { key: `mail:student-account:teacher:${teacherId}:hour`, scope: 'teacher', window: 'hour' },
        { key: `mail:student-account:teacher:${teacherId}:day`, scope: 'teacher', window: 'day' },
        { key: 'mail:student-account:hour', scope: 'project', window: 'hour' },
        { key: 'mail:student-account:day', scope: 'project', window: 'day' },
    ];
};

/** Reserve one invitation or reset link to `recipient`, sent on `teacherId`'s behalf. */
export const reserveStudentAccountMail = async (
    deps: StudentAccountMailDeps,
    teacherId: string,
    recipient: string,
): Promise<StudentMailReservation> => {
    const reserved: string[] = [];
    const release = async (): Promise<void> => {
        await Promise.all(reserved.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
    };
    for (const { key, scope, window } of await studentMailKeys(teacherId, recipient)) {
        const { limit, windowMs } =
            scope === 'project'
                ? deps.projectLimits[window]
                : STUDENT_ACCOUNT_MAIL_LIMITS[scope === 'teacher' ? 'perTeacher' : 'perRecipient'][window];
        const gate = await deps.checkRateLimit(key, limit, windowMs);
        if (!gate.ok) {
            await release();
            return { ok: false, scope, retryAfterSec: gate.retryAfterSec };
        }
        reserved.push(key);
    }
    return { ok: true, release };
};

/** The 429 body student-provision answers when a reservation is refused. */
export const studentMailRefusal = (refused: { scope: StudentMailScope; retryAfterSec: number }) => {
    const minutes = Math.max(1, Math.ceil(refused.retryAfterSec / 60));
    const wait = minutes >= 120 ? `${Math.ceil(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const why =
        refused.scope === 'recipient'
            ? 'This address has already been sent several sign-in emails recently.'
            : refused.scope === 'teacher'
              ? 'You have sent several student invitations or sign-in links recently.'
              : 'Cleffy has sent its share of student emails for now.';
    return {
        error: `${why} Nothing was changed; try again in about ${wait}.`,
        code: 'mail_budget_spent',
        retryAfterSec: refused.retryAfterSec,
    } as const;
};
