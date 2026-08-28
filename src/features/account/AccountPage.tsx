import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';

import { initialsOf } from '@/features/account/initials';
import type { OfflineStorageUsage } from '@/features/account/offlineStorage';
import { clearOfflineStorage, formatMegabytes, readOfflineStorage } from '@/features/account/offlineStorage';
import {
    displayNameOf,
    signOut,
    storedDisplayNameOf,
    updateDisplayName,
    updatePassword,
    useSession,
} from '@/features/auth/session';
import { NoBillingAccountError, createPortalSession, redirectTo } from '@/features/billing/billingApi';
import { PlanBadge } from '@/features/billing/PlanBadge';
import { PricingDialog } from '@/features/billing/PricingDialog';
import { StudioSeats } from '@/features/billing/StudioSeats';
import { clearCachedEntitlements, loadUsage } from '@/features/billing/entitlementsService';
import { TIER_LABELS } from '@/features/billing/pricing';
import { useEntitlements } from '@/features/billing/useEntitlements';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { UsageMetric } from '@/types/database';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ProgressBar } from '@/ui/ProgressBar';
import { TextField } from '@/ui/TextField';

const METERED: Array<{ metric: UsageMetric; label: string }> = [
    { metric: 'omr_runs', label: 'Play-along analyses' },
    { metric: 'vision_reads', label: 'AI fingering reads' },
    { metric: 'smart_imports', label: 'Smart imports' },
    { metric: 'pdf_exports', label: 'PDF exports' },
];

/** Shortest password Supabase will accept by default; stated, not silently enforced. */
const MIN_PASSWORD_LENGTH = 8;

