#!/usr/bin/env node
/**
 * Bring a Stripe account's catalogue in line with what checkout now asks of it
 * (launch packet items 16 and 17):
 *
 *  * every Cleffy product carries a product tax code, so Stripe Tax knows what
 *    it is taxing (SaaS, personal or business use);
 *  * every price's own USD amount is `tax_behavior: exclusive` -- US sales tax
 *    is added on top, from the billing address;
 *  * every price carries `currency_options` for EUR and GBP at the launch
 *    prices in supabase/functions/_shared/billingTerms.ts, with
 *    `tax_behavior: inclusive` -- the price on the card is what a European or
 *    British buyer pays, VAT included.
 *
 * Checkout charges the currency_options entry for the currency the consent
 * named (checkoutFlow.ts passes `currency`), so this must run before the EUR /
 * GBP storefront is switched on, or Stripe refuses the session.
 *
 * DRY RUN by default: prints what it would change. `--apply` makes the changes.
 * Refuses a live key unless `--live` is also given -- this is test-mode tooling
 * first, and the live run is Max's step, after reviewing the dry run's output.
 *
 *   STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe/configure-tax.mjs
 *   STRIPE_SECRET_KEY=sk_test_… node --experimental-strip-types scripts/stripe/configure-tax.mjs --apply
 *   STRIPE_SECRET_KEY=sk_live_… node --experimental-strip-types scripts/stripe/configure-tax.mjs --live --apply
 *
 * The key is read from the environment and never printed.
 *
 * Stripe refuses to change a price's tax_behavior once it is set to something
 * other than `unspecified`. A price already set the wrong way is reported, not
 * worked around: it needs a new price (and a PUBLISHED_PRICES change), which is
 * a decision for a human, not for this script.
 */

import { URLSearchParams } from 'node:url';

import { PLAN_PRICES, TAX_INCLUSIVE } from '../../supabase/functions/_shared/billingTerms.ts';
import { PUBLISHED_PRICES } from '../../supabase/functions/_shared/stripeMode.ts';

/**
 * Stripe product tax codes. Personal is a consumer product; Teacher and Academy
 * are sold to teaching businesses. PROPOSED -- confirm with the accountant.
 */
const TAX_CODES = {
    personal: 'txcd_10103000', // Software as a service (SaaS) - personal use
    teacher: 'txcd_10103001', // Software as a service (SaaS) - business use
    academy: 'txcd_10103001',
};

const SLOT_TIER = {
    personalMonthly: 'personal',
    personalAnnual: 'personal',
    teacherMonthly: 'teacher',
    teacherAnnual: 'teacher',
    academyMonthly: 'academy',
    academyAnnual: 'academy',
    foundingAnnual: 'teacher',
};

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const allowLive = args.has('--live');

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
    console.error('Set STRIPE_SECRET_KEY (a test-mode key, sk_test_… or rk_test_…).');
    process.exit(1);
}
const live = /^[a-z]+_live_/.test(key);
if (live && !allowLive) {
    console.error('Refusing a live-mode key without --live. Run against the sandbox first.');
    process.exit(1);
}
const mode = live ? 'live' : 'test';

const form = (params, prefix = '', out = new URLSearchParams()) => {
    for (const [name, value] of Object.entries(params)) {
        const field = prefix ? `${prefix}[${name}]` : name;
        if (value !== null && typeof value === 'object') {
            form(value, field, out);
        } else if (value !== undefined) {
            out.append(field, String(value));
        }
    }
    return out;
};

const stripe = async (method, path, params) => {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params ? form(params) : undefined,
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`${method} ${path}: ${body.error?.message ?? response.status}`);
    }
    return body;
};

const problems = [];
const changes = [];
const seenProducts = new Set();

for (const [slot, priceId] of Object.entries(PUBLISHED_PRICES[mode])) {
    if (!priceId) {
        continue;
    }
    const price = await stripe('GET', `prices/${priceId}?expand[]=product&expand[]=currency_options`);
    const product = price.product;
    const tier = SLOT_TIER[slot];

    if (product && !seenProducts.has(product.id)) {
        seenProducts.add(product.id);
        if (product.tax_code !== TAX_CODES[tier] && product.tax_code?.id !== TAX_CODES[tier]) {
            changes.push([`products/${product.id}`, { tax_code: TAX_CODES[tier] }, `${product.name}: tax code`]);
        }
    }

    const update = {};
    if (price.currency !== 'usd') {
        problems.push(`${slot} (${priceId}) is priced in ${price.currency}, expected usd`);
        continue;
    }
    if (price.unit_amount !== PLAN_PRICES[slot].usd) {
        problems.push(
            `${slot} (${priceId}) charges ${price.unit_amount}, billingTerms.ts says ${PLAN_PRICES[slot].usd}`,
        );
    }
    if (price.tax_behavior === 'unspecified') {
        update.tax_behavior = 'exclusive';
    } else if (price.tax_behavior !== 'exclusive') {
        problems.push(
            `${slot} (${priceId}) is tax_behavior=${price.tax_behavior}; USD must be exclusive (needs a new price)`,
        );
    }

    for (const currency of ['eur', 'gbp']) {
        const wanted = {
            unit_amount: PLAN_PRICES[slot][currency],
            tax_behavior: TAX_INCLUSIVE[currency] ? 'inclusive' : 'exclusive',
        };
        const existing = price.currency_options?.[currency];
        if (!existing) {
            update.currency_options = { ...update.currency_options, [currency]: wanted };
        } else if (existing.unit_amount !== wanted.unit_amount || existing.tax_behavior !== wanted.tax_behavior) {
            if (existing.tax_behavior !== 'unspecified' && existing.tax_behavior !== wanted.tax_behavior) {
                problems.push(
                    `${slot} ${currency}: tax_behavior=${existing.tax_behavior}, wanted ${wanted.tax_behavior} (needs a new price)`,
                );
            } else {
                update.currency_options = { ...update.currency_options, [currency]: wanted };
            }
        }
    }

    if (Object.keys(update).length > 0) {
        changes.push([`prices/${priceId}`, update, `${slot}`]);
    }
}

console.log(`Stripe ${mode} catalogue: ${changes.length} change(s), ${problems.length} problem(s).`);
for (const [path, params, label] of changes) {
    console.log(`  ${apply ? 'APPLY' : 'would'} ${label}: POST /v1/${path} ${form(params).toString()}`);
    if (apply) {
        await stripe('POST', path, params);
    }
}
for (const problem of problems) {
    console.log(`  PROBLEM ${problem}`);
}
if (!apply && changes.length > 0) {
    console.log('Dry run. Re-run with --apply to make these changes.');
}
process.exit(problems.length > 0 ? 2 : 0);
