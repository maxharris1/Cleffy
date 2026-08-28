import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CATALOG_KEYS,
    MODES,
    PUBLISHED_PRICES,
    type PriceCatalog,
    type StripeMode,
} from '../../supabase/functions/_shared/stripeMode';

/**
 * Drift guard.
 *
 * The Stripe catalogue exists in two places by necessity: `.env.production`
 * feeds the browser bundle, which has to name the price it checks out, and
 * PUBLISHED_PRICES in the Edge Functions is the server-side allowlist that
 * decides whether that price is one of ours. If they drift, every upgrade
 * button 400s with "Unknown price" — and only in production, because local dev
 * reads the same `.env` for both halves.
 *
 * Since the live flip there are two of each: cleffy.io sells from the live
 * catalogue and dev.cleffy.io from the sandbox. Both pairs are checked here, and
 * so are the two catalogues against each other — a sandbox id left in the live
 * column is the version of this mistake that reaches a customer.
 *
 * `.env.production` is parsed as text because it is not TypeScript; the server
 * catalogue is imported, because `stripeMode.ts` is deliberately import-free and
 * loads under vitest unchanged.
 */

const ENV_PRODUCTION = resolve(process.cwd(), '.env.production');

/** catalogue key -> the shared half of the env var carrying the same price. */
const ENV_SUFFIX: Record<keyof PriceCatalog, string> = {
    personalMonthly: 'PERSONAL_MONTHLY',
    personalAnnual: 'PERSONAL_ANNUAL',
    teacherMonthly: 'TEACHER_MONTHLY',
    teacherAnnual: 'TEACHER_ANNUAL',
    academyMonthly: 'ACADEMY_MONTHLY',
    academyAnnual: 'ACADEMY_ANNUAL',
    foundingAnnual: 'FOUNDING_ANNUAL',
};

const viteName = (mode: StripeMode, key: keyof PriceCatalog): string =>
    `VITE_STRIPE_${mode.toUpperCase()}_PRICE_${ENV_SUFFIX[key]}`;

const envValues = (source: string): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const line of source.split('\n')) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        const key = match?.[1];
        const value = match?.[2];
        if (key && value !== undefined) {
            values[key] = value.trim();
        }
    }
    return values;
};

const client = envValues(readFileSync(ENV_PRODUCTION, 'utf8'));
const keys = [...CATALOG_KEYS];

describe.each(MODES)('the %s catalogue matches the shipped client', (mode) => {
    it.each(keys)('%s is the same price id on both sides', (key) => {
        expect(PUBLISHED_PRICES[mode][key]).toBe(client[viteName(mode, key)]);
    });

    it('publishes all seven prices and nothing else', () => {
        expect(Object.keys(PUBLISHED_PRICES[mode]).sort()).toEqual([...keys].sort());
    });

    it('carries real Stripe price ids, never placeholders', () => {
        for (const key of keys) {
            expect(PUBLISHED_PRICES[mode][key]).toMatch(/^price_[A-Za-z0-9]+$/);
        }
    });

    it('gives every tier a distinct price', () => {
        const ids = keys.map((key) => PUBLISHED_PRICES[mode][key]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('ships no price the other mode also claims', () => {
        const other = mode === 'live' ? 'test' : 'live';
        const theirs = new Set(keys.map((key) => PUBLISHED_PRICES[other][key]));
        for (const key of keys) {
            expect(theirs.has(PUBLISHED_PRICES[mode][key])).toBe(false);
        }
    });
});

describe('the client ships both catalogues', () => {
    // The bundle picks by hostname, so a mode missing from `.env.production`
    // means that storefront renders an upgrade dialog with no buttons.
    it.each(MODES)('%s prices are all present in .env.production', (mode) => {
        for (const key of keys) {
            expect(client[viteName(mode, key)]).toMatch(/^price_[A-Za-z0-9]+$/);
        }
    });
});
