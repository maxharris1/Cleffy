import { requireUser } from '../_shared/auth.ts';
import { handleContentModeration, type ActionRefusal, type TakedownResult } from '../_shared/contentReports.ts';
import { common, refusalCode, resolveDocument, sendEmail } from '../_shared/contentReportsWiring.ts';
import { serviceClient } from '../_shared/rateLimit.ts';

/**
 * A moderator restricts or removes a score, lifts a takedown, or rejects a
 * report (the page at /admin/reports). JWT required; the caller must be in
 * content_moderators. The decisions are the SQL functions in
 * 20261020150000_content_moderation.sql, called under the service role; the
 * flow and the emails are in _shared/contentReports.ts.
 */

const KNOWN: ActionRefusal[] = [
    'document_not_found',
    'already_taken_down',
    'report_not_found',
    'takedown_not_found',
    'report_not_open',
];

/** Call one of the actions: its jsonb answer, the refusal it raised, or null for anything else. */
const callAction = async (
    fn: string,
    args: Record<string, unknown>,
): Promise<Record<string, unknown> | ActionRefusal | null> => {
    const admin = serviceClient();
    if (!admin) {
        return null;
    }
    const { data, error } = await admin.rpc(fn, args);
    if (error) {
        const code = refusalCode(error);
        if (code && (KNOWN as string[]).includes(code)) {
            return code as ActionRefusal;
        }
        common.logError(`${fn} failed: ${error.message}`);
        return null;
    }
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

Deno.serve((req) =>
    handleContentModeration(req, {
        ...common,
        sendEmail,
        resolveDocument,
        authenticate: async (request) => {
            const auth = await requireUser(request);
            return auth.ok ? auth.caller.userId : auth.response;
        },
        isModerator: async (userId) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin
                .from('content_moderators')
                .select('user_id')
                .eq('user_id', userId)
                .maybeSingle();
            if (error) {
                common.logError(`content_moderators lookup failed: ${error.message}`);
                return null;
            }
            return data !== null;
        },
        applyTakedown: async (input): Promise<TakedownResult | ActionRefusal | null> => {
            const result = await callAction('apply_content_takedown', {
                p_document: input.documentId,
                p_action: input.action,
                p_ground: input.ground,
                p_legal_basis: input.legalBasis,
                p_facts: input.facts,
                p_report: input.reportId,
                p_moderator: input.moderatorId,
            });
            if (result === null || typeof result === 'string') {
                return result;
            }
            const takedownId = text(result['takedown_id']);
            if (!takedownId) {
                return null;
            }
            return {
                takedownId,
                uploaderId: text(result['uploader_id']),
                documentTitle: text(result['document_title']),
                activeStrikes: typeof result['active_strikes'] === 'number' ? result['active_strikes'] : null,
                uploaderNoticeId: text(result['uploader_notice_id']),
                reporterNoticeId: text(result['reporter_notice_id']),
            };
        },
        liftTakedown: async (input) => {
            const result = await callAction('lift_content_takedown', {
                p_takedown: input.takedownId,
                p_reason: input.reason,
                p_moderator: input.moderatorId,
            });
            if (result === null || typeof result === 'string') {
                return result;
            }
            return { uploaderNoticeId: text(result['uploader_notice_id']) };
        },
        rejectReport: async (input) => {
            const result = await callAction('reject_content_report', {
                p_report: input.reportId,
                p_note: input.note,
                p_moderator: input.moderatorId,
            });
            if (result === null || typeof result === 'string') {
                return result;
            }
            return { reporterNoticeId: text(result['reporter_notice_id']) };
        },
    }),
);
