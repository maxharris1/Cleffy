import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
 * Both files are parsed as text rather than imported: `_shared/stripe.ts` is
 * Deno source and its `npm:stripe@18` specifier does not resolve under vitest.
 */

const ROOT = process.cwd();
const SHARED_STRIPE = resolve(ROOT, 'supabase/functions/_shared/stripe.ts');
const ENV_PRODUCTION = resolve(ROOT, '.env.production');

/** camelCase catalogue key -> the client env var carrying the same price. */
const KEY_TO_VITE_ENV = {
    personalMonthly: 'VITE_STRIPE_PRICE_PERSONAL_MONTHLY',
    personalAnnual: 'VITE_STRIPE_PRICE_PERSONAL_ANNUAL',
    teacherMonthly: 'VITE_STRIPE_PRICE_TEACHER_MONTHLY',
    teacherAnnual: 'VITE_STRIPE_PRICE_TEACHER_ANNUAL',
    academyMonthly: 'VITE_STRIPE_PRICE_ACADEMY_MONTHLY',
    academyAnnual: 'VITE_STRIPE_PRICE_ACADEMY_ANNUAL',
    foundingAnnual: 'VITE_STRIPE_PRICE_FOUNDING_ANNUAL',
} as const;

type CatalogKey = keyof typeof KEY_TO_VITE_ENV;

/** Pulls the PUBLISHED_PRICES object literal out of the Deno source. */
const publishedPrices = (source: string): Record<string, string> => {
    const body = source.match(/PUBLISHED_PRICES:\s*PriceCatalog\s*=\s*\{([\s\S]*?)\};/);
    if (!body?.[1]) {
        throw new Error('could not find the PUBLISHED_PRICES literal in _shared/stripe.ts');
    }

    const prices: Record<string, string> = {};
    for (const pair of body[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
        const key = pair[1];
        const value = pair[2];
        if (key && value) {
            prices[key] = value;
        }
    }
    return prices;
};

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

describe('the Edge Function price catalogue matches the shipped client', () => {
    const server = publishedPrices(readFileSync(SHARED_STRIPE, 'utf8'));
    const client = envValues(readFileSync(ENV_PRODUCTION, 'utf8'));
    const keys = Object.keys(KEY_TO_VITE_ENV) as CatalogKey[];

    it.each(keys)('%s is the same price id on both sides', (key) => {
        expect(server[key]).toBe(client[KEY_TO_VITE_ENV[key]]);
    });

    it('publishes all seven prices and nothing else', () => {
        expect(Object.keys(server).sort()).toEqual([...keys].sort());
    });

    it('carries real Stripe price ids, never placeholders', () => {
        for (const key of keys) {
            expect(server[key]).toMatch(/^price_[A-Za-z0-9]+$/);
        }
    });

    it('gives every tier a distinct price', () => {
        const ids = keys.map((key) => server[key]);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the committed catalogue is overridable but never mergeable', () => {
    const source = readFileSync(SHARED_STRIPE, 'utf8');

    it('reads every price from a STRIPE_PRICE_* env var', () => {
        for (const viteKey of Object.values(KEY_TO_VITE_ENV)) {
            // The Edge Function name is the client name without the VITE_ prefix.
            expect(source).toContain(viteKey.replace('VITE_', ''));
        }
    });

    it('replaces the whole catalogue when any override is set', () => {
        // A per-key merge would let a half-finished live-mode flip serve live and
        // sandbox ids together; the flag makes it all-or-nothing. If this
        // assertion is what broke, re-read the comment above priceCatalog()
        // before "fixing" it.
        expect(source).toMatch(/return overridden \? fromEnv : \{ \.\.\.PUBLISHED_PRICES \}/);
    });
});
