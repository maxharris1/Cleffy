// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
    autoRenewalConsentText,
    cancellationConfirmationEmail,
    checkoutSubmitMessage,
    currencyForCountry,
    EUR_COUNTRIES,
    formatMoney,
    hasStatutoryWithdrawalRight,
    LEGAL_VERSIONS,
    MODEL_WITHDRAWAL_FORM,
    PLAN_PRICES,
    PLAN_SLOTS,
    purchaseConfirmationEmail,
    purchaseTermsFor,
    TAX_INCLUSIVE,
    TRADER,
    withinRefundWindow,
} from '../../supabase/functions/_shared/billingTerms';
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
        renewsAtMs: Date.parse('2026-11-20T12:00:00Z'),
        purchasedAtMs: Date.parse('2026-10-20T12:00:00Z'),
        origin: 'https://cleffy.io',
        termsVersion: LEGAL_VERSIONS.terms,
        refundsVersion: LEGAL_VERSIONS.refunds,
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
