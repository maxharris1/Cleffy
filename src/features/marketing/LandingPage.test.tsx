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
    it('links to register and login', () => {
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        expect(screen.getByText('Cleffy')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/register');
        expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    });
});
