import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PricingDialog } from '@/features/billing/PricingDialog';
import { utilityStyleAt } from '@/test/tailwindStyle';

import { autoRenewalConsentText, purchaseTermsFor } from '../../../supabase/functions/_shared/billingTerms';

const INDEX_CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** A `var(--color-<name>)` from our theme as its hex; anything else as given. */
const themeHex = (value: string): string => {
    const name = value.match(/^var\((--color-[\w-]+)\)$/)?.[1] ?? value;
    return INDEX_CSS.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1] ?? value;
};

/** A card's own theme colour, or the panel's paper behind a transparent card. */
const colourOf = async (element: Element, property: string, fallback: string) => {
    const value = await utilityStyleAt(element, property, 1280);
    return themeHex(value?.startsWith('var(--color-') ? value : fallback);
};

/** The global :focus-visible outline: var(--focus-ring, accent), set by the nearest ancestor. */
const focusRingOf = async (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const ring = await utilityStyleAt(node, '--focus-ring', 1280);
        if (ring) {
            return themeHex(ring);
        }
    }
    return themeHex('--color-accent');
};

const luminance = (hex: string) => {
    const channel = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
};

const contrast = (a: string, b: string) => {
    expect(
        [a, b].every((hex) => /^#[0-9a-f]{6}$/.test(hex)),
        `${a} on ${b}`,
    ).toBe(true);
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

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

/** The plans dialog, once its lazily loaded panel has mounted. */
const renderPricing = async (ui: ReactElement) => {
    render(ui);
    await screen.findByRole('dialog', { name: 'Plans' });
};

/** The review step: tick the auto-renewal box, then continue to Stripe. */
const agreeAndContinue = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('checkbox'));
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

    it('shows all four tiers', async () => {
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Free/, level: 3 })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Personal/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Teacher/ })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /^Academy/ })).toBeInTheDocument();
    });

    it('marks the plan the teacher is already on and offers no button for it', async () => {
        await renderPricing(<PricingDialog currentTier="teacher" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Teacher.*Current plan/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Choose Teacher' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose Academy' })).toBeInTheDocument();
    });

    it('marks Personal the same way for a solo subscriber, who can still move up', async () => {
        await renderPricing(<PricingDialog currentTier="personal" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /^Personal.*Current plan/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Choose Personal' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Choose Teacher' })).toBeInTheDocument();
    });

    it('defaults to annual and switches to monthly pricing on demand', async () => {
        const user = userEvent.setup();
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);

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

    it('sells the roster at one price however many students there are', async () => {
        // 'Unlimited students' belongs to the Teacher card, pinned structurally in
        // tests/billing/limitsInSync.test.ts. The old "under $1 per student" line
        // stopped being true in euros (€21 / 20), so the card no longer prices
        // per head.
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getAllByText(/Unlimited students/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/one price, however many students/).length).toBeGreaterThan(0);
    });

    it('hides the Founding Teacher offer unless the flag is on', async () => {
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.queryByText(/Founding Teacher/)).not.toBeInTheDocument();
    });

    it('shows the Founding Teacher price when the flag is on', async () => {
        vi.stubEnv('VITE_STRIPE_FOUNDING_OFFER', 'true');
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByRole('heading', { name: /Founding Teacher/ })).toBeInTheDocument();
        expect(screen.getByText('$99')).toBeInTheDocument();
    });

    it('starts checkout with the selected price and the ticked consent, and redirects', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);

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
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Monthly' }));
        await user.click(screen.getByRole('button', { name: 'Choose Personal' }));
        await agreeAndContinue(user);

        expect(createCheckoutSession).toHaveBeenCalledWith('price_personal_monthly', expect.anything());
    });

    it('surfaces a checkout failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createCheckoutSession.mockRejectedValue(new Error('Stripe is down'));
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
        await agreeAndContinue(user);

        expect(await screen.findByText('Stripe is down')).toBeInTheDocument();
        expect(redirectTo).not.toHaveBeenCalled();
    });

    describe('before payment (launch items 13, 15, 17)', () => {
        it('keeps Continue disabled until the unticked auto-renewal box is ticked', async () => {
            const user = userEvent.setup();
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

            const box = await screen.findByRole('checkbox', { name: /renews automatically every year/ });
            expect(box).not.toBeChecked();
            expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
            await user.click(box);
            expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
        });

        it('names the trader, the price with tax, renewal, cancellation, the refund and the policies', async () => {
            const user = userEvent.setup();
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));

            expect(await screen.findByText(/Cleffy LLC, 245 East 37th Street/)).toBeInTheDocument();
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
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Monthly' }));
            await user.selectOptions(screen.getByLabelText('Prices for'), 'DE');

            expect(screen.getByText('€8')).toBeInTheDocument();
            expect(screen.getByText('€21')).toBeInTheDocument();
            expect(screen.getByText('€55')).toBeInTheDocument();
            expect(screen.getAllByText(/VAT incl\./).length).toBeGreaterThan(0);
        });

        it('prices in pounds for a buyer in the UK', async () => {
            const user = userEvent.setup();
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Monthly' }));
            await user.selectOptions(screen.getByLabelText('Prices for'), 'GB');

            expect(screen.getByText('£7')).toBeInTheDocument();
            expect(screen.getByText('£18')).toBeInTheDocument();
            expect(screen.getByText('£45')).toBeInTheDocument();
        });

        it('asks for the box again after the country, and so the price, changes', async () => {
            const user = userEvent.setup();
            createCheckoutSession.mockResolvedValue('https://checkout.stripe.com/session');
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
            await user.click(await screen.findByRole('checkbox'));
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

    it('explains itself rather than offering broken buttons when billing is unconfigured', async () => {
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
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);

        expect(screen.getByText(/Billing is not configured/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
    });

    it('says students never pay', async () => {
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(
            screen.getByText('Students never pay and never need an account — share links keep working on every plan.'),
        ).toBeInTheDocument();
    });

    describe('layout', () => {
        const PHONE_TABLET_DESKTOP = [390, 768, 844, 1440];

        const closeIsStickyAt = async (width: number) => {
            const dialog = screen.getByRole('dialog', { name: 'Plans' });
            for (
                let node = screen.getByRole('button', { name: 'Close' }).parentElement;
                node && node !== dialog;
                node = node.parentElement
            ) {
                if ((await utilityStyleAt(node, 'position', width)) === 'sticky') {
                    return true;
                }
            }
            return false;
        };

        it('keeps Close in reach while the plans scroll, at every width', async () => {
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            for (const width of PHONE_TABLET_DESKTOP) {
                expect(await closeIsStickyAt(width), `Close sticky at ${width}px`).toBe(true);
            }
        });

        it('keeps Close in reach while the review step scrolls, at every width', async () => {
            const user = userEvent.setup();
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
            await screen.findByRole('heading', { name: 'Review your Teacher subscription' });
            for (const width of PHONE_TABLET_DESKTOP) {
                expect(await closeIsStickyAt(width), `Close sticky at ${width}px`).toBe(true);
            }
        });

        it('sets the review title in the shared dialog title type', async () => {
            const user = userEvent.setup();
            await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
            await user.click(screen.getByRole('button', { name: 'Choose Teacher' }));
            const review = await screen.findByRole('heading', { name: 'Review your Teacher subscription' });
            const shared = screen.getByRole('heading', { name: 'Plans' });
            for (const width of PHONE_TABLET_DESKTOP) {
                for (const property of ['font-size', 'line-height', 'font-family', 'font-weight', 'letter-spacing']) {
                    expect(await utilityStyleAt(review, property, width), `${property} at ${width}px`).toBe(
                        await utilityStyleAt(shared, property, width),
                    );
                }
                expect(await utilityStyleAt(review, 'font-size', width)).toBe('28px');
            }
        });
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
        await renderPricing(
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

    it('does not sell the Founding price beside a subscription the portal cannot switch onto it', async () => {
        await renderPricing(
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
        await renderPricing(
            <PricingDialog currentTier="personal" subscription={{ endsAt, cancelling: true }} onClose={vi.fn()} />,
        );

        expect(screen.getByText(`Ends ${new Date(endsAt).toLocaleDateString()} — it won’t renew.`)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Resume subscription' }));
        expect(createPortalSession).toHaveBeenCalledTimes(1);
    });

    it('surfaces a portal failure instead of redirecting', async () => {
        const user = userEvent.setup();
        createPortalSession.mockRejectedValue(new Error('Portal is down'));
        await renderPricing(
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

    describe('plan cards', () => {
        /** The card a plan heading sits in. */
        const cardOf = (name: RegExp) => {
            const card = screen.getByRole('heading', { name, level: 3 }).closest('section');
            expect(card).not.toBeNull();
            return card as HTMLElement;
        };

        it('sets the current plan as the one dark card, labelled and with nothing to buy', async () => {
            await renderPricing(
                <PricingDialog
                    currentTier="teacher"
                    subscription={{ endsAt: null, cancelling: false }}
                    onClose={vi.fn()}
                />,
            );
            const current = cardOf(/^Teacher/);
            expect(within(current).getAllByText(/Current plan/).length).toBeGreaterThan(0);
            expect(within(current).queryByRole('button')).not.toBeInTheDocument();
            expect(await utilityStyleAt(current, 'background-color', 1280)).toBe('var(--color-ink)');
            for (const other of [/^Free/, /^Personal/, /^Academy/]) {
                expect(await utilityStyleAt(cardOf(other), 'background-color', 1280)).not.toBe('var(--color-ink)');
            }
        });

        it('keeps Resume subscription on a cancelling current card', async () => {
            await renderPricing(
                <PricingDialog
                    currentTier="personal"
                    subscription={{ endsAt: null, cancelling: true }}
                    onClose={vi.fn()}
                />,
            );
            const current = cardOf(/^Personal/);
            expect(within(current).getByRole('button', { name: 'Resume subscription' })).toBeInTheDocument();
            expect(within(current).queryByRole('button', { name: /Switch to|Choose/ })).not.toBeInTheDocument();
        });

        it('rings keyboard focus at 3:1 or better against every card it sits on', async () => {
            await renderPricing(
                <PricingDialog
                    currentTier="personal"
                    subscription={{ endsAt: null, cancelling: true }}
                    onClose={vi.fn()}
                />,
            );
            const buttons = screen.getAllByRole('heading', { level: 3 }).flatMap((heading) => {
                const card = heading.closest('section') as HTMLElement;
                return within(card)
                    .queryAllByRole('button')
                    .map((button) => [card, button] as const);
            });
            expect(buttons.some(([, button]) => button.textContent === 'Resume subscription')).toBe(true);
            for (const [card, button] of buttons) {
                const background = await colourOf(card, 'background-color', '--color-paper');
                const ring = await focusRingOf(button);
                expect(contrast(ring, background), `${button.textContent} focus ring`).toBeGreaterThanOrEqual(3);
            }
        });

        it('offers Choose on every other card', async () => {
            await renderPricing(<PricingDialog currentTier="personal" onClose={vi.fn()} />);
            expect(within(cardOf(/^Teacher/)).getByRole('button', { name: 'Choose Teacher' })).toBeInTheDocument();
            expect(within(cardOf(/^Academy/)).getByRole('button', { name: 'Choose Academy' })).toBeInTheDocument();
        });
    });

    it('still sells through Checkout to a seated teacher, whose Academy is not theirs to switch', async () => {
        await renderPricing(<PricingDialog currentTier="academy" subscription={null} onClose={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Choose Teacher' })).toBeInTheDocument();
    });
});

describe('PricingDialog terms', () => {
    beforeEach(configurePrices);

    afterEach(() => {
        cleanup();
        vi.unstubAllEnvs();
    });

    it('links the Terms and Privacy Policy in a new tab and says plans renew', async () => {
        await renderPricing(<PricingDialog currentTier="free" onClose={vi.fn()} />);
        expect(screen.getByText(/renew automatically until you cancel/)).toBeInTheDocument();
        const terms = screen.getByRole('link', { name: 'Terms of Service' });
        expect(terms).toHaveAttribute('href', '/terms');
        expect(terms).toHaveAttribute('target', '_blank');
        expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    });
});
