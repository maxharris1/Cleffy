import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '@/app/routes';

const SESSION = {
    user: { id: 'teacher-1', email: 'teacher@example.com', is_anonymous: false, user_metadata: {} },
};

/** The session the mocked useSession returns: registered unless a test says otherwise. */
const auth = vi.hoisted(() => ({ signedOut: false }));

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: auth.signedOut ? null : SESSION, loading: false, lastEvent: null }),
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

// The demo's viewer is pdf.js and the ink stack; the route's job is only to reach it.
vi.mock('@/features/demo/DemoViewer', () => ({
    DemoViewer: ({ bytes }: { bytes: ArrayBuffer }) => <div>demo-viewer:{bytes.byteLength}</div>,
}));

/** Prints the router's current URL, so a test can see it was not redirected. */
const LocationProbe = () => {
    const { pathname, search } = useLocation();
    return <div data-testid="location">{`${pathname}${search}`}</div>;
};

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
        ['/refunds', 'Refund Policy'],
        ['/copyright', 'Copyright and Content Policy'],
        ['/report', 'Report content'],
        ['/account-deleted', 'Your account is deleted'],
        ['/account-deleted?guest=1', 'Your guest profile is deleted'],
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

describe('AppRoutes /try demo', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n').buffer;

    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(pdf.slice(0), { status: 200 })),
        );
    });

    afterEach(() => {
        cleanup();
        auth.signedOut = false;
        vi.unstubAllGlobals();
    });

    it.each([
        ['signed out', true],
        ['signed in', false],
    ])('opens the demo for a visitor who is %s, with no redirect', async (_label, signedOut) => {
        auth.signedOut = signedOut;
        render(
            <MemoryRouter initialEntries={['/try?utm_source=tiktok&utm_campaign=launch']}>
                <AppRoutes />
                <LocationProbe />
            </MemoryRouter>,
        );

        expect(await screen.findByText(`demo-viewer:${pdf.byteLength}`)).toBeInTheDocument();
        expect(screen.queryByText('library-shell')).not.toBeInTheDocument();
        // The URL stays /try, query string and all.
        expect(screen.getByTestId('location')).toHaveTextContent('/try?utm_source=tiktok&utm_campaign=launch');
        expect(document.title).toBe('Try Cleffy');
    });

    it('restores the page title on the way out', async () => {
        document.title = 'Cleffy';
        const { unmount } = render(
            <MemoryRouter initialEntries={['/try']}>
                <AppRoutes />
            </MemoryRouter>,
        );
        await screen.findByText(/demo-viewer:/);
        expect(document.title).toBe('Try Cleffy');
        unmount();
        expect(document.title).toBe('Cleffy');
    });
});

describe('AppRoutes /try demo, score unavailable', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('says the score could not load, and Try again fetches it again', async () => {
        vi.resetModules();
        const { AppRoutes: FreshRoutes } = await import('@/app/routes');
        const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n').buffer;
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(new Response(pdf, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        render(
            <MemoryRouter initialEntries={['/try']}>
                <FreshRoutes />
            </MemoryRouter>,
        );

        expect(
            await screen.findByRole('heading', { level: 2, name: 'Couldn’t load the demo score' }),
        ).toBeInTheDocument();
        expect(screen.getByText('Check your connection, then try again.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByText(/demo-viewer:/)).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not blame the connection when the score itself is missing', async () => {
        vi.resetModules();
        const { AppRoutes: FreshRoutes } = await import('@/app/routes');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('Not found', { status: 404 })),
        );
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        render(
            <MemoryRouter initialEntries={['/try']}>
                <FreshRoutes />
            </MemoryRouter>,
        );

        expect(
            await screen.findByText('The demo score didn’t load. Try again, or come back in a minute.'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/connection|offline/i)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
});
