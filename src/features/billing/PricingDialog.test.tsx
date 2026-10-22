import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PricingDialog } from '@/features/billing/PricingDialog';

import { autoRenewalConsentText, purchaseTermsFor } from '../../../supabase/functions/_shared/billingTerms';

const createCheckoutSession = vi.fn();
const createPortalSession = vi.fn();
const redirectTo = vi.fn();

vi.mock('@/features/billing/billingApi', () => ({
    createCheckoutSession: (...args: unknown[]) => createCheckoutSession(...args),
    createPortalSession: (...args: unknown[]) => createPortalSession(...args),
    redirectTo: (...args: unknown[]) => redirectTo(...args),
}));

/** The seven published prices: both intervals of all three plans, plus Founding. */
const configurePrices = () => {
    vi.stubEnv('VITE_STRIPE_PRICE_PERSONAL_MONTHLY', 'price_personal_monthly');
    vi.stubEnv('VITE_STRIPE_PRICE_PERSONAL_ANNUAL', 'price_personal_annual');
    vi.stubEnv('VITE_STRIPE_PRICE_TEACHER_MONTHLY', 'price_teacher_monthly');
    vi.stubEnv('VITE_STRIPE_PRICE_TEACHER_ANNUAL', 'price_teacher_annual');
    vi.stubEnv('VITE_STRIPE_PRICE_ACADEMY_MONTHLY', 'price_academy_monthly');
    vi.stubEnv('VITE_STRIPE_PRICE_ACADEMY_ANNUAL', 'price_academy_annual');
    vi.stubEnv('VITE_STRIPE_PRICE_FOUNDING_ANNUAL', 'price_founding_annual');
};

/** The review step: tick the auto-renewal box, then continue to Stripe. */
const agreeAndContinue = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
};

describe('PricingDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configurePrices();
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'false');
        window.localStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllEnvs();
    });

    it('shows all four tiers', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Free/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Personal/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Teacher/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Academy/ })).toBeInTheDocument();
    });

    it('marks the plan the teacher is already on and offers no button for it', () => {
        render(<PricingDialog currentTier="teacher" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Teacher.*Current plan/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Choose Teacher' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose Academy' })).toBeInTheDocument();
    });

    it('marks Personal the same way for a solo subscriber, who can still move up', () => {
        render(<PricingDialog currentTier="personal" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Personal.*Current plan/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Choose Personal' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose Teacher' })).toBeInTheDocument();
    });

    it('defaults to annual and switches to monthly pricing on demand', async () => {
        const user = userEvent.setup();
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Annual', pressed: true })).toBeInTheDocument();
        expect(screen.getByText('$70')).toBeInTheDocument();
        expect(screen.getByText('$190')).toBeInTheDocument();
        expect(screen.getByText('$490')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Monthly' }));
        expect(screen.getByText('$7')).toBeInTheDocument();
        expect(screen.getByText('$19')).toBeInTheDocument();
        expect(screen.getByText('$49')).toBeInTheDocument();
        expect(screen.queryByText('$70')).not.toBeInTheDocument();
        expect(screen.queryByText('$190')).not.toBeInTheDocument();
    });

    it('sells the roster at one price however many students there are', () => {
        // 'Unlimited students' belongs to the Teacher card, pinned structurally in
        // tests/billing/limitsInSync.test.ts. The old "under $1 per student" line
        // stopped being true in euros (€21 / 20), so the card no longer prices
        // per head.
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getAllByText(/Unlimited students/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/one price, however many students/).length).toBeGreaterThan(0);
    });

    it('hides the Founding Teacher offer unless the flag is on', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.queryByText(/Founding Teacher/)).not.toBeInTheDocument();
    });

    it('shows the Founding Teacher price when the flag is on', () => {
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'true');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /Founding Teacher/ })).toBeInTheDocument();
        expect(screen.getByText('$99')).toBeInTheDocument();
    });

    it('starts checkout with the selected price and the ticked consent, and redirects', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
        expect(createCheckoutSession).not.toHaveBeenCalled();
        await agreeAndContinue(user);

        expect(createCheckoutSession).toHaveBeenCalledWith('price_teacher_annual', {
            accepted: true,
            country: 'US',
            text: autoRenewalConsentText(purchaseTermsFor('teacherAnnual', 'usd')),
        });
        expect(redirectTo).toHaveBeenCalledWith('https://checkout.stripe.com/session');
    });

    it('sends the monthly price of the card that was clicked', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Monthly' }));
        await user.click(screen.getByRole('button', { name: 'Choose Personal' }));
        await agreeAndContinue(user);

        expect(createCheckoutSession).toHaveBeenCalledWith('price_personal_monthly', expect.anything());
    });

    it('surfaces a checkout failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockRejectedValue(new Error('Stripe is down'));
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
        await agreeAndContinue(user);

        expect(await screen.findByText('Stripe is down')).toBeInTheDocument();
        expect(redirectTo).not.toHaveBeenCalled();
    });

    describe('before payment (launch items 13, 15, 17)', () => {
        it('keeps Continue disabled until the unticked auto-renewal box is ticked', async () => {
            const user = userEvent.setup();
            render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

            const box = screen.getByRole('checkbox', { name: /renews automatically every year/ });
            expect(box).not.toBeChecked();
            expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
            await user.click(box);
            expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
        });

        it('names the trader, the price with tax, renewal, cancellation, the refund and the policies', async () => {
            const user = userEvent.setup();
            render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

            expect(screen.getByText(/Cleffy LLC, 245 East 37th Street/)).toBeInTheDocument();
            expect(screen.getByText(/\$190 per year, plus any applicable sales tax/)).toBeInTheDocument();
            expect(screen.getByText(/No minimum term/)).toBeInTheDocument();
            expect(screen.getByText(/Cancel any time from your Account page/)).toBeInTheDocument();
            expect(screen.getByText(/full refund if you ask within 14 days/)).toBeInTheDocument();
            expect(screen.getByText(/If you live in the EU or UK/)).toBeInTheDocument();
            expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
            expect(screen.getByRole('link', { name: 'Refund Policy' })).toHaveAttribute('href', '/refunds');
        });

        it('prices in euros, VAT included, for a buyer in the EU', async () => {
            const user = userEvent.setup();
            render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Monthly' }));
            await user.selectOptions(screen.getByLabelText('Prices for'), 'DE');

            expect(screen.getByText('€8')).toBeInTheDocument();
            expect(screen.getByText('€21')).toBeInTheDocument();
            expect(screen.getByText('€55')).toBeInTheDocument();
            expect(screen.getAllByText(/VAT incl\./).length).toBeGreaterThan(0);
        });

        it('prices in pounds for a buyer in the UK', async () => {
            const user = userEvent.setup();
            render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Monthly' }));
            await user.selectOptions(screen.getByLabelText('Prices for'), 'GB');

            expect(screen.getByText('£7')).toBeInTheDocument();
            expect(screen.getByText('£18')).toBeInTheDocument();
            expect(screen.getByText('£45')).toBeInTheDocument();
        });

        it('asks for the box again after the country, and so the price, changes', async () => {
            const user = userEvent.setup();
            createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
            render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
            await user.click(screen.getByRole('checkbox'));
            await user.selectOptions(screen.getByLabelText('Prices for'), 'FR');

            expect(screen.getByRole('checkbox')).not.toBeChecked();
            await agreeAndContinue(user);
            expect(createCheckoutSession).toHaveBeenCalledWith('price_teacher_annual', {
                accepted: true,
                country: 'FR',
                text: autoRenewalConsentText(purchaseTermsFor('teacherAnnual', 'eur')),
            });
        });
    });

    it('explains itself rather than offering broken buttons when billing is unconfigured', () => {
        for (const key of [
            'VITE_STRIPE_PRICE_PERSONAL_MONTHLY',
            'VITE_STRIPE_PRICE_PERSONAL_ANNUAL',
            'VITE_STRIPE_PRICE_TEACHER_MONTHLY',
            'VITE_STRIPE_PRICE_TEACHER_ANNUAL',
            'VITE_STRIPE_PRICE_ACADEMY_MONTHLY',
            'VITE_STRIPE_PRICE_ACADEMY_ANNUAL',
            'VITE_STRIPE_PRICE_FOUNDING_ANNUAL',
        ]) {
            vi.stubEnv(key, '');
        }
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        expect(screen.getByText(/Billing is not configured/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
    });

    it('says students never pay', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByText(/Students never pay/)).toBeInTheDocument();
    });
});

