import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CancelPage } from '@/features/billing/CancelPage';
import { LinkUnavailable } from '@/features/share/ShareLinkPage';
import { features } from '@/lib/features';

import { functionRows } from './featureMapRows';

const SIGNED_OUT_PAGES: Record<string, ComponentType> = {
    '/cancel': CancelPage,
    '/invite': LinkUnavailable,
};

const ROUTE_CLAIM = /`(\/[^`]*)` shows (.*?)(?:, and |;|$)/g;

const claims = functionRows().flatMap((row) =>
    [...row.smokeCheck.matchAll(ROUTE_CLAIM)].flatMap(([, route = '', shown = '']) => {
        const texts = [...shown.matchAll(/`([^`]+)`/g)].map(([, text = '']) => text);
        return texts.length > 0 ? [{ name: row.name, route, texts }] : [];
    }),
);

describe('verify-cleffy feature map route checks', () => {
    it('runs on the lane build, where Share v2 is off', () => {
        expect(features.shareV2).toBe(false);
    });

    it('names a page this test renders for every "`/route` shows `text`" claim', () => {
        expect(claims.map((claim) => claim.route).filter((route) => !(route in SIGNED_OUT_PAGES))).toEqual([]);
        expect(claims.length).toBeGreaterThan(0);
    });

    it.each(claims.filter((claim) => claim.route in SIGNED_OUT_PAGES))(
        '$name: $route shows what its row says, signed out',
        async ({ route, texts }) => {
            const Page = SIGNED_OUT_PAGES[route]!;
            render(
                <MemoryRouter initialEntries={[route]}>
                    <Routes>
                        <Route path={route} element={<Page />} />
                    </Routes>
                </MemoryRouter>,
            );
            for (const text of texts) {
                expect(await screen.findByText(text)).toBeInTheDocument();
            }
        },
    );
});
