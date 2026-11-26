import { useState } from 'react';

import { createCheckoutSession, createPortalSession, redirectTo } from '@/features/billing/billingApi';
import { useBillingCountry } from '@/features/billing/billingRegion';
import { CheckoutReview } from '@/features/billing/CheckoutReview';
import { CountryPicker } from '@/features/billing/CountryPicker';
import { formatPlanDate, type OwnSubscription } from '@/features/billing/planStatus';
import {
    TIER_CARDS,
    foundingPrice,
    isBillingConfigured,
    priceFor,
    type BillingInterval,
    type PlanSlot,
} from '@/features/billing/pricing';
import { AgreementNote } from '@/features/legal/AgreementNote';
import type { EffectiveTier } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { CloseButton } from '@/ui/CloseButton';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { Segmented, type SegmentedOption } from '@/ui/Segmented';

import { currencyForCountry } from '../../../supabase/functions/_shared/billingTerms';

const INTERVAL_OPTIONS = [
    { value: 'monthly', label: 'Monthly' },
    { value: 'annual', label: 'Annual' },
] as const satisfies readonly SegmentedOption<BillingInterval>[];

export interface PricingDialogProps {
    onClose: () => void;
    /**
     * The teacher's current tier, so the card they are on is marked. Widened to
     * EffectiveTier only so it accepts whatever get_entitlements() answered —
     * 'student' simply matches no card, which is the right outcome.
     */
    currentTier: EffectiveTier;
    /** Optional line explaining what prompted the upgrade prompt. */
    reason?: string;
    /**
     * The subscription this account already pays for (ownSubscriptionOf), if
     * any. Then every plan change goes through the billing portal, which
     * switches the one subscription: Checkout would start a SECOND one beside
     * it and bill both.
     */
    subscription?: OwnSubscription | null;
}

/**
 * The upgrade surface: four tier cards in two personas — Personal for a player
 * on their own, Teacher for anyone with students, Academy beneath it for a team
 * of teachers — plus a monthly/annual toggle and the Founding Teacher price
 * when that launch offer is switched on.
 */