const SECTION = 'mt-8 border-t border-stone-300/50 pt-6';
const SECTION_HEADING = 'text-sm font-medium uppercase tracking-[0.08em] text-stone-600';
const SUB_HEADING = 'text-sm font-medium text-stone-800';
const CONFIRMATION = 'text-sm text-emerald-700';

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
 * Everything about this account in one reading column: who you are, what you
 * pay, what you have used, what this device is holding, and the way out.
 *
 * Constrained to max-w-3xl rather than the shell's 1600px measure — the shell is
 * wide for a library of scores, and settings read as prose.
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
        if (password.length < MIN_PASSWORD_LENGTH) {
            setPasswordError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
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
            setPasswordError(err instanceof Error ? err.message : 'Could not change your password.');
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

    if (!session || (loading && !entitlements)) {
        return <LoadingText className="mt-10">Loading your account…</LoadingText>;
    }

    const tier = entitlements?.tier ?? 'free';
    const renewal = entitlements?.current_period_end
        ? new Date(entitlements.current_period_end).toLocaleDateString()
        : null;
    const label = displayNameOf(session);
    const email = session.user.email ?? '';
    const joined = formatJoined(session.user.created_at);
    const nothingCached = storage !== null && storage.scoreCount === 0 && storage.bytes === 0;

    // Left-aligned, not centred: the wordmark, the nav and every other page's
    // heading start at the container's left edge, and a centred column under a
    // left-aligned bar reads as a different site.
    return (
        <div className="w-full max-w-3xl">
            <header>
                <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Account</h1>
                <p className="mt-1 text-sm text-stone-500">Your profile, plan, and what this device is holding.</p>
            </header>

            {checkout === 'success' ? (
                <p
                    role="status"
                    className="mt-4 rounded-xl border border-emerald-300/70 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-900"
                >
                    Thanks — your subscription is active. It can take a moment to appear here.
                </p>
            ) : null}
            {checkout === 'cancelled' ? (
                <p role="status" className="mt-4 text-sm text-stone-600">
                    Checkout cancelled — nothing was charged.
                </p>
            ) : null}

            <section className={SECTION}>
                <h2 className={SECTION_HEADING}>Profile</h2>

                <div className="mt-4 flex items-center gap-4">
                    <span
                        aria-hidden="true"
                        className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-accent-soft text-xl font-semibold text-accent"
                    >
                        {initialsOf(label)}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-display text-lg font-semibold text-stone-800">{label}</p>
                        {/* displayNameOf falls back to the email, so the second
                            line only appears when it would say something the
                            first does not — the same rule the top bar follows. */}
                        {email && email !== label ? (
                            <p className="mt-0.5 truncate text-sm text-stone-600">{email}</p>
                        ) : null}
                        {joined ? <p className="mt-0.5 text-sm text-stone-500">Member since {joined}</p> : null}
                    </div>
                </div>
                <p className="mt-3 text-xs text-stone-500">
                    Your sign-in address can’t be changed here — write to us and we’ll move it for you.
                </p>

                <form className="mt-6" onSubmit={(event) => void saveName(event)}>
                    {/* A name is a short string; a field the full width of the
                        column would invite a sentence. Capped like the password
                        pair below so the three inputs read as one set. */}
                    <div className="max-w-sm">
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
                    <p className="mt-1.5 text-xs text-stone-500">
                        Shown on shared scores and in a student’s session, in place of your email address.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button type="submit" size="sm" disabled={!nameDirty || nameBusy}>
                            {nameBusy ? 'Saving…' : 'Save name'}
                        </Button>
                        {nameSaved ? (
                            <p role="status" className={CONFIRMATION}>
                                Name saved.
                            </p>
                        ) : null}
                    </div>
                    {nameError ? <ErrorText className="mt-2">{nameError}</ErrorText> : null}
                </form>

                <form
                    className="mt-6 border-t border-stone-200/70 pt-5"
                    onSubmit={(event) => void changePassword(event)}
                >
                    <h3 className={SUB_HEADING}>Change password</h3>
                    <p className="mt-1 text-xs text-stone-500">
                        At least {MIN_PASSWORD_LENGTH} characters. You stay signed in on this device.
                    </p>
                    <div className="mt-3 max-w-sm">
                        <TextField
                            id="account-new-password"
                            label="New password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                        />
                        <TextField
                            id="account-confirm-password"
                            label="Confirm new password"
                            type="password"
                            autoComplete="new-password"
                            spaced
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                        />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button type="submit" size="sm" variant="secondary" disabled={passwordBusy}>
                            {passwordBusy ? 'Changing…' : 'Change password'}
                        </Button>
                        {passwordSaved ? (
                            <p role="status" className={CONFIRMATION}>
                                Password changed.
                            </p>
                        ) : null}
                    </div>
                    {passwordError ? <ErrorText className="mt-2">{passwordError}</ErrorText> : null}
                </form>
            </section>

            <section className={SECTION}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className={SECTION_HEADING}>Plan &amp; billing</h2>
                        <p className="mt-1.5 flex items-center gap-2 text-stone-900">
                            <PlanBadge tier={tier} />
                            {entitlements?.source === 'studio_member' ? (
                                <span className="text-sm text-stone-600">through your academy</span>
                            ) : null}
                        </p>
                        {renewal ? (
                            <p className="mt-1 text-sm text-stone-500">
                                {tier === 'free' ? 'Ended' : 'Renews'} {renewal}
                            </p>
                        ) : null}
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {tier === 'free' ? (
                            <Button size="sm" onClick={() => setPricingOpen(true)}>
                                Upgrade
                            </Button>
                        ) : (
                            <Button size="sm" variant="secondary" onClick={() => setPricingOpen(true)}>
                                Change plan
                            </Button>
                        )}
                        {entitlements?.source !== 'studio_member' ? (
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={portalBusy}
                                onClick={() => void openPortal()}
                            >
                                {portalBusy ? 'Opening…' : 'Manage subscription'}
                            </Button>
                        ) : null}
                    </div>
                </div>

                {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
            </section>

            <section className={SECTION}>
                <h2 className={SECTION_HEADING}>Usage this month</h2>
                <ul className="mt-4 flex flex-col gap-4">
                    {METERED.map(({ metric, label: metricLabel }) => {
                        const limit = entitlements?.limits[metric] ?? 0;
                        const used = usage[metric] ?? 0;
                        // A bar for an unlimited allowance can only lie: full says
                        // "spent", empty says "none used". The word is the truth.
                        const unlimited = limit < 0;
                        return (
                            <li key={metric}>
                                <div className="flex items-baseline justify-between gap-4 text-sm">
                                    <span className="text-stone-700">{metricLabel}</span>
                                    <span className="text-stone-500">
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
                    <li className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="text-stone-700">Active cloud scores</span>
                        <span className="text-stone-500">{describeStock(entitlements?.limits.cloud_scores ?? 0)}</span>
                    </li>
                    <li className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="text-stone-700">Student seats</span>
                        <span className="text-stone-500">{describeStock(entitlements?.limits.students ?? 0)}</span>
                    </li>
                </ul>
                {/*
                  PDF export is deliberately absent: it is metered, and on
                  {TIER_LABELS.free} the very list above this line reads "0 of 1
                  used this month". The unlimited claim belongs to the two tools
                  that really are ungated everywhere.
                */}
                <p className="mt-4 text-xs text-stone-500">
                    Annotation and the fingering optimizer are unlimited on every plan, including {TIER_LABELS.free}.
                </p>
            </section>

            <StudioSeats userId={userId} tier={tier} source={entitlements?.source ?? 'none'} />

            <section className={SECTION}>
                <h2 className={SECTION_HEADING}>Preferences</h2>

                <h3 className={`${SUB_HEADING} mt-4`}>Offline storage</h3>
                <p className="mt-1.5 text-sm text-stone-600">
                    {storage === null
                        ? 'Checking what this device has downloaded…'
                        : storage.scoreCount === 0
                          ? 'No scores are downloaded to this device yet.'
                          : `${storage.scoreCount} ${storage.scoreCount === 1 ? 'score' : 'scores'} downloaded to this device, using about ${formatMegabytes(storage.bytes)}.`}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                    Removing them frees the space and nothing else: your annotations are not affected, and each score
                    downloads again the next time you open it.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={storage === null || nothingCached || clearBusy}
                        onClick={() => setClearOpen(true)}
                    >
                        {clearBusy ? 'Removing…' : 'Remove downloaded scores'}
                    </Button>
                    {clearedFlag ? (
                        <p role="status" className={CONFIRMATION}>
                            Downloaded scores removed.
                        </p>
                    ) : null}
                </div>
                {storageError ? <ErrorText className="mt-2">{storageError}</ErrorText> : null}
            </section>

            <section className={SECTION}>
                <h2 className={SECTION_HEADING}>Sign out</h2>
                <p className="mt-2 text-sm text-stone-600">
                    Signing out clears your cached plan on this device. Downloaded scores stay behind — remove them
                    above if you share this computer.
                </p>
                <Button
                    size="sm"
                    variant="secondary"
                    className="mt-3"
                    disabled={signingOut}
                    onClick={() => void handleSignOut()}
                >
                    {signingOut ? 'Signing out…' : 'Sign out'}
                </Button>
                {signOutError ? <ErrorText className="mt-2">{signOutError}</ErrorText> : null}
            </section>

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

            {pricingOpen ? <PricingDialog currentTier={tier} onClose={() => setPricingOpen(false)} /> : null}
        </div>
    );
};
