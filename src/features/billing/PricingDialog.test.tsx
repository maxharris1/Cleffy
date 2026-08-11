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

const configurePrices = () => {
    vi.stubEnv('VITE_STRIPE_PRICE_PRO_MONTHLY', 'price_pro_monthly');
    vi.stubEnv('VITE_STRIPE_PRICE_PRO_ANNUAL', 'price_pro_annual');
    vi.stubEnv('VITE_STRIPE_PRICE_STUDIO_ANNUAL', 'price_studio_annual');
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

    it('shows all three tiers', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /Free/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Pro/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /Studio/ })).toBeInTheDocument();
    });

    it('marks the plan the teacher is already on and offers no button for it', () => {
        render(<PricingDialog currentTier="pro" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /Pro.*Current plan/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Choose Pro' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose Studio' })).toBeInTheDocument();
    });

    it('defaults to annual and switches to monthly pricing on demand', async () => {
        const user = userEvent.setup();
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Annual', pressed: true })).toBeInTheDocument();
        expect(screen.getByText('$120')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Monthly' }));
        expect(screen.getByText('$15')).toBeInTheDocument();
        expect(screen.queryByText('$120')).not.toBeInTheDocument();
    });

    it('hides the Founding Teacher offer unless the flag is on', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.queryByText(/Founding Teacher/)).not.toBeInTheDocument();
    });

    it('shows the Founding Teacher price when the flag is on', () => {
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'true');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /Founding Teacher/ })).toBeInTheDocument();
        expect(screen.getByText('$79')).toBeInTheDocument();
    });

    it('starts checkout with the selected price and redirects', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Pro' }));

        expect(createCheckoutSession).toHaveBeenCalledWith('price_pro_annual');
        expect(redirectTo).toHaveBeenCalledWith('https://checkout.stripe.com/session');
    });

    it('surfaces a checkout failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockRejectedValue(new Error('Stripe is down'));
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Pro' }));

        expect(await screen.findByText('Stripe is down')).toBeInTheDocument();
        expect(redirectTo).not.toHaveBeenCalled();
    });

    it('explains itself rather than offering broken buttons when billing is unconfigured', () => {
        vi.stubEnv('VITE_STRIPE_PRICE_PRO_MONTHLY', '');
        vi.stubEnv('VITE_STRIPE_PRICE_PRO_ANNUAL', '');
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        expect(screen.getByText(/Billing is not configured/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
    });

    it('says students never pay', () => {
        render(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByText(/Students never pay/)).toBeInTheDocument();
    });
});
