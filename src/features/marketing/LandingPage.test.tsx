import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LandingPage } from '@/features/marketing/LandingPage';

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
