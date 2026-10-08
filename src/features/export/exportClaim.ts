import type { Session } from '@supabase/supabase-js';

import { isRegisteredSession, userTypeOf } from '@/features/auth/session';
import { isUnlimited, readCachedEntitlements } from '@/features/billing/entitlementsService';
import { LimitReachedError, isBillingTier } from '@/features/billing/limitErrors';
import { getSupabase } from '@/lib/supabase';
import type { PdfExportClaim } from '@/types/database';

/**
 * The pdf_exports allowance, claimed BEFORE a PDF is built.
 *
 * claim_pdf_export() is the authority: it checks the plan and spends the unit in
 * one statement, so the answer it gives is the decision, not a hint. The export
 * itself runs on this device, so the only way to keep that decision is to build
 * nothing until the claim says yes -- and to treat every other outcome (a
 * refusal, an error, a malformed answer, no network) as no. Failing open here
 * would make "1 PDF export a month" mean "unlimited whenever the meter is
 * unreachable", which is a promise to the paying plans we cannot keep.
 *
 * The one exception is an UNLIMITED plan. Its claim never counts anything, so a
 * failed claim protects nothing, and a teacher who pays for unlimited export
 * should be able to print the lesson they are standing in front of with no
 * signal. The plan comes from the cached entitlements (downgradeExpired already
 * drops a lapsed period to free), and only an explicit refusal from the server
 * overrides it.
 *
 * Only the two PDF flows claim: the pricing limits "PDF export", and sharing a
 * page as a photo is a PNG it never mentions.
 */

export type ExportClaim = { ok: true } | { ok: false; limit: LimitReachedError } | { ok: false; message: string };

export const EXPORT_OFFLINE_MESSAGE =
    'Exporting a PDF needs an internet connection on your plan, so your monthly export can be counted. Reconnect and try again.';

export const EXPORT_CLAIM_FAILED_MESSAGE =
    'We couldn’t check your PDF export allowance, so nothing was exported or counted. Please try again.';

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** supabase-js reports a failed fetch as an error value, not a throw. */
const looksLikeTransportFailure = (message: string | undefined): boolean =>
    /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message ?? '');

const ALLOWED: ExportClaim = { ok: true };

type ClaimAnswer = { data: PdfExportClaim | null; error: { message: string; code?: string } | null };

/**
 * PostgREST's "no such function" (PGRST202, from its schema cache) or
 * Postgres's own (42883). Only possible while this bundle is live ahead of the
 * migration that adds claim_pdf_export -- a deploy-order slip that would
 * otherwise block every metered export.
 */
const isMissingFunction = (error: { message: string; code?: string } | null): boolean =>
    error !== null && (error.code === 'PGRST202' || error.code === '42883');

/**
 * claim_pdf_export, falling back to consume_pdf_export when the server does not
 * have the new name yet. The fallback is not a weaker check: consume_pdf_export
 * has always counted and refused in the same single statement, so on an older
 * database it is the same decision under the old name. It only lacks `tier`,
 * which the refusal below then words as free -- the only tier it can refuse.
 */
const requestClaim = async (): Promise<ClaimAnswer> => {
    const supabase = getSupabase();
    const answer: ClaimAnswer = await supabase.rpc('claim_pdf_export', {});
    if (!isMissingFunction(answer.error)) {
        return answer;
    }
    return supabase.rpc('consume_pdf_export', {});
};

export const claimPdfExport = async (session: Session | null): Promise<ExportClaim> => {
    // Never gated, so never claimed. A share-link guest is someone else's
    // visitor with no plan of their own to draw down, a provisioned student
    // prints what their teacher assigned, and a signed-out device exporting a
    // local score has no account at all. claim_pdf_export() exempts the first
    // two server-side too; skipping the call spares them the round trip and
    // keeps their export working offline.
    if (!isRegisteredSession(session) || userTypeOf(session) !== null) {
        return ALLOWED;
    }

    const cached = await readCachedEntitlements(session.user.id).catch(() => null);
    const unlimited = cached !== null && isUnlimited(cached.limits.pdf_exports);
    const unreachable = (transport: boolean): ExportClaim => {
        if (unlimited) {
            return ALLOWED;
        }
        return { ok: false, message: transport || isOffline() ? EXPORT_OFFLINE_MESSAGE : EXPORT_CLAIM_FAILED_MESSAGE };
    };

    if (isOffline()) {
        return unreachable(true);
    }

    let answer: ClaimAnswer;
    try {
        answer = await requestClaim();
    } catch (err) {
        return unreachable(err instanceof TypeError || looksLikeTransportFailure((err as Error | null)?.message));
    }

    const { data, error } = answer;
    if (error || !data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
        return unreachable(looksLikeTransportFailure(error?.message));
    }
    if (data.ok) {
        return ALLOWED;
    }
    return {
        ok: false,
        limit: new LimitReachedError({
            code: 'limit_reached',
            metric: 'pdf_exports',
            limit: typeof data.limit === 'number' ? data.limit : null,
            tier: isBillingTier(data.tier) ? data.tier : 'free',
        }),
    };
};
