import { requireUser, rejectStudent } from './auth.ts';
import { jsonResponse, optionsResponse } from './cors.ts';
import { METRIC_BY_FUNCTION, type UsageMetric } from './entitlements.ts';
import { checkRateLimit, clientKey, serviceClient } from './imslp.ts';
import { enforce } from './quota.ts';

/**
 * Shared body for the three metered analysis endpoints.
 *
 * SCAFFOLD. The analysis features themselves (play-along OMR, fingering vision
 * reads) do not exist in this repo yet, so these endpoints run the complete
 * gate — auth, document access, entitlement lookup, atomic quota consume — and
 * then return 501 instead of doing the work. That makes the enforcement path,
 * and the client's limit-reached UI, real and testable today.
 *
 * Two callers are refused outright, before any budget is touched: an anonymous
 * share-link guest, and a provisioned student. Teacher-pays means neither is
 * ever billed, so neither may spend an analysis budget — and a student needs a
 * check of their own, being a registered user rather than an anonymous one.
 *
 * When the real analysis lands, replace `notImplemented` with the work and wrap
 * it so any failure calls `refund(admin, userId, metric)` — guarded on
 * `gate.consumed`, since an unlimited metric short-circuits before the counter
 * and has nothing to give back (see imslp-download). Until then the consume is
 * deliberately NOT refunded: refunding would mean the counter never advances and
 * the limit could never actually be reached.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metricForFunction = (name: string): UsageMetric => {
    const metric = METRIC_BY_FUNCTION[name];
    if (!metric) {
        throw new Error(`no usage metric registered for function "${name}"`);
    }
    return metric;
};

export const serveMeteredAnalysis = (functionName: string): void => {
    const metric = metricForFunction(functionName);

    Deno.serve(async (req) => {
        if (req.method === 'OPTIONS') {
            return optionsResponse();
        }
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
        }

        const rate = await checkRateLimit(`${functionName}:${clientKey(req)}`, 20, 60_000);
        if (!rate.ok) {
            return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
        }

        const auth = await requireUser(req);
        if (!auth.ok) {
            return auth.response;
        }
        // Teacher-pays: an anonymous session is a share-link student. They are
        // never billed, so they also cannot spend anyone's analysis budget.
        if (auth.caller.isAnonymous) {
            return jsonResponse(
                { error: 'Sign in with a teacher account to run analysis', code: 'anonymous_session' },
                403,
            );
        }
        // A provisioned student is a real, non-anonymous user, so the check above
        // lets them through. Their metered limits are all zero, so without this
        // they would draw on a budget they were never given and be told 402
        // "limit reached" — when the truth is that analysis is the teacher's to run.
        const student = rejectStudent(auth.caller);
        if (student) {
            return student;
        }

        let body: { documentId?: string };
        try {
            body = await req.json();
        } catch {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }

        const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
        if (!documentId || !UUID_RE.test(documentId)) {
            return jsonResponse({ error: 'documentId must be a UUID' }, 400);
        }

        // Access check runs under the caller's own JWT, so RLS decides.
        const { data: role, error: roleError } = await auth.caller.userClient.rpc('document_role', {
            doc: documentId,
        });
        if (roleError || !role) {
            return jsonResponse({ error: 'Document not found or not accessible' }, 403);
        }

        const admin = serviceClient();
        if (!admin) {
            return jsonResponse({ error: 'Server misconfigured' }, 500);
        }

        // Gate BEFORE any expensive work — never after.
        const gate = await enforce(admin, auth.caller.userId, metric);
        if (!gate.ok) {
            return jsonResponse(gate.body, gate.status);
        }

        return jsonResponse(
            {
                code: 'not_implemented',
                message: `${functionName} is not implemented yet.`,
                metric,
                tier: gate.entitlements.tier,
            },
            501,
        );
    });
};
