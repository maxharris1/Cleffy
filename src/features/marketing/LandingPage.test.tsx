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

afterEach(() => {
    cleanup();
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
    });

    it('shows the pricing reassurance and the practice-tools showcase', () => {
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getByText('Free for 3 cloud scores · plans from $7/month')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'More than markings' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: 'Practice one hand at a time' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: 'Fingering, read from the score' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'What Cleffy does' })).toBeInTheDocument();
    });
});
