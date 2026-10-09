import type { Session } from '@supabase/supabase-js';

import { isRegisteredSession, userTypeOf } from '@/features/auth/session';
import { isUnlimited, readCachedEntitlements } from '@/features/billing/entitlementsService';
import { LimitReachedError, isBillingTier } from '@/features/billing/limitErrors';
import { getSupabase } from '@/lib/supabase';
import type { PdfExportClaim } from '@/types/database';

/**
 * The pdf_exports allowance, claimed BEFORE a PDF is handed over.
 *
 * claim_pdf_export() is the authority: it checks the plan and spends the unit in
 * one statement, so the answer it gives is the decision, not a hint. The export
 * itself runs on this device, so the only way to keep that decision is to hand
 * nothing over until the claim says yes -- and to treat every other outcome (a
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
 *
 * The menu builds the PDF FIRST and claims only once the file exists, so an
 * export that fails to build never spends anything. What can still go wrong
 * after a claim is answered -- the answer lost on the way back, the share sheet
 * dismissed -- is covered by the claim id: a claim carries one (see
 * claimIdFor), kept until an export is delivered, and the server answers a
 * repeat of it ok without counting again
 * (20261009120100_pdf_export_claim_ids.sql). So the next PDF export after any
 * of those -- the same one again, or the whole score instead of the page -- is
 * the unit already claimed, not a second one the free plan would refuse.
 */

export type ExportClaim = { ok: true } | { ok: false; limit: LimitReachedError } | { ok: false; message: string };

export const EXPORT_OFFLINE_MESSAGE =
    'Exporting a PDF needs an internet connection on your plan, so your monthly export can be counted. Reconnect and try again.';

// "Nothing was exported" is always true -- the file is handed over only after
// an ok answer. "Counted" is not something this device can always know (an
// answer can be lost after the server committed it), so the copy promises what
// the claim id does guarantee instead: a retry is not counted a second time.
export const EXPORT_CLAIM_FAILED_MESSAGE =
    'We couldn’t check your PDF export allowance, so nothing was exported. Please try again — it won’t be counted twice.';

export const EXPORT_GUEST_OFFLINE_MESSAGE =
    'Exporting a PDF of a shared score needs an internet connection, so it can be counted against the owner’s plan. Reconnect and try again.';

/** A guest cannot upgrade someone else's plan, so this names no plans and offers none. */
export const EXPORT_GUEST_LIMIT_MESSAGE =
    'The owner of this score has used this month’s PDF export on their plan. Ask them for a copy, or try again next month.';

export const EXPORT_GUEST_CLAIM_FAILED_MESSAGE =
    'We couldn’t check this score’s PDF export allowance, so nothing was exported. Please try again — it won’t be counted twice.';

/** The share sheet was dismissed: the claim is kept for the next PDF export (exportAttemptKey). */
export const EXPORT_NOT_SENT_MESSAGE = 'Not sent. Export again when you’re ready — it won’t be counted twice.';

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** supabase-js reports a failed fetch as an error value, not a throw. */
const looksLikeTransportFailure = (message: string | undefined): boolean =>
    /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message ?? '');

const ALLOWED: ExportClaim = { ok: true };

/**
 * How long this device keeps offering the same claim id for one export. Inside
 * the server's one-hour replay window, so a retry never names an id the server
 * has already retired (which it refuses rather than counts afresh).
 */
const CLAIM_ID_REUSE_MS = 50 * 60_000;

type PendingClaim = { id: string; mintedAt: number };

/**
 * Claim ids that were claimed but not yet delivered, by exportAttemptKey.
 * Mirrored to sessionStorage so a reload of the tab -- the obvious thing to try
 * after "check your connection" -- still retries under the same id. Best-effort:
 * a browser that refuses storage keeps them for the life of the page only.
 */
const PENDING_STORAGE_KEY = 'cleffy.pendingExportClaims';
let pendingClaims: Map<string, PendingClaim> | null = null;

const isPendingClaim = (value: unknown): value is PendingClaim =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as PendingClaim).id === 'string' &&
    typeof (value as PendingClaim).mintedAt === 'number';

const pending = (): Map<string, PendingClaim> => {
    if (pendingClaims) {
        return pendingClaims;
    }
    pendingClaims = new Map();
    try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(PENDING_STORAGE_KEY) ?? '[]');
        const now = Date.now();
        for (const entry of Array.isArray(stored) ? stored : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && isPendingClaim(entry[1])) {
                if (now - entry[1].mintedAt < CLAIM_ID_REUSE_MS) {
                    pendingClaims.set(entry[0], entry[1]);
                }
            }
        }
    } catch {
        // Unreadable or refused storage: start empty.
    }
    return pendingClaims;
};

const savePending = (): void => {
    try {
        sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([...pending()]));
    } catch {
        // Best-effort; the in-memory copy still covers this page.
    }
};

/**
 * What an undelivered claim is kept for: the account and, for a share-link
 * guest, the score -- exactly what the server matches a replay on (an
 * account's allowance is its own whatever score it names; a guest's is the
 * score owner's). Not which page, nor page or whole score: until a PDF is
 * delivered, the next PDF export asked for is the same one unit, so a share
 * sheet dismissed on page 3 does not cost the free plan's month when the
 * teacher then exports the whole score, or scrolls on and tries again.
 */
