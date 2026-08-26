import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PricingDialog } from '@/features/billing/PricingDialog';

const createCheckoutSession = vi.fn();
const redirectTo = vi.fn();

vi.mock('@/features/billing/billingApi', () => ({
    createCheckoutSession: (...args: unknown[]) => createCheckoutSession(...args),
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

describe('PricingDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configurePrices();
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'false');
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

    it('sells the roster, and prices it against what a lesson costs', () => {
        // 'Unlimited students' belongs to the Teacher card, pinned structurally in
        // tests/billing/limitsInSync.test.ts; the per-student line may sit on that
        // card or in the dialog footer, so here both only have to reach the DOM.
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getAllByText(/Unlimited students/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/under \$1 per student/).length).toBeGreaterThan(0);
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

    it('starts checkout with the selected price and redirects', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

        expect(createCheckoutSession).toHaveBeenCalledWith('price_teacher_annual');
        expect(redirectTo).toHaveBeenCalledWith('https://checkout.stripe.com/session');
    });

    it('sends the monthly price of the card that was clicked', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Monthly' }));
        await user.click(screen.getByRole('button', { name: 'Choose Personal' }));

        expect(createCheckoutSession).toHaveBeenCalledWith('price_personal_monthly');
    });

    it('surfaces a checkout failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockRejectedValue(new Error('Stripe is down'));
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

        expect(await screen.findByText('Stripe is down')).toBeInTheDocument();
        expect(redirectTo).not.toHaveBeenCalled();
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
