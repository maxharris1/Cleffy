/**
 * The district export notice: 14 days before a district's data is purged
 * (20261021120700_district_retention.sql), its owner is told what goes, when,
 * and that they can export first.
 *
 * NO imports, like secretCompare.ts and studentSessions.ts: Deno loads it with
 * the `.ts` extension and vitest without, so the mail and the delivery loop the
 * function runs are the ones the tests pin. The Deno half is
 * district-retention-notices/index.ts.
 *
 * Delivery is what lets the purge go ahead: retention_district_run never soft
 * deletes a district whose notice has not been SENT, and waits 14 days from
 * when it was. A failed send is recorded and retried on the next run, never
 * counted as sent.
 *
 * Every notice goes out through the shared mail budget (`retentionNotice` in
 * `_shared/mailBudget.ts`'s LAUNCH_MAIL_SPLIT), reserved BEFORE the send, the
 * way guest-email-start reserves its share, and handed back when no mail went
 * out. A notice the budget holds back is deferred: its claim is released
 * without spending an attempt, and the next wake sends it. The
 * district_retention_notices table is the outbox, so nothing is dropped, and
 * the purge simply waits for it. Each delivery carries a provider idempotency
 * key stable for that notice, so a send retried after a lost answer is one
 * mail.
 */

export interface DistrictNoticeRow {
    id: number;
    to_email: string;
    studio_name: string;
    contract_ends_at: string;
    purge_not_before: string;
    /** When this cycle's notice was queued; reset when a new cycle re-queues it. */
    created_at: string;
}

export interface DistrictNoticeMessage {
    subject: string;
    text: string;
}

/** A reservation of one mail from the shared budget, or the budget saying no. */
export type MailReservation = { ok: true; release: () => Promise<void> } | { ok: false; retryAfterSec: number };

export interface DeliverDeps {
    claim: (limit: number) => Promise<DistrictNoticeRow[] | null>;
    /** Reserve one `retentionNotice` mail, hour and day, before sending. */
    reserve: () => Promise<MailReservation>;
    /** What one window of the budget allows: no point claiming more than that. */
    hourlyLimit: number;
    send: (
        to: string,
        message: DistrictNoticeMessage,
        idempotencyKey: string,
    ) => Promise<'sent' | 'failed' | 'unconfigured'>;
    finish: (id: number, error: string | null) => Promise<boolean>;
    /** Release the claim without spending an attempt: the budget said not yet. */
    defer: (id: number) => Promise<boolean>;
}

export interface DeliverResult {
    claimed: number;
    sent: number;
    failed: number;
    deferred: number;
}

/** At most this many notices per call; one district gets one notice per contract end. */
export const NOTICE_BATCH = 20;

/**
 * Stable for one notice of one cycle: the same row retried (a lost answer, a
 * lease that ran out) is the same key, so the provider sends it once; a cycle
 * cancelled and begun again re-queues the row with a new created_at, and the
 * owner is mailed again, as the purge's comments promise.
 */
export const noticeIdempotencyKey = (row: DistrictNoticeRow): string =>
    `district-retention-notice/${row.id}/${Date.parse(row.created_at)}`;

export const SUPPORT_ADDRESS = 'support@cleffy.io';

const longDate = (iso: string): string =>
    new Date(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

export const buildDistrictNotice = (row: DistrictNoticeRow): DistrictNoticeMessage => {
    const ended = longDate(row.contract_ends_at);
    const purge = longDate(row.purge_not_before);
    return {
        subject: `Cleffy will delete ${row.studio_name}'s district data on or after ${purge}`,
        text: [
            `Your Cleffy district contract for ${row.studio_name} ended on ${ended}.`,
            '',
            `On or after ${purge} we will delete the district's data:`,
            '- the district studio and its teacher seats;',
            "- the student accounts your district's teachers added for the district, with everything those students drew or wrote on scores and in lesson history, their assignments and their practice notes. Students a teacher added to their own private roster are not part of the district's data and are not deleted.",
            '',
            "Teachers' own Cleffy accounts and the scores they uploaded are theirs and are not deleted.",
            '',
            `If you need anything, export it before ${purge}: sign in to Cleffy and download it, or write to ${SUPPORT_ADDRESS} and we will help. If your contract has been renewed, or this is a mistake, write to ${SUPPORT_ADDRESS} before that date and nothing will be deleted.`,
            '',
            'Cleffy',
        ].join('\n'),
    };
};

/**
 * Claims up to NOTICE_BATCH unsent notices (no more than an hour's budget) and
 * sends each that the shared mail budget has room for. Every claimed notice is
 * finished or deferred: sent; failed with the reason (the next run retries
 * it); or, once the budget is spent, deferred with every notice after it,
 * attempts untouched. A reservation is handed back whenever no mail went out
 * (never when the send threw, which may have delivered it).
 */
export const deliverDistrictNotices = async (deps: DeliverDeps): Promise<DeliverResult | null> => {
    const batch = Math.max(0, Math.min(NOTICE_BATCH, deps.hourlyLimit));
    if (batch === 0) {
        return { claimed: 0, sent: 0, failed: 0, deferred: 0 };
    }
    const rows = await deps.claim(batch);
    if (rows === null) {
        return null;
    }
    const result: DeliverResult = { claimed: rows.length, sent: 0, failed: 0, deferred: 0 };
    let spent = false;
    for (const row of rows) {
        const reservation = spent
            ? null
            : await deps.reserve().catch((): MailReservation => ({ ok: false, retryAfterSec: 60 }));
        if (!reservation?.ok) {
            spent = true;
            await deps.defer(row.id);
            result.deferred += 1;
            continue;
        }
        let outcome: 'sent' | 'failed' | 'unconfigured' | 'unknown';
        try {
            outcome = await deps.send(row.to_email, buildDistrictNotice(row), noticeIdempotencyKey(row));
        } catch {
            // The request may have reached the provider before it failed: the
            // mail may be out, so its reservation stays spent. The retry
            // carries the same idempotency key, so it is not a second mail.
            outcome = 'unknown';
        }
        if (outcome === 'sent') {
            await deps.finish(row.id, null);
            result.sent += 1;
            continue;
        }
        if (outcome !== 'unknown') {
            // The provider answered no, or there is no provider: nothing went out.
            await reservation.release().catch(() => undefined);
        }
        await deps.finish(row.id, outcome === 'unconfigured' ? 'mail is not configured' : 'send failed');
        result.failed += 1;
    }
    return result;
};