describe('PricingDialog for an existing subscriber', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configurePrices();
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'true');
        createPortalSession.mockResolvedValue('https://billing.stripe.com/session');
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllEnvs();
    });

    it('switches plans in the billing portal, never through a second Checkout', async () => {
        // Checkout always creates a new subscription; a Personal subscriber who
        // "chose Teacher" there was billed for both.
        const user = userEvent.setup();
        render(
            <PricingDialog
                currentTier="personal"
                subscription={{ endsAt: '2026-11-08T00:00:00Z', cancelling: false }}
                onClose={vi.fn()}
            />,
        );

        expect(screen.queryByRole('button', { name: /^Choose / })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Switch to Teacher' }));

        expect(createPortalSession).toHaveBeenCalledTimes(1);
        expect(createCheckoutSession).not.toHaveBeenCalled();
        expect(redirectTo).toHaveBeenCalledWith('https://billing.stripe.com/session');
    });

    it('does not sell the Founding price beside a subscription the portal cannot switch onto it', () => {
        render(
            <PricingDialog
                currentTier="teacher"
                subscription={{ endsAt: null, cancelling: false }}
                onClose={vi.fn()}
            />,
        );
        expect(screen.queryByRole('button', { name: 'Become a Founding Teacher' })).not.toBeInTheDocument();
    });

    it('says a cancelled plan ends, and offers to resume it', async () => {
        const user = userEvent.setup();
        const endsAt = '2026-11-08T12:00:00Z';
        render(<PricingDialog currentTier="personal" subscription={{ endsAt, cancelling: true }} onClose={vi.fn()} />);

        expect(screen.getByText(`Ends ${new Date(endsAt).toLocaleDateString()} — it won’t renew.`)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Resume subscription' }));
        expect(createPortalSession).toHaveBeenCalledTimes(1);
    });

    it('surfaces a portal failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createPortalSession.mockRejectedValue(new Error('Portal is down'));
        render(
            <PricingDialog
                currentTier="personal"
                subscription={{ endsAt: null, cancelling: false }}
                onClose={vi.fn()}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Switch to Academy' }));

        expect(await screen.findByText('Portal is down')).toBeInTheDocument();
        expect(redirectTo).not.toHaveBeenCalled();
    });

    it('still sells through Checkout to a seated teacher, whose Academy is not theirs to switch', () => {
        render(<PricingDialog currentTier="academy" subscription={null} onClose={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Choose Teacher' })).toBeInTheDocument();
    });
});

describe('PricingDialog terms', () => {
    beforeEach(configurePrices);

    afterEach(() => {
        cleanup();
        vi.unstubAllEnvs();
    });

    it('links the Terms and Privacy Policy in a new tab and says plans renew', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByText(/renew automatically until you cancel/)).toBeInTheDocument();
        const terms = screen.getByRole('link', { name: 'Terms of Service' });
        expect(terms).toHaveAttribute('href', '/terms');
        expect(terms).toHaveAttribute('target', '_blank');
        expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    });
});
