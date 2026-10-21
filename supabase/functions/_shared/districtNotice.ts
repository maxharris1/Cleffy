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
 */

export interface DistrictNoticeRow {
    id: number;
    to_email: string;
    studio_name: string;
    contract_ends_at: string;
    purge_not_before: string;
}

export interface DistrictNoticeMessage {
    subject: string;
    text: string;
}

export interface DeliverDeps {
    claim: (limit: number) => Promise<DistrictNoticeRow[] | null>;
    send: (to: string, message: DistrictNoticeMessage) => Promise<'sent' | 'failed' | 'unconfigured'>;
    finish: (id: number, error: string | null) => Promise<boolean>;
}

export interface DeliverResult {
    claimed: number;
    sent: number;
    failed: number;
}

/** At most this many notices per call; one district gets one notice per contract end. */
export const NOTICE_BATCH = 20;

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
            "- the student accounts your district's teachers created, with everything those students drew or wrote on scores and in lesson history, their assignments and their practice notes.",
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
 * Claims up to NOTICE_BATCH unsent notices and sends each. Every claimed
 * notice is finished either way: sent, or failed with the reason (so the next
 * run retries it). Without a mail key nothing is sent and nothing is marked.
 */
export const deliverDistrictNotices = async (deps: DeliverDeps): Promise<DeliverResult | null> => {
    const rows = await deps.claim(NOTICE_BATCH);
    if (rows === null) {
        return null;
    }
    const result: DeliverResult = { claimed: rows.length, sent: 0, failed: 0 };
    for (const row of rows) {
        let outcome: 'sent' | 'failed' | 'unconfigured';
        try {
            outcome = await deps.send(row.to_email, buildDistrictNotice(row));
        } catch {
            outcome = 'failed';
        }
        if (outcome === 'sent') {
            await deps.finish(row.id, null);
            result.sent += 1;
        } else {
            await deps.finish(row.id, outcome === 'unconfigured' ? 'mail is not configured' : 'send failed');
            result.failed += 1;
        }
    }
    return result;
};
