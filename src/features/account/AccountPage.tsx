import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';

import {
    ACCOUNT_BODY,
    ACCOUNT_NOTE,
    ACCOUNT_SUB_HEADING,
    ACCOUNT_SUBSECTION,
    AccountSection,
} from '@/features/account/AccountSection';
import { DeleteAccountSection } from '@/features/account/DeleteAccountSection';
import { initialsOf } from '@/features/account/initials';
import { mapAuthError } from '@/features/auth/authErrors';
import type { OfflineStorageUsage } from '@/features/account/offlineStorage';
import { clearOfflineStorage, formatMegabytes, readOfflineStorage } from '@/features/account/offlineStorage';
import { useGuardedSignOut } from '@/features/auth/useGuardedSignOut';
import { HomeScreenPreferences } from '@/features/install/HomeScreenPreferences';
import {
    displayNameOf,
    signOut,
    storedDisplayNameOf,
    updateDisplayName,
    updatePassword,
    useSession,
} from '@/features/auth/session';
import { NoBillingAccountError, createPortalSession, redirectTo } from '@/features/billing/billingApi';
import { PricingDialog } from '@/features/billing/PricingDialog';
import { StudioSeats } from '@/features/billing/StudioSeats';
import { clearCachedEntitlements, loadUsage } from '@/features/billing/entitlementsService';
import { formatPlanDate, ownSubscriptionOf, planPeriodOf } from '@/features/billing/planStatus';
import { PLAN_LABELS, TIER_LABELS } from '@/features/billing/pricing';
import { useEntitlements } from '@/features/billing/useEntitlements';
import { CancelSubscriptionLink } from '@/features/billing/CancelSubscriptionLink';
import { LegalLinks } from '@/features/legal/LegalLinks';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { ScoreLayoutPreferences } from '@/features/viewer/ScoreLayoutPreferences';
import { features } from '@/lib/features';
import type { UsageMetric } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { PageHead } from '@/ui/PageHead';
import { ProgressBar } from '@/ui/ProgressBar';
import { SwapLabel } from '@/ui/SwapLabel';
import { TextField } from '@/ui/TextField';

import {
    PASSWORD_HINT,
    passwordProblem,
    passwordProblemMessage,
} from '../../../supabase/functions/_shared/passwordPolicy';

/**
 * Meters for the features this build ships, named for what actually spends
 * them: an IMSLP import draws on `smart_imports`, and the AI pass of Import
 * marks on `vision_reads` (fingering note reads too, where that ships). Play-
 * along analyses are still metered server-side, but a release with play-along
 * switched off (src/lib/features.ts) must not show an allowance for something
 * the reader cannot use.
 */
const meteredRows = (): Array<{ metric: UsageMetric; label: string }> => [
    ...(features.playalong ? [{ metric: 'omr_runs' as const, label: 'Play-along analyses' }] : []),
    { metric: 'vision_reads', label: 'AI page reads' },
    { metric: 'smart_imports', label: 'Imports from Find a score' },
    { metric: 'pdf_exports', label: 'PDF exports' },
];

const CONFIRMATION = 'text-sm text-emerald-700';
const USAGE_ROW = 'border-t border-hairline py-3 text-[15px] text-ink';

/** Stocks (cloud scores, student seats) are ceilings, not monthly spend. */
const describeStock = (limit: number): string => {
    if (limit < 0) {
        return 'unlimited';
    }
    if (limit === 0) {
        return 'not included';
    }
    return `up to ${limit}`;
};

/**
 * Fill for one usage meter. A limit of zero is not a divide-by-zero to dodge but
 * a plan that includes none of this tool: the bar reads full, because none of it
 * is available. Unlimited never reaches here — it gets no bar at all.
 */
const meterPercent = (used: number, limit: number): number => {
    if (limit <= 0) {
        return 100;
    }
    return Math.min(100, (used / limit) * 100);
};

/** Month/day/year, matching how the library dates a score. */
const formatJoined = (iso: string | undefined): string | null => {
    if (!iso) {
        return null;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * A confirmation that clears itself. "Saved" is only true for a moment; left on
 * screen it starts describing whatever the user did next.
 */
const useTransientFlag = (): [boolean, (shown: boolean) => void] => {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (!shown) {
            return;
        }
        const timer = window.setTimeout(() => setShown(false), 4000);
        return () => window.clearTimeout(timer);
    }, [shown]);
    return [shown, setShown];
};

/**
 * Everything about this account in ruled sections: who you are, what you pay,
 * what you have used, what this device is holding, and the way out. Centred at
 * the README's 1180 px Account width, so the head and the body share one edge.
 */
