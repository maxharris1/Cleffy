import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { LandingPage } from '@/features/marketing/LandingPage';

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
}));

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
        const registerLinks = screen.getAllByRole('link', { name: 'Create account' });
        expect(registerLinks.length).toBeGreaterThan(0);
        for (const link of registerLinks) {
            expect(link).toHaveAttribute('href', '/register');
        }
        expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    });
});
