import { handleContentReport, type ContentReportInput } from '../_shared/contentReports.ts';
import { common, logNotice, optionalUserId, resolveDocument, sendEmail } from '../_shared/contentReportsWiring.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { serviceClient } from '../_shared/rateLimit.ts';
import { verifyTurnstileRequest } from '../_shared/turnstileVerify.ts';

/**
 * A report about a score: illegal content or copyright infringement (the form
 * at /report). Deployed with `verify_jwt = false` (supabase/config.toml): a
 * rights holder need not have an account. The control flow, limits and the
 * acknowledgment are in _shared/contentReports.ts; this file is only what it
 * runs against.
 */

const env = (name: string): string | undefined => Deno.env.get(name);

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** The per-reporter rate-limit key: an HMAC of the mailbox, so edge_rate_buckets never holds an address. */
const reporterKey = async (email: string): Promise<string | null> => {
    const secret = env('CONTENT_REPORT_SECRET') || env('SUPABASE_SERVICE_ROLE_KEY');
    if (!secret) {
        return null;
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`content-reporter\u0000${email}`)));
    return `content-report:to:${toHex(mac).slice(0, 40)}`;
};

Deno.serve((req) =>
    handleContentReport(req, {
        ...common,
        verifyCaptcha: verifyTurnstileRequest,
        mailBudget: {
            hour: mailLimit('contentReportAck', 'hour', env),
            day: mailLimit('contentReportAck', 'day', env),
        },
        sendEmail,
        logNotice,
        optionalUserId,
        reporterKey,
        resolveDocument,
        saveReport: async (
            report: ContentReportInput & { documentId: string | null; reporterUserId: string | null },
        ) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin
                .from('content_reports')
                .insert({
                    kind: report.kind,
                    category: report.category,
                    content_url: report.contentUrl,
                    document_id: report.documentId,
                    work_description: report.workDescription,
                    explanation: report.explanation,
                    reporter_name: report.reporterName,
                    reporter_email: report.reporterEmail,
                    reporter_address: report.reporterAddress,
                    reporter_phone: report.reporterPhone,
                    on_behalf_of: report.onBehalfOf,
                    reporter_user_id: report.reporterUserId,
                    good_faith: report.goodFaith,
                    perjury_statement: report.perjuryStatement,
                    signature: report.signature,
                })
                .select('id, reference')
                .single();
            if (error || !data) {
                common.logError(`content-report: could not store the report: ${error?.message ?? 'no row'}`);
                return null;
            }
            return data as { id: string; reference: string };
        },
        markAcknowledged: async (reportId: string) => {
            const admin = serviceClient();
            if (!admin) {
                return;
            }
            const { error } = await admin
                .from('content_reports')
                .update({ acknowledged_at: new Date().toISOString() })
                .eq('id', reportId);
            if (error) {
                common.logError(`content-report: could not mark ${reportId} acknowledged: ${error.message}`);
            }
        },
    }),
);