export const AccountPage = () => {
    const { userId } = useOutletContext<LibraryOutletContext>();
    const { session } = useSession();
    const { entitlements, loading, refresh } = useEntitlements(userId);
    const [usage, setUsage] = useState<Partial<Record<UsageMetric, number>>>({});
    const [pricingOpen, setPricingOpen] = useState(false);
    const [portalBusy, setPortalBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [params] = useSearchParams();
    const checkout = params.get('checkout');

    // null means "untouched", so the field follows the session until the user
    // types — no effect racing the async session load to seed the input.
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const [nameBusy, setNameBusy] = useState(false);
    const [nameError, setNameError] = useState<string | null>(null);
    const [nameSaved, setNameSaved] = useTransientFlag();

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordBusy, setPasswordBusy] = useState(false);
    const [passwordError, setPasswordError] = useState<string | null>(null);
    const [passwordSaved, setPasswordSaved] = useTransientFlag();

    const [storage, setStorage] = useState<OfflineStorageUsage | null>(null);
    const [storageError, setStorageError] = useState<string | null>(null);
    const [clearOpen, setClearOpen] = useState(false);
    const [clearBusy, setClearBusy] = useState(false);
    const [clearedFlag, setClearedFlag] = useTransientFlag();

    const [signingOut, setSigningOut] = useState(false);
    const [signOutError, setSignOutError] = useState<string | null>(null);

    useEffect(() => {
        void loadUsage()
            .then(setUsage)
            .catch(() => undefined);
    }, [entitlements]);

    useEffect(() => {
        if (checkout !== 'success') {
            return;
        }
        // Stripe redirects back before the webhook has necessarily landed, so
        // re-read entitlements shortly after arriving rather than trusting the
        // redirect itself as proof of payment.
        const timer = window.setTimeout(() => void refresh(), 1500);
        void refresh();
        return () => window.clearTimeout(timer);
    }, [checkout, refresh]);

    useEffect(() => {
        let mounted = true;
        void readOfflineStorage()
            .then((next) => {
                if (mounted) {
                    setStorage(next);
                }
            })
            .catch(() => {
                if (mounted) {
                    setStorageError('Could not read this device’s offline storage.');
                }
            });
        return () => {
            mounted = false;
        };
    }, []);

    const openPortal = async () => {
        setError(null);
        setPortalBusy(true);
        try {
            redirectTo(await createPortalSession());
        } catch (err) {
            setError(
                err instanceof NoBillingAccountError
                    ? err.message
                    : err instanceof Error
                      ? err.message
                      : 'Could not open the billing portal.',
            );
            setPortalBusy(false);
        }
    };

    const storedName = storedDisplayNameOf(session);
    const nameValue = nameDraft ?? storedName;
    const trimmedName = nameValue.trim();
    const nameDirty = trimmedName.length > 0 && trimmedName !== storedName;

    const saveName = async (event: FormEvent) => {
        event.preventDefault();
        if (!nameDirty || nameBusy) {
            return;
        }
        setNameError(null);
        setNameSaved(false);
        setNameBusy(true);
        try {
            await updateDisplayName(trimmedName);
            // Back to following the session: USER_UPDATED has landed by now, so
            // the field re-seeds from the value the server actually stored.
            setNameDraft(null);
            setNameSaved(true);
        } catch (err) {
            setNameError(err instanceof Error ? err.message : 'Could not save your name.');
        } finally {
            setNameBusy(false);
        }
    };

    const changePassword = async (event: FormEvent) => {
        event.preventDefault();
        if (passwordBusy) {
            return;
        }
        setPasswordSaved(false);
        if (password.length === 0) {
            setPasswordError('Enter a new password.');
            return;
        }
        // The same policy GoTrue enforces (passwordPolicy.ts), checked first so
        // the refusal names the rule instead of arriving as a server error.
        const problem = passwordProblem(password);
        if (problem) {
            setPasswordError(passwordProblemMessage(problem));
            return;
        }
        if (password !== confirmPassword) {
            setPasswordError('Those two passwords do not match.');
            return;
        }
        setPasswordError(null);
        setPasswordBusy(true);
        try {
            await updatePassword(password);
            setPassword('');
            setConfirmPassword('');
            setPasswordSaved(true);
        } catch (err) {
            setPasswordError(mapAuthError(err, 'Could not change your password.'));
        } finally {
            setPasswordBusy(false);
        }
    };

    const removeDownloads = async () => {
        setStorageError(null);
        setClearBusy(true);
        try {
            await clearOfflineStorage();
            setStorage(await readOfflineStorage());
            setClearedFlag(true);
            setClearOpen(false);
        } catch (err) {
            setStorageError(err instanceof Error ? err.message : 'Could not remove the downloaded scores.');
            setClearOpen(false);
        } finally {
            setClearBusy(false);
        }
    };

    /** Drop the cached plan too — a shared device must not leak this tier. */
    const handleSignOut = async () => {
        setSignOutError(null);
        setSigningOut(true);
        try {
            await clearCachedEntitlements(userId).catch(() => undefined);
            await signOut();
        } catch (err) {
            // The gate redirects on success, so reaching here means we are still
            // signed in — say so rather than leaving a dead "Signing out…".
            setSignOutError(err instanceof Error ? err.message : 'Could not sign out.');
            setSigningOut(false);
        }
    };
    // Uploads (or asks about) unsynced marks first — sign-out clears them.
    const guardedSignOut = useGuardedSignOut(handleSignOut);

    if (!session || (loading && !entitlements)) {
        return <LoadingText className="mt-10">Loading your account…</LoadingText>;
    }

    const tier = entitlements?.tier ?? 'free';
    // A cancelled plan's period end is its last day, not a renewal: saying
    // "Renews" to someone who cancelled tells them they will be charged again.
    const period = planPeriodOf(entitlements);
    const subscription = ownSubscriptionOf(entitlements);
    const resumable = subscription?.cancelling === true;
    const label = displayNameOf(session);
    const email = session.user.email ?? '';
    const joined = formatJoined(session.user.created_at);
    const nothingCached = storage !== null && storage.scoreCount === 0 && storage.bytes === 0;

    return (
        <div className="mx-auto w-full max-w-[1100px] sm:px-4 lg:px-0">
            <PageHead
                width="narrow"
                eyebrow={`${label} · ${PLAN_LABELS[tier]} plan`}
                title="Account"
                subtitle="Your profile, plan, and what this device is holding."
                action={
                    <div className="flex max-w-[320px] flex-col items-start gap-2 sm:items-end">
                        <Button
                            variant="secondary"
                            disabled={signingOut || guardedSignOut.checking}
                            onClick={() => void guardedSignOut.requestSignOut()}
                        >
                            {guardedSignOut.checking ? 'Saving changes…' : signingOut ? 'Signing out…' : 'Sign out'}
                        </Button>
                        <p className={`${ACCOUNT_NOTE} sm:text-right`}>
                            Signing out removes your cached plan, downloaded scores and the offline copy of your marks
                            from this device. Everything stays in your account; changes not yet saved to it are uploaded
                            first.
                        </p>
                    </div>
                }
            />
            {signOutError ? <ErrorText className="-mt-4 mb-4">{signOutError}</ErrorText> : null}
            {guardedSignOut.dialog}
            <div>
                {checkout === 'success' ? (
                    <p
                        role="status"
                        className="mb-4 rounded-xl border border-emerald-300/70 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900"
                    >
                        Thanks — your subscription is active. It can take a moment to appear here.
                    </p>
                ) : null}
                {checkout === 'cancelled' ? (
                    <p role="status" className="mb-4 text-sm text-ink-muted">
                        Checkout cancelled — nothing was charged.
                    </p>
                ) : null}

                <AccountSection title="Profile">
                    <div className="flex items-center gap-4">
                        <span
                            aria-hidden="true"
                            className="grid size-[60px] shrink-0 place-items-center rounded-full bg-[#dc2626] text-[21px] font-semibold text-white shadow-[0_0_0_2px_var(--color-paper)]"
                        >
                            {initialsOf(label)}
                        </span>
                        <div className="min-w-0">
                            <p className="display-opsz font-display text-2xl font-semibold [overflow-wrap:anywhere] text-ink">
                                {label}
                            </p>
                            {email && email !== label ? (
                                <p className="mt-1 text-sm [overflow-wrap:anywhere] text-ink-muted">
                                    {email}
                                    {joined ? ` · Member since ${joined}` : null}
                                </p>
                            ) : joined ? (
                                <p className="mt-1 text-sm text-ink-muted">Member since {joined}</p>
                            ) : null}
                        </div>
                    </div>
                    <p className={`${ACCOUNT_NOTE} mt-3`}>
                        Your sign-in address can’t be changed here — write to us and we’ll move it for you.
                    </p>

                    <form className="mt-5" onSubmit={(event) => void saveName(event)}>
                        <div className="flex flex-wrap items-end gap-3">
                            <div className="max-w-[360px] min-w-0 flex-[1_1_260px]">
                                <TextField
                                    id="account-display-name"
                                    label="Display name"
                                    value={nameValue}
                                    autoComplete="name"
                                    maxLength={80}
                                    placeholder={email.split('@')[0] || 'Your name'}
                                    onChange={(event) => setNameDraft(event.target.value)}
                                />
                            </div>
                            <Button
                                type="submit"
                                variant="secondary"
                                className="min-h-12"
                                disabled={!nameDirty || nameBusy}
                            >
                                <SwapLabel
                                    labels={{ idle: 'Save name', busy: 'Saving…' }}
                                    active={nameBusy ? 'busy' : 'idle'}
                                />
                            </Button>
                        </div>
                        <p className={`${ACCOUNT_NOTE} mt-2`}>
                            Shown on shared scores and in a student’s session, in place of your email address.
                        </p>
                        {nameSaved ? (
                            <p role="status" className={`${CONFIRMATION} mt-2`}>
                                Name saved.
                            </p>
                        ) : null}
                        {nameError ? <ErrorText className="mt-2">{nameError}</ErrorText> : null}
                    </form>

                    <form
                        className="mt-[26px] border-t border-hairline pt-[22px]"
                        onSubmit={(event) => void changePassword(event)}
                    >
                        <h3 className={ACCOUNT_SUB_HEADING}>Change password</h3>
                        <p className={`${ACCOUNT_NOTE} mt-1`}>{PASSWORD_HINT} You stay signed in on this device.</p>
                        <div className="mt-3.5 flex flex-wrap items-end gap-3">
                            <div className="min-w-0 flex-[1_1_200px]">
                                <TextField
                                    id="account-new-password"
                                    label="New password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </div>
                            <div className="min-w-0 flex-[1_1_200px]">
                                <TextField
                                    id="account-confirm-password"
                                    label="Confirm new password"
                                    type="password"
                                    autoComplete="new-password"
                                    value={confirmPassword}
                                    onChange={(event) => setConfirmPassword(event.target.value)}
                                />
                            </div>
                            <Button type="submit" variant="secondary" className="min-h-12" disabled={passwordBusy}>
                                <SwapLabel
                                    labels={{ idle: 'Change password', busy: 'Changing…' }}
                                    active={passwordBusy ? 'busy' : 'idle'}
                                />
                            </Button>
                        </div>
                        {passwordSaved ? (
                            <p role="status" className={`${CONFIRMATION} mt-2`}>
                                Password changed.
                            </p>
                        ) : null}
                        {passwordError ? <ErrorText className="mt-2">{passwordError}</ErrorText> : null}
                    </form>
                </AccountSection>

                <AccountSection title="Plan & billing">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <p className="display-opsz font-display text-[30px] leading-tight font-semibold text-ink">
                                    {PLAN_LABELS[tier]}
                                </p>
                                <Badge tone="accent">Current plan</Badge>
                                {entitlements?.seat_read_only ? (
                                    <span className="text-sm text-due">read-only academy seat</span>
                                ) : entitlements?.source === 'studio_member' ? (
                                    <span className="text-sm text-ink-muted">through your academy</span>
                                ) : null}
                            </div>
                            {period?.kind === 'renews' ? (
                                <p className="mt-1.5 text-[15px] text-ink-muted">
                                    Renews {formatPlanDate(period.endsAt)}
                                </p>
                            ) : period?.kind === 'ends' ? (
                                <p className="mt-1.5 text-[15px] text-due">
                                    {period.viaAcademy
                                        ? `Your academy’s plan ends ${formatPlanDate(period.endsAt)} — ask its owner if you need it longer.`
                                        : `Ends ${formatPlanDate(period.endsAt)} — your plan won’t renew. Resume it any time before then.`}
                                </p>
                            ) : null}
                        </div>

                        <div className="flex flex-wrap gap-2.5">
                            {tier === 'free' ? (
                                <Button onClick={() => setPricingOpen(true)}>Upgrade</Button>
                            ) : (
                                <Button variant="secondary" onClick={() => setPricingOpen(true)}>
                                    Change plan
                                </Button>
                            )}
                            {entitlements?.source !== 'studio_member' ? (
                                <Button variant="secondary" disabled={portalBusy} onClick={() => void openPortal()}>
                                    {portalBusy
                                        ? 'Opening…'
                                        : resumable
                                          ? 'Resume subscription'
                                          : 'Manage subscription'}
                                </Button>
                            ) : null}
                        </div>
                    </div>

                    {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

                    <div className="mt-[22px]">
                        <h3 className="text-xs font-semibold tracking-[0.08em] text-ink-muted uppercase">
                            Usage this month
                        </h3>
                        <ul className="mt-2.5 border-b border-hairline">
                            {meteredRows().map(({ metric, label: metricLabel }) => {
                                const limit = entitlements?.limits[metric] ?? 0;
                                const used = usage[metric] ?? 0;
                                // A bar for an unlimited allowance can only lie: full says
                                // "spent", empty says "none used". The word is the truth.
                                const unlimited = limit < 0;
                                return (
                                    <li key={metric} className={USAGE_ROW}>
                                        <div className="flex items-baseline justify-between gap-4">
                                            <span>{metricLabel}</span>
                                            <span className="text-right text-ink-muted tabular-nums">
                                                {unlimited ? 'unlimited' : `${used} of ${limit} used this month`}
                                            </span>
                                        </div>
                                        {unlimited ? null : (
                                            <ProgressBar
                                                className="account-meter mt-2"
                                                value={meterPercent(used, limit)}
                                                label={`${metricLabel} used this month`}
                                            />
                                        )}
                                    </li>
                                );
                            })}
                            <li className={`${USAGE_ROW} flex items-baseline justify-between gap-4`}>
                                <span>Active cloud scores</span>
                                <span className="text-right text-ink-muted tabular-nums">
                                    {describeStock(entitlements?.limits.cloud_scores ?? 0)}
                                </span>
                            </li>
                            <li className={`${USAGE_ROW} flex items-baseline justify-between gap-4`}>
                                <span>Student seats</span>
                                <span className="text-right text-ink-muted tabular-nums">
                                    {describeStock(entitlements?.limits.students ?? 0)}
                                </span>
                            </li>
                        </ul>
                        {/*
                  PDF export is deliberately absent: it is metered, and on
                  {TIER_LABELS.free} the very list above this line reads "0 of 1
                  used this month". The unlimited claim belongs to the two tools
                  that really are ungated everywhere.
                */}
                        <p className={`${ACCOUNT_NOTE} mt-2.5`}>
                            {features.fingering
                                ? `Annotation and the fingering optimizer are unlimited on every plan, including ${TIER_LABELS.free}.`
                                : `Annotation is unlimited on every plan, including ${TIER_LABELS.free}.`}
                        </p>
                    </div>
                </AccountSection>

                <StudioSeats
                    userId={userId}
                    tier={tier}
                    source={entitlements?.source ?? 'none'}
                    seatReadOnly={entitlements?.seat_read_only === true}
                />

                <AccountSection title="Preferences">
                    <HomeScreenPreferences />

                    <ScoreLayoutPreferences />

                    <div className={ACCOUNT_SUBSECTION}>
                        <h3 className={ACCOUNT_SUB_HEADING}>Offline storage</h3>
                        <p className={`${ACCOUNT_BODY} mt-1`}>
                            {storage === null
                                ? 'Checking what this device has downloaded…'
                                : storage.scoreCount === 0
                                  ? 'No scores are downloaded to this device yet.'
                                  : `${storage.scoreCount} ${storage.scoreCount === 1 ? 'score' : 'scores'} downloaded to this device, using about ${formatMegabytes(storage.bytes)}.`}
                        </p>
                        <p className={`${ACCOUNT_NOTE} mt-1`}>
                            Removing them frees the space and nothing else: your annotations are not affected, and each
                            score downloads again the next time you open it.
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                            <Button
                                variant="secondary"
                                disabled={storage === null || nothingCached || clearBusy}
                                onClick={() => setClearOpen(true)}
                            >
                                <SwapLabel
                                    labels={{ idle: 'Remove downloaded scores', busy: 'Removing…' }}
                                    active={clearBusy ? 'busy' : 'idle'}
                                />
                            </Button>
                            {clearedFlag ? (
                                <p role="status" className={CONFIRMATION}>
                                    Downloaded scores removed.
                                </p>
                            ) : null}
                        </div>
                        {storageError ? <ErrorText className="mt-2">{storageError}</ErrorText> : null}
                    </div>
                </AccountSection>

                <DeleteAccountSection session={session} />

                <div className="border-t border-hairline pt-8 pb-4">
                    <LegalLinks withContact />
                    <CancelSubscriptionLink className="mt-3" />
                </div>

                {clearOpen ? (
                    <ConfirmDialog
                        title="Remove downloaded scores?"
                        body="This deletes the offline copies stored on this device. Your annotations are not affected, and each score downloads again the next time you open it."
                        confirmLabel="Remove"
                        danger
                        busy={clearBusy}
                        onConfirm={() => void removeDownloads()}
                        onCancel={() => setClearOpen(false)}
                    />
                ) : null}

                {pricingOpen ? (
                    <PricingDialog
                        currentTier={tier}
                        subscription={subscription}
                        onClose={() => setPricingOpen(false)}
                    />
                ) : null}
            </div>
        </div>
    );
};
