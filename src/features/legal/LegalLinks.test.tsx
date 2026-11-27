import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { LegalLinks } from '@/features/legal/LegalLinks';

const SPACING_PX = 4;

const TERMS_AT_12PX_WIDTH_PX = 34.488;

const coarseHitWidth = (className: string, textWidth: number) => {
    const match = className.match(
        /pointer-coarse:after:inset-x-\[min\(-(\d+(?:\.\d+)?)px,calc\(50%-(\d+(?:\.\d+)?)px\)\)\](?:\s|$)/,
    );
    if (!match) {
        throw new Error(`no coarse inset-x in "${className}"`);
    }
    const inset = Math.min(-Number(match[1]), textWidth / 2 - Number(match[2]));
    return textWidth - 2 * inset;
};

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

    it.each(['paper', 'ink'] as const)('gives every %s link a coarse hit area at least 44px wide', (tone) => {
        render(
            <MemoryRouter>
                <LegalLinks tone={tone} withContact />
            </MemoryRouter>,
        );

        for (const link of screen.getAllByRole('link')) {
            expect(coarseHitWidth(link.className, TERMS_AT_12PX_WIDTH_PX)).toBeGreaterThanOrEqual(44);
        }
    });

    it('sets the ink line in 13px type at 1.9 leading, with spaced separators', () => {
        render(
            <MemoryRouter>
                <LegalLinks tone="ink" withContact />
            </MemoryRouter>,
        );

        const line = screen.getByRole('link', { name: 'Privacy' }).parentElement as HTMLElement;
        expect(line).toHaveClass('text-[13px]', 'leading-[1.9]');
        const separators = line.querySelectorAll('span[aria-hidden="true"]');
        expect(separators).toHaveLength(6);
        for (const separator of separators) {
            expect(separator.textContent).toBe(' · ');
        }
    });
});
