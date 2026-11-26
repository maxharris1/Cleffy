import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LandingPage } from '@/features/marketing/LandingPage';

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => false,
}));

afterEach(cleanup);

describe('LandingPage (local-only)', () => {
    it('keeps the landing CTA look on "Open a score", not the app primary button', () => {
        render(
            <MemoryRouter>
                <LandingPage />
            </MemoryRouter>,
        );
        const cta = screen.getByText('Open a score', { selector: 'label' });
        expect(cta).toHaveClass('landing-cta', 'font-medium', 'px-5', 'py-3', 'rounded-xl', 'text-white');
        for (const cls of cta.classList) {
            expect(cls).not.toMatch(/^(font-semibold|shadow-|bg-|border-|min-h-)/);
        }
    });
});
