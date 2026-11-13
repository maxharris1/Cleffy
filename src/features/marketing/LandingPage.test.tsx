import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lowestMonthlyPrice, priceFor, tierCards } from '@/features/billing/pricing';
import { LandingPage } from '@/features/marketing/LandingPage';

const webEvents = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@/lib/webEvents', () => webEvents);

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
}));

/** Release flags (src/lib/features.ts), flipped per test; read at render. */
const flags = vi.hoisted(() => ({ playalong: false, fingering: false, printHandwriting: false }));
vi.mock('@/lib/features', () => ({ features: flags }));

/** The buyer's country, as billingRegion guesses it; null is the US default. */
const region = vi.hoisted(() => ({ country: null as string | null }));
vi.mock('@/features/billing/billingRegion', () => ({ initialBillingCountry: () => region.country }));

/** The Google Docs comparison switch (landingConfig.ts), flipped per test. */
const docs = vi.hoisted(() => ({ show: true }));
vi.mock('@/features/marketing/landingConfig', () => ({
    get SHOW_DOCS_COMPARISON() {
        return docs.show;
    },
}));

/** The demo's preload is its own unit (demoPreload.test.ts); here only whether the links call it. */
const demo = vi.hoisted(() => ({ preloadDemo: vi.fn(() => Promise.resolve()) }));
vi.mock('@/features/demo/demoPreload', () => demo);

afterEach(() => {
    cleanup();
    flags.playalong = false;
    flags.fingering = false;
    region.country = null;
    docs.show = true;
    demo.preloadDemo.mockClear();
});

const renderLanding = (entry = '/') =>
    render(
        <MemoryRouter initialEntries={[entry]}>
            <LandingPage />
        </MemoryRouter>,
    );

const PLAN_TIERS = ['free', 'personal', 'teacher', 'academy'] as const;

