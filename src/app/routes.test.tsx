import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '@/app/routes';

const SESSION = {
    user: { id: 'teacher-1', email: 'teacher@example.com', is_anonymous: false, user_metadata: {} },
};

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: SESSION, loading: false, lastEvent: null }),
    isRegisteredSession: (session: { user?: { is_anonymous?: boolean } } | null) =>
        Boolean(session && !session.user?.is_anonymous),
    userTypeOf: () => null,
    displayNameOf: () => 'Teacher',
}));

vi.mock('@/features/library/LibraryShell', () => ({
    LibraryShell: () => <div>library-shell</div>,
}));

vi.mock('@/features/library/LibraryPage', () => ({
    LibraryPage: () => <div>library-page</div>,
}));

describe('AppRoutes guest gate', () => {
    afterEach(cleanup);

    it('never paints the storefront for a registered session on /', async () => {
        render(
            <MemoryRouter initialEntries={['/']}>
                <AppRoutes />
            </MemoryRouter>,
        );

        expect(await screen.findByText('library-shell')).toBeInTheDocument();
        expect(screen.queryByText('Annotate scores on this device')).not.toBeInTheDocument();
    });
});

describe('AppRoutes public pages', () => {
    afterEach(cleanup);

    it.each([
        ['/privacy', 'Privacy Policy'],
        ['/terms', 'Terms of Service'],
    ])('renders %s whatever the session', async (path, heading) => {
        render(
            <MemoryRouter initialEntries={[path]}>
                <AppRoutes />
            </MemoryRouter>,
        );
        expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
        expect(screen.queryByText('library-shell')).not.toBeInTheDocument();
    });
});