export const PricingDialog = ({ onClose, currentTier, reason, subscription = null }: PricingDialogProps) => {
    const [interval, setInterval] = useState<BillingInterval>('annual');
    const [busyPrice, setBusyPrice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [country, setCountry] = useBillingCountry();
    const currency = currencyForCountry(country);
    /** The plan being reviewed before Checkout; null while the cards are shown. */
    const [review, setReview] = useState<{ slot: PlanSlot; priceId: string } | null>(null);
    // The portal cannot switch anyone onto the Founding price (DEPLOY.md §1), so
    // for a subscriber it would only be reachable as a second subscription.
    const founding = subscription ? null : foundingPrice(currency);

    /** Choosing a plan opens the review step; only its Continue button reaches Stripe. */
    const reviewPlan = (slot: PlanSlot | null, priceId: string | null) => {
        if (!slot || !priceId) {
            return;
        }
        setError(null);
        setReview({ slot, priceId });
    };

    const startCheckout = async (priceId: string, consentText: string) => {
        setError(null);
        setBusyPrice(priceId);
        try {
            redirectTo(await createCheckoutSession(priceId, { accepted: true, country, text: consentText }));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not start checkout.');
            setBusyPrice(null);
        }
    };

    /** Switching or resuming an existing subscription happens on Stripe's portal. */
    const openPortal = async (busyKey: string) => {
        setError(null);
        setBusyPrice(busyKey);
        try {
            redirectTo(await createPortalSession());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not open the billing portal.');
            setBusyPrice(null);
        }
    };

    if (!isBillingConfigured()) {
        return (
            <Dialog label="Plans" onClose={onClose} sheet>
                <p className="text-sm text-ink-muted">
                    Billing is not configured for this deployment yet. See SETUP_SUPABASE.md.
                </p>
            </Dialog>
        );
    }

    if (review) {
        return (
            // Keyed apart from the cards' dialog so it mounts fresh at the top:
            // reusing that instance kept the list's scroll position and opened
            // the review with the price line scrolled out of view.
            <Dialog key="review" label="Plans" onClose={onClose} sheet>
                <CheckoutReview
                    slot={review.slot}
                    country={country}
                    onCountryChange={setCountry}
                    busy={busyPrice !== null}
                    error={error}
                    onBack={() => {
                        setError(null);
                        setReview(null);
                    }}
                    onConfirm={(consentText) => void startCheckout(review.priceId, consentText)}
                />
            </Dialog>
        );
    }

    return (
        <Dialog key="plans" label="Plans" onClose={onClose} sheet size="wide" withHeader={false}>
            <div className="relative w-full">
                <div className="sticky -top-7 z-10 -mx-7 -mt-7 flex justify-end bg-paper px-4 pt-5 pb-1 sm:absolute sm:-top-3 sm:-right-3 sm:m-0 sm:block sm:bg-transparent sm:p-0">
                    <CloseButton onClick={onClose} className="size-11 rounded-xl text-ink-muted hover:bg-ink/5" />
                </div>

                <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
                    <div className="min-w-0 flex-1 basis-[420px]">
                        <h2 className="font-display text-[34px] leading-[1.05] font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[48px] sm:leading-[1.02]">
                            Free to start. <em>Students never pay.</em>
                        </h2>
                        {reason ? <p className="mt-3 text-sm text-ink-muted">{reason}</p> : null}
                        <p className="mt-3 max-w-[560px] text-base text-ink-muted">
                            Personal is the practice tool. Teacher adds your students. Academy covers a team of
                            teachers.
                        </p>
                        {subscription ? (
                            <p className="mt-3 text-sm text-ink-muted">
                                You already have a subscription, so switching plans happens in the billing portal — the
                                plan you have changes there, and you are never billed for two.
                            </p>
                        ) : null}
                    </div>
                    <div className="flex w-full flex-col items-start gap-3 sm:w-auto sm:items-end">
                        <CountryPicker className="w-full sm:w-auto" value={country} onChange={setCountry} />
                        <Segmented
                            label="Billing interval"
                            size="md"
                            value={interval}
                            options={INTERVAL_OPTIONS}
                            onChange={setInterval}
                        />
                    </div>
                </div>

                <div className="mt-7 flex flex-wrap items-stretch gap-3.5">
                    {TIER_CARDS.map((card) => {
                        const price = priceFor(card.tier, interval, currency);
                        const isCurrent = card.tier === currentTier;
                        return (
                            <section
                                key={card.tier}
                                className={[
                                    'flex min-w-0 flex-1 basis-full flex-col sm:basis-[calc(50%-7px)] lg:basis-[210px] rounded-2xl border p-4 transition-colors',
                                    isCurrent ? 'border-accent/40 bg-accent-soft/30' : 'border-stone-200 bg-white',
                                ].join(' ')}
                            >
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                    <h3 className="min-w-0 font-display text-lg font-semibold text-stone-900 [overflow-wrap:anywhere]">
                                        {card.name}
                                        {isCurrent ? (
                                            <Badge tone="accent" className="ml-2 align-middle">
                                                Current plan
                                            </Badge>
                                        ) : null}
                                    </h3>
                                    {price ? (
                                        <p className="ml-auto text-right">
                                            <span className="font-display text-xl font-semibold tabular-nums text-stone-900">
                                                {price.amount}
                                            </span>
                                            <span className="block text-xs tabular-nums text-stone-500">
                                                {price.caption}
                                            </span>
                                        </p>
                                    ) : null}
                                </div>

                                <p className="mt-1 text-sm text-stone-600">{card.tagline}</p>
                                {price?.note ? <p className="mt-1 text-xs text-ok">{price.note}</p> : null}
                                {isCurrent && subscription?.cancelling ? (
                                    <p className="mt-1 text-sm text-amber-800">
                                        {subscription.endsAt
                                            ? `Ends ${formatPlanDate(subscription.endsAt)} — it won’t renew.`
                                            : 'Cancelled — it won’t renew.'}
                                    </p>
                                ) : null}

                                <ul className="mt-3 flex grow flex-col gap-1 text-sm text-stone-700">
                                    {card.features.map((feature) => (
                                        <li key={feature}>{feature}</li>
                                    ))}
                                </ul>

                                {isCurrent && subscription?.cancelling ? (
                                    <Button
                                        size="sm"
                                        className="mt-4 w-full"
                                        disabled={busyPrice !== null}
                                        onClick={() => void openPortal(`resume:${card.tier}`)}
                                    >
                                        {busyPrice === `resume:${card.tier}`
                                            ? 'Opening billing portal…'
                                            : 'Resume subscription'}
                                    </Button>
                                ) : price?.priceId && !isCurrent && subscription ? (
                                    // Free has no price, so no card ever offers a
                                    // portal "switch" down to it: cancelling is.
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        className="mt-4 w-full"
                                        disabled={busyPrice !== null}
                                        onClick={() => void openPortal(`switch:${card.tier}`)}
                                    >
                                        {busyPrice === `switch:${card.tier}`
                                            ? 'Opening billing portal…'
                                            : `Switch to ${card.name}`}
                                    </Button>
                                ) : price?.priceId && !isCurrent ? (
                                    <Button
                                        size="sm"
                                        className="mt-4 w-full"
                                        disabled={busyPrice !== null}
                                        onClick={() => reviewPlan(price.slot, price.priceId)}
                                    >
                                        {`Choose ${card.name}`}
                                    </Button>
                                ) : null}
                            </section>
                        );
                    })}

                    {founding?.priceId ? (
                        <section className="flex min-w-0 flex-1 basis-full flex-col sm:basis-[calc(50%-7px)] lg:basis-[210px] rounded-2xl border border-amber-300/70 bg-amber-50/60 p-4">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                                <h3 className="min-w-0 font-display text-lg font-semibold text-stone-900 [overflow-wrap:anywhere]">
                                    Founding Teacher
                                    <Badge tone="warn" className="ml-2 align-middle">
                                        Limited
                                    </Badge>
                                </h3>
                                <p className="ml-auto text-right">
                                    <span className="font-display text-xl font-semibold tabular-nums text-stone-900">
                                        {founding.amount}
                                    </span>
                                    <span className="block text-xs text-stone-500">{founding.caption}</span>
                                </p>
                            </div>
                            <p className="mt-1 grow text-sm text-stone-700">{founding.note}</p>
                            <Button
                                size="sm"
                                className="mt-4 w-full"
                                disabled={busyPrice !== null}
                                onClick={() => reviewPlan(founding.slot, founding.priceId)}
                            >
                                Become a Founding Teacher
                            </Button>
                        </section>
                    ) : null}
                </div>

                {error ? <ErrorText className="mt-4">{error}</ErrorText> : null}

                <p className="mt-6 text-sm text-ink-muted">
                    Plans renew automatically until you cancel, which you can do at any time from your Account page or
                    at cleffy.io/cancel. Full refund within 14 days of your first purchase.
                </p>
                <AgreementNote action="subscribing" className="mt-1" />

                <p className="mt-3 text-sm text-ink-muted">
                    Students never pay and never need an account — share links keep working on every plan.
                </p>
            </div>
        </Dialog>
    );
};
