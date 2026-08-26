import { useState } from 'react';

import { createCheckoutSession, redirectTo } from '@/features/billing/billingApi';
import {
    TIER_CARDS,
    foundingPrice,
    isBillingConfigured,
    priceFor,
    type BillingInterval,
} from '@/features/billing/pricing';
import type { BillingTier } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';

export interface PricingDialogProps {
    onClose: () => void;
    /** The teacher's current tier, so the card they are on is marked. */
    currentTier: BillingTier;
    /** Optional line explaining what prompted the upgrade prompt. */
    reason?: string;
}

/**
 * The upgrade surface: four tier cards in two personas — Personal for a player
 * on their own, Teacher for anyone with students, Academy beneath it for a team
 * of teachers — plus a monthly/annual toggle and the Founding Teacher price
 * when that launch offer is switched on.
 */
export const PricingDialog = ({ onClose, currentTier, reason }: PricingDialogProps) => {
    const [interval, setInterval] = useState<BillingInterval>('annual');
    const [busyPrice, setBusyPrice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const founding = foundingPrice();

    const startCheckout = async (priceId: string) => {
        setError(null);
        setBusyPrice(priceId);
        try {
            redirectTo(await createCheckoutSession(priceId));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not start checkout.');
            setBusyPrice(null);
        }
    };

    if (!isBillingConfigured()) {
        return (
            <Dialog label="Plans" onClose={onClose} sheet>
                <p className="text-sm text-stone-600">
                    Billing is not configured for this deployment yet. See SETUP_SUPABASE.md.
                </p>
            </Dialog>
        );
    }

    return (
        <Dialog label="Plans" onClose={onClose} sheet>
            <div className="w-full">
                {reason ? <p className="mb-4 text-sm text-stone-600">{reason}</p> : null}

                <p className="mb-4 text-sm text-stone-600">
                    Personal is the practice tool. Teacher adds your students. Academy covers a team of teachers.
                </p>

                <div className="mb-5 flex items-center gap-2" role="group" aria-label="Billing interval">
                    {(['monthly', 'annual'] as const).map((option) => (
                        <button
                            key={option}
                            type="button"
                            aria-pressed={interval === option}
                            onClick={() => setInterval(option)}
                            className={[
                                'cursor-pointer rounded-lg px-3 py-1.5 text-sm transition',
                                interval === option
                                    ? 'bg-accent-soft font-medium text-accent'
                                    : 'text-stone-600 hover:bg-ink/5',
                            ].join(' ')}
                        >
                            {option === 'monthly' ? 'Monthly' : 'Annual'}
                        </button>
                    ))}
                </div>

                <div className="flex flex-col gap-3">
                    {TIER_CARDS.map((card) => {
                        const price = priceFor(card.tier, interval);
                        const isCurrent = card.tier === currentTier;
                        return (
                            <section
                                key={card.tier}
                                className={[
                                    'rounded-2xl border p-4 transition',
                                    isCurrent ? 'border-accent/40 bg-accent-soft/30' : 'border-stone-200 bg-white',
                                ].join(' ')}
                            >
                                <div className="flex items-baseline justify-between gap-3">
                                    <h3 className="font-display text-lg font-semibold text-stone-900">
                                        {card.name}
                                        {isCurrent ? (
                                            <Badge tone="accent" className="ml-2 align-middle">
                                                Current plan
                                            </Badge>
                                        ) : null}
                                    </h3>
                                    {price ? (
                                        <p className="shrink-0 text-right">
                                            <span className="font-display text-xl font-semibold text-stone-900">
                                                {price.amount}
                                            </span>
                                            <span className="block text-xs text-stone-500">{price.caption}</span>
                                        </p>
                                    ) : null}
                                </div>

                                <p className="mt-1 text-sm text-stone-600">{card.tagline}</p>
                                {price?.note ? <p className="mt-1 text-xs text-ok">{price.note}</p> : null}

                                <ul className="mt-3 flex flex-col gap-1 text-sm text-stone-700">
                                    {card.features.map((feature) => (
                                        <li key={feature}>{feature}</li>
                                    ))}
                                </ul>

                                {price?.priceId && !isCurrent ? (
                                    <Button
                                        size="sm"
                                        className="mt-4 w-full"
                                        disabled={busyPrice !== null}
                                        onClick={() => void startCheckout(price.priceId as string)}
                                    >
                                        {busyPrice === price.priceId ? 'Opening checkout…' : `Choose ${card.name}`}
                                    </Button>
                                ) : null}
                            </section>
                        );
                    })}

                    {founding?.priceId ? (
                        <section className="rounded-2xl border border-amber-300/70 bg-amber-50/60 p-4">
                            <div className="flex items-baseline justify-between gap-3">
                                <h3 className="font-display text-lg font-semibold text-stone-900">
                                    Founding Teacher
                                    <Badge tone="warn" className="ml-2 align-middle">
                                        Limited
                                    </Badge>
                                </h3>
                                <p className="shrink-0 text-right">
                                    <span className="font-display text-xl font-semibold text-stone-900">
                                        {founding.amount}
                                    </span>
                                    <span className="block text-xs text-stone-500">{founding.caption}</span>
                                </p>
                            </div>
                            <p className="mt-1 text-sm text-stone-700">{founding.note}</p>
                            <Button
                                size="sm"
                                className="mt-4 w-full"
                                disabled={busyPrice !== null}
                                onClick={() => void startCheckout(founding.priceId as string)}
                            >
                                {busyPrice === founding.priceId ? 'Opening checkout…' : 'Become a Founding Teacher'}
                            </Button>
                        </section>
                    ) : null}
                </div>

                {error ? <ErrorText className="mt-4">{error}</ErrorText> : null}

                <p className="mt-4 text-xs text-stone-500">
                    Students never pay and never need an account — share links keep working on every plan.
                </p>
            </div>
        </Dialog>
    );
};
