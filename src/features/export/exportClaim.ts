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
 * A share-link guest (an anonymous session) has no plan of their own, so their
 * export is drawn from the allowance of the score's OWNER -- the server resolves
 * the owner from the score id, which is why a guest's claim names it. Exempting
 * guests instead would let any free owner multiply their one export a month by
 * opening their own share link in a private window. The guest cannot know the
 * owner's plan offline, so a guest's export always needs a connection.
 *
 * Only the two PDF flows claim: the pricing limits "PDF export", and sharing a
 * page as a photo is a PNG it never mentions.
 */

export type ExportClaim = { ok: true } | { ok: false; limit: LimitReachedError } | { ok: false; message: string };

export const EXPORT_OFFLINE_MESSAGE =
    'Exporting a PDF needs an internet connection on your plan, so your monthly export can be counted. Reconnect and try again.';

export const EXPORT_CLAIM_FAILED_MESSAGE =
    'We couldn’t check your PDF export allowance, so nothing was exported or counted. Please try again.';

export const EXPORT_GUEST_OFFLINE_MESSAGE =
    'Exporting a PDF of a shared score needs an internet connection, so it can be counted against the owner’s plan. Reconnect and try again.';

/** A guest cannot upgrade someone else's plan, so this names no plans and offers none. */
export const EXPORT_GUEST_LIMIT_MESSAGE =
    'The owner of this score has used this month’s PDF export on their plan. Ask them for a copy, or try again next month.';

export const EXPORT_GUEST_CLAIM_FAILED_MESSAGE =
    'We couldn’t check this score’s PDF export allowance, so nothing was exported or counted. Please try again.';

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
const requestClaim = async (documentId?: string): Promise<ClaimAnswer> => {
    const supabase = getSupabase();
    const answer: ClaimAnswer = await supabase.rpc(
        'claim_pdf_export',
        documentId === undefined ? {} : { p_document: documentId },
    );
    if (!isMissingFunction(answer.error)) {
        return answer;
    }
    return supabase.rpc('consume_pdf_export', {});
};

const isWellFormed = (data: PdfExportClaim | null): data is PdfExportClaim =>
    data !== null && typeof data === 'object' && typeof data.ok === 'boolean';

/**
 * A share-link guest's claim, billed to the score's owner. Fails closed exactly
 * like an account's, with no offline exception: the plan that decides is the
 * owner's, and nothing on this device can vouch for it.
 */
const claimAsGuest = async (documentId: string): Promise<ExportClaim> => {
    const unreachable = (transport: boolean): ExportClaim => ({
        ok: false,
        message: transport || isOffline() ? EXPORT_GUEST_OFFLINE_MESSAGE : EXPORT_GUEST_CLAIM_FAILED_MESSAGE,
    });

    if (isOffline()) {
        return unreachable(true);
    }

    let answer: ClaimAnswer;
    try {
        answer = await requestClaim(documentId);
    } catch (err) {
        return unreachable(err instanceof TypeError || looksLikeTransportFailure((err as Error | null)?.message));
    }

    const { data, error } = answer;
    if (error || !isWellFormed(data)) {
        return unreachable(looksLikeTransportFailure(error?.message));
    }
    return data.ok ? ALLOWED : { ok: false, message: EXPORT_GUEST_LIMIT_MESSAGE };
};

/**
 * `documentId` is the cloud score being exported, or null for a score that only
 * lives on this device. It only matters for a guest; an account's export is
 * always drawn from its own allowance.
 */
export const claimPdfExport = async (session: Session | null, documentId: string | null): Promise<ExportClaim> => {
    // Never gated, so never claimed: a provisioned student prints what their
    // teacher assigned (claim_pdf_export() exempts them server-side too), and a
    // signed-out device -- or a guest's -- exporting a score that lives only on
    // it has no account and no owner to draw from. Skipping the call keeps
    // their export working offline.
    if (session === null || userTypeOf(session) !== null) {
        return ALLOWED;
    }
    if (!isRegisteredSession(session)) {
        return documentId === null ? ALLOWED : claimAsGuest(documentId);
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
    if (error || !isWellFormed(data)) {
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