describe('LandingPage (cloud)', () => {
    it('keeps the query on every Start free, and counts the click', () => {
        webEvents.track.mockReset();
        render(
            <MemoryRouter initialEntries={['/?utm_campaign=launch_v1&utm_source=newsletter']}>
                <Routes>
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/register" element={<p>Sign-up page</p>} />
                </Routes>
            </MemoryRouter>,
        );
        const registerLinks = screen.getAllByRole('link', { name: 'Start free' });
        expect(registerLinks).toHaveLength(3);
        for (const link of registerLinks) {
            expect(link).toHaveAttribute('href', '/register?utm_source=newsletter&utm_campaign=launch_v1');
        }
        expect(webEvents.track).not.toHaveBeenCalled();

        fireEvent.click(registerLinks[1]!);

        expect(screen.getByText('Sign-up page')).toBeInTheDocument();
        expect(webEvents.track).toHaveBeenCalledTimes(1);
        expect(webEvents.track).toHaveBeenCalledWith('signup_click');
    });

    it('carries only the utm_ tags on to /try and /register', () => {
        renderLanding('/?utm_source=newsletter&ref=friend&utm_medium=email&next=%2Flibrary');
        const links = [
            ...screen.getAllByRole('link', { name: 'Start free' }),
            ...screen.getAllByRole('link', { name: /Try it now|Open the live Für Elise demo/ }),
        ];
        expect(links).toHaveLength(6);
        for (const link of links) {
            const href = link.getAttribute('href') ?? '';
            expect(href).toMatch(/^\/(register|try)\?utm_source=newsletter&utm_medium=email$/);
        }
    });

    it('forwards the same utm_ tags that attribution records, even for a repeated key', () => {
        // parseUtm reads the first value of a key and drops it when invalid;
        // the links must not forward a later value attribution never stored.
        renderLanding('/?utm_source=bad%20value&utm_source=newsletter&utm_medium=email&utm_medium=social');
        for (const link of screen.getAllByRole('link', { name: /Start free|Try it now/ })) {
            expect(link.getAttribute('href')).toMatch(/^\/(register|try)\?utm_medium=email$/);
        }
    });

    it('renders the hero: the demo is the filled button, Start free the outline beside it', () => {
        renderLanding();
        expect(screen.getAllByText('Cleffy').length).toBeGreaterThan(0);
        expect(screen.getByRole('heading', { level: 1, name: 'Draw on Für Elise.' })).toBeInTheDocument();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

        const registerLinks = screen.getAllByRole('link', { name: 'Start free' });
        expect(registerLinks).toHaveLength(3);
        for (const link of registerLinks) {
            expect(link).toHaveAttribute('href', '/register');
            expect(link).toHaveClass('ink-button-line');
        }
        expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');

        // "Try it now" is the filled button in the hero and the closing band; the score is a third way in.
        const tryLinks = screen.getAllByRole('link', { name: 'Try it now' });
        expect(tryLinks).toHaveLength(2);
        for (const link of tryLinks) {
            expect(link).toHaveAttribute('href', '/try');
            expect(link).toHaveClass('ink-button-fill');
        }
        const scoreLink = screen.getByRole('link', { name: 'Open the live Für Elise demo' });
        expect(scoreLink).toHaveAttribute('href', '/try');
        expect(within(scoreLink).getByText('Click the score to draw on it')).toBeInTheDocument();
        expect(within(scoreLink).getByText('Tap the score to draw on it')).toBeInTheDocument();
        expect(within(scoreLink).queryByRole('link')).not.toBeInTheDocument();

        // Opening a PDF locally left the hero; the footer still offers it.
        expect(screen.queryByText('Or open a PDF locally — no account')).not.toBeInTheDocument();
        expect(screen.getByText('Open a score locally')).toBeInTheDocument();

        expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('safe-landing-nav');
        expect(screen.getByRole('navigation', { name: 'Main' }).parentElement).toHaveClass('safe-landing-gutter');
    });

    it('casts Ms. Davis and Leo, and no one retired', () => {
        renderLanding();
        expect(screen.getByText('Ms. Davis')).toBeInTheDocument();
        expect(screen.getByText('Leo')).toBeInTheDocument();
        expect(screen.getByText('Ms. Davis’s tablet')).toBeInTheDocument();
        expect(screen.getByText('Leo’s phone')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/Torres|Whitaker|\bAlex\b|iPad|Apple Pencil/);
    });

    it('warms the demo when a visitor reaches for it, and not before', () => {
        renderLanding();
        expect(demo.preloadDemo).not.toHaveBeenCalled();

        const [heroTry] = screen.getAllByRole('link', { name: 'Try it now' });
        fireEvent.pointerEnter(heroTry!);
        expect(demo.preloadDemo).toHaveBeenCalledTimes(1);

        fireEvent.focus(screen.getByRole('link', { name: 'Open the live Für Elise demo' }));
        fireEvent.touchStart(screen.getAllByRole('link', { name: 'Try it now' })[1]!);
        expect(demo.preloadDemo).toHaveBeenCalledTimes(3);
    });

    it('ends the price line with its tax treatment, in dollars', () => {
        renderLanding();
        expect(screen.getByText('Free for 3 cloud scores · plans from $7/month + tax')).toBeInTheDocument();
    });

    it('ends the price line with its tax treatment where VAT is included', () => {
        region.country = 'DE';
        renderLanding();
        expect(
            screen.getByText(`Free for 3 cloud scores · plans from ${lowestMonthlyPrice('eur')}/month, VAT incl.`),
        ).toBeInTheDocument();
    });

    it('prices the four plans from the same helpers as checkout', () => {
        region.country = 'GB';
        renderLanding();
        const plans = document.getElementById('plans');
        expect(plans).not.toBeNull();
        expect(within(plans!).getByRole('heading', { level: 2 })).toHaveTextContent(
            'Free to start. Students never pay.',
        );
        const cards = within(plans!).getAllByRole('listitem');
        expect(cards).toHaveLength(4);
        const named = tierCards(flags);
        PLAN_TIERS.forEach((tier, i) => {
            const card = cards[i]!;
            const price = priceFor(tier, 'monthly', 'gbp')!;
            expect(card).toHaveAttribute('data-tier', tier);
            expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(named[i]!.name);
            expect(within(card).getByText(price.amount, { selector: 'span' })).toBeInTheDocument();
            expect(within(card).getByText(price.caption)).toBeInTheDocument();
            expect(within(card).getByText(named[i]!.tagline)).toBeInTheDocument();
            if (tier !== 'free') {
                expect(price.caption).toMatch(/VAT incl\.$/);
            }
        });
        // The cards' feature lists stay in the pricing dialog.
        expect(within(plans!).queryByText(/AI page reads/)).not.toBeInTheDocument();
    });

    it('shows no showcase or offer for features this release does not ship', () => {
        renderLanding();
        // Play-along and fingering are switched off: nothing on the page may sell them.
        expect(screen.queryByRole('heading', { level: 2, name: 'More than markings' })).not.toBeInTheDocument();
        expect(screen.queryByText(/play-along|playhead|fingering|founding/i)).not.toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/play-along|playhead|fingering|founding/i);
        expect(screen.queryByText(/one hand at a time/i)).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'What Cleffy does' })).toBeInTheDocument();
    });

    it('shows the practice-tools showcase in a build that ships those features', () => {
        flags.playalong = true;
        flags.fingering = true;
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 2, name: 'More than markings' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: 'Practice one hand at a time' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: 'Fingering, read from the score' })).toBeInTheDocument();
    });

    it('shows only the vignette whose feature ships', () => {
        flags.fingering = true;
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { level: 3, name: 'Fingering, read from the score' })).toBeInTheDocument();
        expect(
            screen.queryByRole('heading', { level: 3, name: 'Practice one hand at a time' }),
        ).not.toBeInTheDocument();
    });

    it('keeps the Google Docs sentence and its trademark note together', () => {
        renderLanding();
        expect(screen.getByText(/If you’ve used Google Docs/)).toBeInTheDocument();
        expect(screen.getByText(/Google Docs is a trademark of Google LLC/)).toBeInTheDocument();
        for (const heading of screen.getAllByRole('heading')) {
            expect(heading.textContent).not.toMatch(/Google/);
        }
        cleanup();

        docs.show = false;
        renderLanding();
        expect(screen.queryByText(/Google/)).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'Everything’s shared now.' })).toBeInTheDocument();
    });

    it('says in words which things are shared, not only with ticks and a cross', () => {
        renderLanding();
        const list = screen.getByText('Your docs').closest('ul')!;
        const rows = within(list)
            .getAllByRole('listitem')
            .map((row) => row.textContent);
        expect(rows).toEqual([
            'Your docs: shared',
            'Your playlists: shared',
            'Your calendar: shared',
            'Your sheet music: not shared',
        ]);
    });

    it('keeps the age sentence word for word', () => {
        renderLanding();
        expect(
            screen.getByText(
                'People open it in any browser and type a name. No accounts, no installs. For ages 13 and up (older in some countries).',
            ),
        ).toBeInTheDocument();
    });

    it('turns the browser bar ink while it is up, and back to paper after', () => {
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.content = '#f7f5ef';
        document.head.append(meta);
        try {
            const { unmount } = renderLanding();
            expect(meta.content).toBe('#1c1917');
            expect(document.documentElement).toHaveClass('ink-landing-root');
            unmount();
            expect(meta.content).toBe('#f7f5ef');
            expect(document.documentElement).not.toHaveClass('ink-landing-root');
        } finally {
            meta.remove();
        }
    });
});
