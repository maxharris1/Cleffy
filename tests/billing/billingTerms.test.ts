// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    autoRenewalConsentText,
    cancellationConfirmationEmail,
    checkoutSubmitMessage,
    currencyForCountry,
    EUR_COUNTRIES,
    formatMoney,
    hasStatutoryWithdrawalRight,
    MODEL_WITHDRAWAL_FORM,
    PLAN_PRICES,
    PLAN_SLOTS,
    purchaseConfirmationEmail,
    purchaseTermsFor,
    TAX_INCLUSIVE,
    TRADER,
    withinRefundWindow,
} from '../../supabase/functions/_shared/billingTerms';
import { LEGAL_OPERATOR, LEGAL_VERSIONS } from '../../supabase/functions/_shared/legalVersions';
import { CATALOG_KEYS } from '../../supabase/functions/_shared/stripeMode';

/**
 * The words a buyer is shown before paying and sent afterwards. Most of this
 * is the launch decisions written down as assertions, so a change to a price
 * or to the wording is a change someone has to make on purpose.
 */

describe('prices', () => {
    it('sells the launch monthly prices in each currency', () => {
        // USD 7/19/49, EUR 8/21/55, GBP 7/18/45 (launch packet, item 17).
        expect(PLAN_PRICES.personalMonthly).toEqual({ usd: 700, eur: 800, gbp: 700 });
        expect(PLAN_PRICES.teacherMonthly).toEqual({ usd: 1900, eur: 2100, gbp: 1800 });
        expect(PLAN_PRICES.academyMonthly).toEqual({ usd: 4900, eur: 5500, gbp: 4500 });
    });

    it('keeps the USD annual and Founding prices the storefront already sells', () => {
        expect(PLAN_PRICES.personalAnnual.usd).toBe(7000);
        expect(PLAN_PRICES.teacherAnnual.usd).toBe(19000);
        expect(PLAN_PRICES.academyAnnual.usd).toBe(49000);
        expect(PLAN_PRICES.foundingAnnual.usd).toBe(9900);
    });

    it('prices every catalogue slot, so no plan can be offered without a price', () => {
        expect([...PLAN_SLOTS].sort()).toEqual([...CATALOG_KEYS].sort());
    });

    it('is VAT-inclusive in EUR and GBP and tax-exclusive in USD', () => {
        expect(TAX_INCLUSIVE).toEqual({ usd: false, eur: true, gbp: true });
    });

    it('formats without depending on the ICU build', () => {
        expect(formatMoney(2100, 'eur')).toBe('€21');
        expect(formatMoney(750, 'usd')).toBe('$7.50');
        expect(formatMoney(123400, 'gbp')).toBe('£1,234');
    });
});

describe('currency by country', () => {
    it.each([
        ['GB', 'gbp'],
        ['gb', 'gbp'],
        ['DE', 'eur'],
        ['IE', 'eur'],
        ['NO', 'eur'],
        ['SE', 'eur'],
        ['US', 'usd'],
        ['CA', 'usd'],
        ['CH', 'usd'],
        [null, 'usd'],
        ['nonsense', 'usd'],
    ])('%s pays in %s', (country, currency) => {
        expect(currencyForCountry(country)).toBe(currency);
    });

    it('lists every EU member state and the EEA', () => {
        expect(EUR_COUNTRIES).toHaveLength(30);
        expect(new Set(EUR_COUNTRIES).size).toBe(30);
    });

    it('gives the statutory withdrawal right to the EU, the EEA and the UK only', () => {
        expect(hasStatutoryWithdrawalRight('FR')).toBe(true);
        expect(hasStatutoryWithdrawalRight('GB')).toBe(true);
        expect(hasStatutoryWithdrawalRight('US')).toBe(false);
    });
});

describe('the auto-renewal consent wording (CA BPC §17602 / NY GBL §527-a)', () => {
    const usd = autoRenewalConsentText(purchaseTermsFor('teacherMonthly', 'usd'));
    const eur = autoRenewalConsentText(purchaseTermsFor('academyAnnual', 'eur'));

    it('says it renews until cancelled, how much, how often, and how to cancel', () => {
        expect(usd).toContain('renews automatically every month');
        expect(usd).toContain('$19');
        expect(usd).toContain('until I cancel');
        expect(usd).toContain('There is no minimum term');
        expect(usd).toContain('cleffy.io/cancel');
        expect(usd).toContain(TRADER.name);
    });

    it('states the tax treatment of the price', () => {
        expect(usd).toContain('plus any applicable sales tax');
        expect(eur).toContain('€550 (VAT included)');
        expect(eur).toContain('every year');
    });

    it('fits on Stripe Checkout above the Pay button', () => {
        for (const slot of PLAN_SLOTS) {
            for (const currency of ['usd', 'eur', 'gbp'] as const) {
                expect(checkoutSubmitMessage(purchaseTermsFor(slot, currency)).length).toBeLessThanOrEqual(1200);
            }
        }
    });
});