export const exportAttemptKey = (session: Session | null, documentId: string): string => {
    const who = session?.user.id ?? 'signed-out';
    return isRegisteredSession(session) ? who : `${who}:${documentId}`;
};

const claimIdFor = (attempt: string): string => {
    const now = Date.now();
    const held = pending().get(attempt);
    if (held && now - held.mintedAt < CLAIM_ID_REUSE_MS) {
        return held.id;
    }
    const id = crypto.randomUUID();
    pending().set(attempt, { id, mintedAt: now });
    savePending();
    return id;
};

const forgetClaimId = (attempt: string): void => {
    if (pending().delete(attempt)) {
        savePending();
    }
};

/**
 * The export reached the teacher (shared or downloaded), so its claim id is
 * spent: the next export is a new one and is counted.
 */
export const markExportDelivered = (attempt: string): void => {
    forgetClaimId(attempt);
};

/**
 * The server's answer settles what the id is worth. A refusal bought nothing
 * (the server forgot the id), and 22023 is an id the server will not take --
 * past its replay window, say -- so both start the next try from a fresh id.
 * Every other outcome keeps it: an ok export that is not yet delivered, and a
 * failure where the server may have counted before the answer was lost.
 */
const settleClaimId = (attempt: string | undefined, answer: ClaimAnswer | null): void => {
    if (attempt === undefined || answer === null) {
        return;
    }
    if (answer.error?.code === '22023' || (answer.error === null && answer.data?.ok === false)) {
        forgetClaimId(attempt);
    }
};

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
 *
 * With a claim id, a server from before 20261009120100 has no p_claim and
 * answers PGRST202 for the pair; it is then asked without the id, which is what
 * every claim was before -- correct, only without the retry protection.
 */
const requestClaim = async (documentId?: string, claimId?: string): Promise<ClaimAnswer> => {
    const supabase = getSupabase();
    const document = documentId === undefined ? {} : { p_document: documentId };
    if (claimId !== undefined) {
        const answer: ClaimAnswer = await supabase.rpc('claim_pdf_export', { ...document, p_claim: claimId });
        if (!isMissingFunction(answer.error)) {
            return answer;
        }
    }
    const answer: ClaimAnswer = await supabase.rpc('claim_pdf_export', document);
    if (!isMissingFunction(answer.error)) {
        return answer;
    }
    return supabase.rpc('consume_pdf_export', {});
};

/**
 * requestClaim, settling the attempt's claim id on whatever came back.
 *
 * A 22023 on an id is asked again at once under a fresh one. The old id is
 * spent, so the fresh claim is counted like any new export: reporting the 22023
 * with the claim-failed copy would promise a retry "won't be counted twice"
 * when it would be, and the fresh answer is a decision the teacher can act on
 * -- the export, or the plan notice. (The 50-minute reuse window keeps the
 * client inside the server's hour, so this needs a clock jump to happen.)
 */
const requestClaimFor = async (attempt: string | undefined, documentId?: string): Promise<ClaimAnswer> => {
    const ask = async (): Promise<ClaimAnswer> => {
        const answer = await requestClaim(documentId, attempt === undefined ? undefined : claimIdFor(attempt));
        settleClaimId(attempt, answer);
        return answer;
    };
    const answer = await ask();
    return attempt !== undefined && answer.error?.code === '22023' ? ask() : answer;
};

const isWellFormed = (data: PdfExportClaim | null): data is PdfExportClaim =>
    data !== null && typeof data === 'object' && typeof data.ok === 'boolean';

/**
 * A share-link guest's claim, billed to the score's owner. Fails closed exactly
 * like an account's, with no offline exception: the plan that decides is the
 * owner's, and nothing on this device can vouch for it.
 */
const claimAsGuest = async (documentId: string, attempt?: string): Promise<ExportClaim> => {
    const unreachable = (transport: boolean): ExportClaim => ({
        ok: false,
        message: transport || isOffline() ? EXPORT_GUEST_OFFLINE_MESSAGE : EXPORT_GUEST_CLAIM_FAILED_MESSAGE,
    });

    if (isOffline()) {
        return unreachable(true);
    }

    let answer: ClaimAnswer;
    try {
        answer = await requestClaimFor(attempt, documentId);
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
 *
 * `attempt` (exportAttemptKey) names what the claim is kept for, so the next
 * export after one that was not delivered is not counted twice; call
 * markExportDelivered once the file is out. Without it every ok answer
 * counts, as claims always did.
 */
export const claimPdfExport = async (
    session: Session | null,
    documentId: string | null,
    attempt?: string,
): Promise<ExportClaim> => {
    // Never gated, so never claimed: a provisioned student prints what their
    // teacher assigned (claim_pdf_export() exempts them server-side too), and a
    // signed-out device -- or a guest's -- exporting a score that lives only on
    // it has no account and no owner to draw from. Skipping the call keeps
    // their export working offline.
    if (session === null || userTypeOf(session) !== null) {
        return ALLOWED;
    }
    if (!isRegisteredSession(session)) {
        return documentId === null ? ALLOWED : claimAsGuest(documentId, attempt);
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
        answer = await requestClaimFor(attempt);
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
