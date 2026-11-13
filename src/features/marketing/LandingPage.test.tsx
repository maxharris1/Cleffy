import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
    cleanup();
    flags.playalong = false;
    flags.fingering = false;
});

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
            expect(link).toHaveAttribute('href', '/register?utm_campaign=launch_v1&utm_source=newsletter');
        }
        expect(webEvents.track).not.toHaveBeenCalled();

        fireEvent.click(registerLinks[1]!);

        expect(screen.getByText('Sign-up page')).toBeInTheDocument();
        expect(webEvents.track).toHaveBeenCalledTimes(1);
        expect(webEvents.track).toHaveBeenCalledWith('signup_click');
    });

    it('renders the hero with register and login links', () => {
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getAllByText('Cleffy').length).toBeGreaterThan(0);
        expect(
            screen.getByRole('heading', { level: 1, name: 'Annotate scores together, in real time' }),
        ).toBeInTheDocument();
        const registerLinks = screen.getAllByRole('link', { name: 'Start free' });
        expect(registerLinks).toHaveLength(3);
        for (const link of registerLinks) {
            expect(link).toHaveAttribute('href', '/register');
        }
        expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
        // The demo is offered quietly beside Start free, never as a second primary.
        const tryLink = screen.getByRole('link', { name: 'Try it — no sign-up' });
        expect(tryLink).toHaveAttribute('href', '/try');
        expect(tryLink).not.toHaveClass('landing-cta');
        expect(screen.getByText('Or open a PDF locally — no account')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: 'Main' })).toHaveClass('safe-landing-nav');
        expect(screen.getByRole('navigation', { name: 'Main' }).parentElement).toHaveClass('safe-landing-gutter');
    });

    it('shows the pricing reassurance and no showcase for features this release does not ship', () => {
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getByText('Free for 3 cloud scores · plans from $7/month')).toBeInTheDocument();
        // Play-along and fingering are switched off: nothing on the page may sell them.
        expect(screen.queryByRole('heading', { level: 2, name: 'More than markings' })).not.toBeInTheDocument();
        expect(screen.queryByText(/play-along|playhead|fingering/i)).not.toBeInTheDocument();
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
});
