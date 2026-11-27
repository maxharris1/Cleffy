import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { LimitReachedError } from '@/features/billing/limitErrors';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { SearchPage } from '@/features/library/SearchPage';

vi.mock('@/features/imslp/ImslpBrowser', () => ({ ImslpBrowser: () => null }));

const renderSearch = (quotaUpgradeHint: boolean) => {
    const context = {
        uploading: false,
        onUpload: vi.fn(),
        onImportImslp: vi.fn(),
        openPricing: vi.fn(),
        quotaExhausted: true,
        importLimit: 3,
        quotaUpgradeHint,
        limitNotice: new LimitReachedError({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' }),
    } as unknown as LibraryOutletContext;
    render(
        <MemoryRouter initialEntries={['/search']}>
            <Routes>
                <Route element={<Outlet context={context} />}>
                    <Route path="/search" element={<SearchPage />} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );
};

describe('SearchPage at the free plan’s score limit', () => {
    it.each([
        ['with the way to the plans', true],
        ['as the plain sentence', false],
    ])('keeps the amber notice, not the library’s outlined panel, %s', (_case, upgradeHint) => {
        renderSearch(upgradeHint);

        const notice = screen.getByRole('status');
        expect(notice).toHaveClass('border-amber-300/70', 'bg-amber-50/70');
        expect(notice).not.toHaveClass('border-panel-line');
    });
});
