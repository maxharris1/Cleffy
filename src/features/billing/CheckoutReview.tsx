import { useId, useState } from 'react';

import { CountryPicker } from '@/features/billing/CountryPicker';
import { Button } from '@/ui/Button';
import { linkClassName } from '@/ui/classNames';
import { ErrorText } from '@/ui/ErrorText';

import {
    autoRenewalConsentText,
    BILLING_PATHS,
    currencyForCountry,
    preCheckoutFacts,
    purchaseTermsFor,
    TRADER,
    traderAddress,
    WITHDRAWAL_SUMMARY,
    type PlanSlot,
} from '../../../supabase/functions/_shared/billingTerms';

export interface CheckoutReviewProps {
    slot: PlanSlot;
    country: string;
    onCountryChange: (country: string) => void;
    /** Called with the exact sentence the buyer ticked. */
    onConfirm: (consentText: string) => void;
    onBack: () => void;
    busy: boolean;
    error: string | null;
}

/**
 * The last screen before Stripe: what is being bought, from whom, for how much
 * including tax, how it renews and how to stop it, the 14-day refund and the
 * EU/UK withdrawal right -- and the auto-renewal box, unticked, that the
 * Continue button waits for (launch packet items 13 and 15).
 *
 * The checkbox's label IS the consent: the same sentence stripe-checkout
 * rebuilds and stores, so what the buyer read is what the record says.
 */
export const CheckoutReview = ({
    slot,
    country,
    onCountryChange,
    onConfirm,
    onBack,
    busy,
    error,
}: CheckoutReviewProps) => {
    const [agreed, setAgreed] = useState(false);
    const consentId = useId();
    const terms = purchaseTermsFor(slot, currencyForCountry(country));
    const consentText = autoRenewalConsentText(terms);
    // No wrap: a link split across two lines cannot carry linkClassName's enlarged hit area.
    const link = `${linkClassName} text-xs whitespace-nowrap`;

    return (
        <section aria-labelledby={`${consentId}-title`} className="w-full">
            <h3 id={`${consentId}-title`} className="font-display text-lg font-semibold text-stone-900">
                Review your {terms.planName} subscription
            </h3>

            <CountryPicker
                className="mt-3"
                value={country}
                onChange={(next) => {
                    onCountryChange(next);
                    // A new country is a new price: the old tick was not for it.
                    setAgreed(false);
                }}
            />

            <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-5 text-sm text-stone-700">
                {preCheckoutFacts(terms).map((fact) => (
                    <li key={fact}>{fact}</li>
                ))}
            </ul>

            <p className="mt-3 text-xs leading-relaxed text-stone-500">{WITHDRAWAL_SUMMARY}</p>

            <p className="mt-3 text-xs leading-relaxed text-stone-500">
                Sold by {TRADER.name}, {traderAddress()} ·{' '}
                <a href={`mailto:${TRADER.supportEmail}`} className={link}>
                    {TRADER.supportEmail}
                </a>
                . Read the{' '}
                <a href={BILLING_PATHS.terms} target="_blank" rel="noopener noreferrer" className={link}>
                    Terms of Service
                </a>{' '}
                and{' '}
                <a href={BILLING_PATHS.refunds} target="_blank" rel="noopener noreferrer" className={link}>
                    Refund Policy
                </a>
                .
            </p>

            <label
                htmlFor={consentId}
                className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-stone-300/90 bg-white/70 p-3 text-sm text-stone-800"
            >
                <input
                    id={consentId}
                    type="checkbox"
                    checked={agreed}
                    onChange={(event) => setAgreed(event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                <span>{consentText}</span>
            </label>

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
                    Back to plans
                </Button>
                <Button size="sm" disabled={!agreed || busy} onClick={() => onConfirm(consentText)}>
                    {busy ? 'Opening secure checkout…' : 'Continue to payment'}
                </Button>
            </div>
            <p className="mt-2 text-xs text-stone-500">
                Payment is taken by Stripe on the next page, which shows the total including any tax before you pay.
            </p>
        </section>
    );
};
