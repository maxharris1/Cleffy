import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { LegalLinks } from '@/features/legal/LegalLinks';

const SPACING_PX = 4;

const coarse = (className: string, pattern: RegExp) => {
    const match = className.match(pattern);
    if (!match) {
        throw new Error(`no ${pattern} in "${className}"`);
    }
    return Number(match[1]) * SPACING_PX;
};

describe('LegalLinks', () => {
    it('leaves room between wrapped rows for both rows’ expanded touch targets', () => {
        render(
            <MemoryRouter>
                <LegalLinks withContact />
            </MemoryRouter>,
        );

        const privacy = screen.getByRole('link', { name: 'Privacy' });
        const line = privacy.parentElement as HTMLElement;
        const rowGap = coarse(line.className, /pointer-coarse:gap-y-(\d+(?:\.\d+)?)(?:\s|$)/);
        for (const link of screen.getAllByRole('link')) {
            const reach = coarse(link.className, /pointer-coarse:after:-inset-y-(\d+(?:\.\d+)?)(?:\s|$)/);
            expect(rowGap).toBeGreaterThanOrEqual(2 * reach);
        }
    });
});
