import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { OlderLinksSection } from '@/features/share/owner/OlderLinksSection';
import { shareUrlFor } from '@/features/share/shareService';
import type { ShareLinkRow } from '@/types/database';

afterEach(cleanup);

const TOKEN = `${'a'.repeat(18)}bbbbbbbb`;

const link = {
    token: TOKEN,
    role: 'viewer',
    expires_at: null,
    revoked_at: null,
} as ShareLinkRow;

describe('OlderLinksSection', () => {
    it('wraps Copy and Revoke under a link whose ending needs the room on a phone', () => {
        render(<OlderLinksSection links={[link]} onChanged={async () => {}} />);

        const url = screen.getByTitle(shareUrlFor(TOKEN));
        expect(screen.getByText('bbbbbbbb')).toBeInTheDocument();
        expect(url).not.toHaveClass('min-w-0');

        const row = url.parentElement as HTMLElement;
        expect(row).toHaveClass('flex-wrap');
        expect(row).toContainElement(screen.getByRole('button', { name: 'Copy' }));
        expect(row).toContainElement(screen.getByRole('button', { name: 'Revoke' }));
    });
});
