import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/app/App';

describe('App', () => {
    beforeEach(() => {
        // Force local-only mode so the smoke test is deterministic regardless
        // of .env contents (no network, no auth loading states).
        vi.stubEnv('VITE_SUPABASE_URL', '');
        vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('renders the landing page on /', async () => {
        render(<App />);
        // The storefront is a lazy route: it arrives after the shell bundle.
        expect(await screen.findByText('Annotate scores on this device')).toBeInTheDocument();
        expect(screen.getAllByText('Cleffy').length).toBeGreaterThan(0);
        expect(screen.getByText('Open a score')).toBeInTheDocument();
    });
});
