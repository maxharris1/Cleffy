import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router';

import { NoBillingAccountError, createPortalSession, redirectTo } from '@/features/billing/billingApi';
import { PlanBadge } from '@/features/billing/PlanBadge';
import { PricingDialog } from '@/features/billing/PricingDialog';
import { StudioSeats } from '@/features/billing/StudioSeats';
import { loadUsage } from '@/features/billing/entitlementsService';
import { TIER_LABELS } from '@/features/billing/pricing';
import { useEntitlements } from '@/features/billing/useEntitlements';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { UsageMetric } from '@/types/database';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';

const METERED: Array<{ metric: UsageMetric; label: string }> = [
    { metric: 'omr_runs', label: 'Play-along analyses' },
    { metric: 'vision_reads', label: 'AI fingering reads' },
    { metric: 'smart_imports', label: 'Smart imports' },
];

const describeLimit = (used: number, limit: number): string =>
    limit < 0 ? `${used} used · unlimited` : `${used} of ${limit} used this month`;

/** Plan, usage, subscription management, and Studio seats. */
export const SettingsPage = () => {
    const { userId } = useOutletContext<LibraryOutletContext>();
    const { entitlements, loading, refresh } = useEntitlements(userId);
    const [usage, setUsage] = useState<Partial<Record<UsageMetric, number>>>({});
    const [pricingOpen, setPricingOpen] = useState(false);
    const [portalBusy, setPortalBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [params] = useSearchParams();
    const checkout = params.get('checkout');

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

    if (loading && !entitlements) {
        return <LoadingText className="mt-10">Loading your plan…</LoadingText>;
    }

    const tier = entitlements?.tier ?? 'free';
    const renewal = entitlements?.current_period_end
        ? new Date(entitlements.current_period_end).toLocaleDateString()
        : null;

    return (
        <div>
            <h1 className="font-display text-2xl font-semibold text-stone-900">Settings</h1>

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

            <section className="mt-8 border-t border-stone-300/50 pt-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">Plan</h2>
                        <p className="mt-1.5 flex items-center gap-2 text-stone-900">
                            <PlanBadge tier={tier} />
                            {entitlements?.source === 'studio_member' ? (
                                <span className="text-sm text-stone-600">through your studio</span>
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

            <section className="mt-8 border-t border-stone-300/50 pt-6">
                <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">This month</h2>
                <ul className="mt-3 flex flex-col gap-2">
                    {METERED.map(({ metric, label }) => (
                        <li key={metric} className="flex items-baseline justify-between gap-4 text-sm">
                            <span className="text-stone-700">{label}</span>
                            <span className="text-stone-500">
                                {describeLimit(usage[metric] ?? 0, entitlements?.limits[metric] ?? 0)}
                            </span>
                        </li>
                    ))}
                    <li className="flex items-baseline justify-between gap-4 text-sm">
                        <span className="text-stone-700">Active cloud scores</span>
                        <span className="text-stone-500">
                            {(entitlements?.limits.cloud_scores ?? 0) < 0
                                ? 'unlimited'
                                : `up to ${entitlements?.limits.cloud_scores ?? 0}`}
                        </span>
                    </li>
                </ul>
                <p className="mt-3 text-xs text-stone-500">
                    Annotation, the fingering optimizer and PDF export are unlimited on every plan, including{' '}
                    {TIER_LABELS.free}.
                </p>
            </section>

            <StudioSeats userId={userId} tier={tier} source={entitlements?.source ?? 'none'} />

            {pricingOpen ? <PricingDialog currentTier={tier} onClose={() => setPricingOpen(false)} /> : null}
        </div>
    );
};
