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

    it('renders the landing page on /', () => {
        render(<App />);
        expect(screen.getAllByText('Cleffy').length).toBeGreaterThan(0);
        expect(screen.getByText('Annotate scores on this device')).toBeInTheDocument();
        expect(screen.getByText('Open a PDF')).toBeInTheDocument();
    });
});