describe('the purchase confirmation email', () => {
    const email = purchaseConfirmationEmail({
        planName: 'Teacher',
        interval: 'month',
        currency: 'gbp',
        amountTotalMinor: 1800,
        amountTaxMinor: 300,
        recurringAmountMinor: 1800,
        amountDiscountMinor: null,
        renewsAtMs: Date.parse('2026-11-20T12:00:00Z'),
        purchasedAtMs: Date.parse('2026-10-20T12:00:00Z'),
        origin: 'https://cleffy.io',
        termsVersion: LEGAL_VERSIONS.terms,
        refundsVersion: LEGAL_VERSIONS.refunds,
    });

    it('states the regular renewal price beside what was charged today', () => {
        expect(email.text).toContain('renews automatically every month at £18 per month (VAT included)');
        expect(email.text).not.toContain('at the same price');
        expect(email.text).not.toContain('promotional discount');
    });

    it('does not promise a discounted price will renew (Codex minor 1 on #62)', () => {
        const discounted = purchaseConfirmationEmail({
            planName: 'Teacher',
            interval: 'month',
            currency: 'usd',
            amountTotalMinor: 950,
            amountTaxMinor: null,
            recurringAmountMinor: 1900,
            amountDiscountMinor: 950,
            renewsAtMs: null,
            purchasedAtMs: Date.parse('2026-10-20T12:00:00Z'),
            origin: 'https://cleffy.io',
            termsVersion: LEGAL_VERSIONS.terms,
            refundsVersion: LEGAL_VERSIONS.refunds,
        });
        expect(discounted.text).toContain('Charged today: $9.50');
        expect(discounted.text).toContain('Discount applied today: $9.50');
        expect(discounted.text).toContain('at $19 per month (plus any applicable sales tax)');
        expect(discounted.text).toContain('each renewal is charged at the regular price above');
    });

    it('carries everything item 18 lists', () => {
        expect(email.text).toContain('Plan: Teacher, billed monthly');
        expect(email.text).toContain('£18 (including £3 tax)');
        expect(email.text).toContain('renews automatically every month');
        expect(email.text).toContain('https://cleffy.io/cancel');
        expect(email.text).toContain('Cleffy LLC');
        expect(email.text).toContain('245 East 37th Street');
        expect(email.text).toContain(`version ${LEGAL_VERSIONS.terms}`);
        expect(email.text).toContain('full refund if you ask within 14 days');
        expect(email.text).toContain('right to withdraw');
        expect(email.text).toContain(MODEL_WITHDRAWAL_FORM);
        expect(email.text).toContain('Next renewal: 20 November 2026');
    });

    it('escapes what it puts into HTML', () => {
        const hostile = cancellationConfirmationEmail({
            planName: '<script>x</script>',
            cancelledAtMs: 0,
            endsAtMs: null,
            origin: 'https://cleffy.io',
        });
        expect(hostile.html).not.toContain('<script>');
        expect(hostile.html).toContain('&lt;script&gt;');
    });
});

describe('the cancellation confirmation email', () => {
    it('gives the date and time of the cancellation and when access ends', () => {
        const email = cancellationConfirmationEmail({
            planName: 'Personal',
            cancelledAtMs: Date.parse('2026-10-20T23:05:00Z'),
            endsAtMs: Date.parse('2026-11-20T23:05:00Z'),
            origin: 'https://cleffy.io',
        });
        expect(email.text).toContain('Cancelled: 20 October 2026, 23:05 UTC');
        expect(email.text).toContain('Access until: 20 November 2026, 23:05 UTC');
    });
});

describe('the refund window', () => {
    const day = 24 * 60 * 60_000;
    it('is 14 days from the first purchase', () => {
        expect(withinRefundWindow(0, 14 * day)).toBe(true);
        expect(withinRefundWindow(0, 14 * day + 1)).toBe(false);
        expect(withinRefundWindow(null, 0)).toBe(false);
    });
});

describe('the legal versions checkout records', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

    it('come from the one server source, not a copy in billingTerms', () => {
        // Codex cross-PR minor 3: checkout carried a third copy of the policy
        // versions, so a bump to the published versions left consent records
        // and confirmation emails naming the old one.
        expect(read('supabase/functions/_shared/billingTerms.ts')).not.toMatch(/export const LEGAL_VERSIONS/);
        expect(read('supabase/functions/stripe-checkout/index.ts')).toContain(
            "import { LEGAL_VERSIONS } from '../_shared/legalVersions.ts';",
        );
        expect(read('supabase/functions/stripe-checkout/index.ts')).toContain('legalVersions: LEGAL_VERSIONS');
        expect(read('supabase/functions/_shared/billingMailWorker.ts')).toContain('legalVersions: LEGAL_VERSIONS');
        expect(read('supabase/functions/_shared/checkoutFlow.ts')).toContain('deps.legalVersions.terms');
        expect(LEGAL_VERSIONS.terms).toMatch(/^\d{4}-\d{2}-\d{2}(-draft)?$/);
        expect(LEGAL_VERSIONS.refunds).toMatch(/^\d{4}-\d{2}-\d{2}(-draft)?$/);
    });

    it('names the same trader as the legal pages', () => {
        expect(TRADER.name).toBe(LEGAL_OPERATOR.name);
        expect(TRADER.legalEmail).toBe(LEGAL_OPERATOR.legalEmail);
        expect(TRADER.privacyEmail).toBe(LEGAL_OPERATOR.privacyEmail);
        expect(TRADER.supportEmail).toBe(LEGAL_OPERATOR.supportEmail);
        expect(TRADER.website).toBe(LEGAL_OPERATOR.website);
        expect(LEGAL_OPERATOR.postalAddress).toContain(TRADER.addressLines[0]);
    });
});
