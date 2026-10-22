/**
 * What a buyer is told before they pay, and what they are sent afterwards: the
 * trader's identity, the price of each plan in each currency we sell in, the
 * auto-renewal consent wording, and the purchase / cancellation emails.
 *
 * ONE copy, read by both halves. The pricing dialog imports it (the way
 * src/features/imslp/popularWorks.ts imports its list from here), and so do
 * stripe-checkout and stripe-webhook. That is what makes the consent record
 * mean something: the checkout function rebuilds the wording from the plan and
 * currency it is about to charge and refuses a checkout whose wording differs
 * from what the dialog showed, so the text stored in `checkout_consents` is,
 * byte for byte, the text the buyer ticked.
 *
 * NO imports, for the reason stripeMode.ts gives: Deno loads this with the
 * `.ts` extension and vitest and Vite without it.
 *
 * Legal basis for the shape of the wording (summarised, not legal advice — the
 * final text is with counsel):
 *  * California BPC §17602 and New York GBL §527-a: before an automatic-renewal
 *    purchase, a clear and conspicuous statement that the subscription renews
 *    until cancelled, the recurring charge and how often it is made, the length
 *    of the renewal term, any minimum purchase obligation, and how to cancel —
 *    and the buyer's affirmative consent to exactly that (the checkbox).
 *  * EU Consumer Rights Directive arts. 6 and 8 / UK CCR 2013: trader identity
 *    and address, total price including taxes, the 14-day right of withdrawal
 *    and the model withdrawal form, all before the order and again on a durable
 *    medium (the confirmation email) afterwards.
 */

export type Currency = 'usd' | 'eur' | 'gbp';

export const CURRENCIES: readonly Currency[] = ['usd', 'eur', 'gbp'];

/** Same keys as stripeMode.ts's PriceCatalog — re-declared because this module takes no imports. */
export type PlanSlot =
    | 'personalMonthly'
    | 'personalAnnual'
    | 'teacherMonthly'
    | 'teacherAnnual'
    | 'academyMonthly'
    | 'academyAnnual'
    | 'foundingAnnual';

export const PLAN_SLOTS: readonly PlanSlot[] = [
    'personalMonthly',
    'personalAnnual',
    'teacherMonthly',
    'teacherAnnual',
    'academyMonthly',
    'academyAnnual',
    'foundingAnnual',
];

export type RenewalInterval = 'month' | 'year';

/**
 * The trader, as the buyer must be told it before paying.
 *
 * TEMPORARY MIRROR of `src/features/legal/legalEntity.ts` as Session B's
 * mh/launch-legal-pages restructures it (Cleffy LLC, the New York address, the
 * three mailboxes). The Edge Functions cannot import from src/, so a server copy
 * is needed either way; once B lands, a sync test belongs beside this one.
 */
export const TRADER = {
    name: 'Cleffy LLC',
    /** A New York limited liability company (formation pending). */
    description: 'a New York limited liability company',
    addressLines: ['245 East 37th Street, Apt 3E', 'New York, NY 10016', 'United States'],
    legalEmail: 'legal@cleffy.io',
    privacyEmail: 'privacy@cleffy.io',
    supportEmail: 'support@cleffy.io',
    website: 'cleffy.io',
} as const;

export const traderAddress = (): string => TRADER.addressLines.join(', ');

/*
 * The policy versions a buyer agrees to are NOT restated here: checkout and the
 * confirmation email read them from _shared/legalVersions.ts, the one server
 * source the legal pages also publish from (src/features/legal/legalVersions.ts
 * is held equal to it by legalVersions.test.ts). They arrive through `deps`, so
 * this file stays import-free.
 */

/** Bumped whenever autoRenewalConsentText changes shape, so old records stay interpretable. */
export const CONSENT_WORDING_VERSION = 'auto-renewal-v1';

/** Public paths on the storefront, named once so the dialog, emails and tests agree. */
export const BILLING_PATHS = {
    cancel: '/cancel',
    terms: '/terms',
    refunds: '/refunds',
    account: '/account',
} as const;

/** The full-refund window every buyer gets, worldwide, on their first purchase. */
export const REFUND_WINDOW_DAYS = 14;

/**
 * EU member states plus the rest of the EEA, as ISO 3166-1 alpha-2. Every one of
 * them is sold to in euros, including those whose own currency is not the euro:
 * three storefront currencies is the launch decision, and a buyer in Sweden or
 * Poland paying in EUR is ordinary for a SaaS.
 */
export const EUR_COUNTRIES: readonly string[] = [
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
    // EEA, outside the EU
    'IS',
    'LI',
    'NO',
];

/** Countries whose buyers get the statutory 14-day withdrawal right and its model form. */
export const hasStatutoryWithdrawalRight = (country: string | null | undefined): boolean => {
    const code = normalizeCountry(country);
    return code !== null && (code === 'GB' || EUR_COUNTRIES.includes(code));
};

/** Upper-cased two-letter code, or null for anything that is not one. */
export const normalizeCountry = (country: string | null | undefined): string | null => {
    const code = country?.trim().toUpperCase() ?? '';
    return /^[A-Z]{2}$/.test(code) ? code : null;
};

/** EUR for the EU/EEA, GBP for the UK, USD for everyone else. */
export const currencyForCountry = (country: string | null | undefined): Currency => {
    const code = normalizeCountry(country);
    if (code === 'GB') {
        return 'gbp';
    }
    return code !== null && EUR_COUNTRIES.includes(code) ? 'eur' : 'usd';
};

/**
 * Whether the listed price already contains tax. EUR and GBP are sold
 * VAT-inclusive — the price on the card is what the buyer pays — and USD is
 * sold tax-exclusive, with US sales tax added by Stripe Tax from the billing
 * address. This must agree with each price's `tax_behavior` in Stripe
 * (scripts/stripe/configure-tax.mjs sets it).
 */
export const TAX_INCLUSIVE: Record<Currency, boolean> = { usd: false, eur: true, gbp: true };

/**
 * Prices in minor units (cents, pence).
 *
 * Monthly prices are the launch decision: USD 7/19/49, EUR 8/21/55, GBP 7/18/45.
 * The ANNUAL EUR/GBP figures, and the Founding Teacher price outside USD, are
 * PROPOSALS pending Max's confirmation — "two months free" (ten times monthly)
 * like the USD annual prices, and Founding at roughly the USD discount. They are
 * only display until the matching `currency_options` exist on the Stripe price;
 * Stripe charges what the price says, so the two must be kept equal.
 */
export const PLAN_PRICES: Record<PlanSlot, Record<Currency, number>> = {
    personalMonthly: { usd: 700, eur: 800, gbp: 700 },
    personalAnnual: { usd: 7000, eur: 8000, gbp: 7000 },
    teacherMonthly: { usd: 1900, eur: 2100, gbp: 1800 },
    teacherAnnual: { usd: 19000, eur: 21000, gbp: 18000 },
    academyMonthly: { usd: 4900, eur: 5500, gbp: 4500 },
    academyAnnual: { usd: 49000, eur: 55000, gbp: 45000 },
    foundingAnnual: { usd: 9900, eur: 10900, gbp: 9500 },
};

export const PLAN_NAMES: Record<PlanSlot, string> = {
    personalMonthly: 'Personal',
    personalAnnual: 'Personal',
    teacherMonthly: 'Teacher',
    teacherAnnual: 'Teacher',
    academyMonthly: 'Academy',
    academyAnnual: 'Academy',
    foundingAnnual: 'Founding Teacher',
};

export const PLAN_INTERVALS: Record<PlanSlot, RenewalInterval> = {
    personalMonthly: 'month',
    personalAnnual: 'year',
    teacherMonthly: 'month',
    teacherAnnual: 'year',
    academyMonthly: 'month',
    academyAnnual: 'year',
    foundingAnnual: 'year',
};

const SYMBOLS: Record<Currency, string> = { usd: '$', eur: '€', gbp: '£' };

/**
 * `€21`, `$7.50`, `£1,234`. Hand-rolled rather than Intl.NumberFormat because
 * the consent wording is compared byte for byte between a browser and Deno, and
 * two ICU builds are free to disagree about spacing and symbol placement.
 */
export const formatMoney = (minor: number, currency: Currency): string => {
    const whole = Math.floor(Math.abs(minor) / 100);
    const cents = Math.abs(minor) % 100;
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const sign = minor < 0 ? '-' : '';
    return `${sign}${SYMBOLS[currency]}${grouped}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
};

/** How a price relates to tax, in the words the buyer reads next to it. */
export const taxPhrase = (currency: Currency): string =>
    TAX_INCLUSIVE[currency] ? 'VAT included' : 'plus any applicable sales tax';

/** "per month" / "per year". */
export const intervalPhrase = (interval: RenewalInterval): string => (interval === 'month' ? 'per month' : 'per year');

/** Everything about one purchase that the buyer is told before paying. */
export interface PurchaseTerms {
    slot: PlanSlot;
    currency: Currency;
    planName: string;
    interval: RenewalInterval;
    amountMinor: number;
    /** `€21` */
    price: string;
    taxInclusive: boolean;
}

export const purchaseTermsFor = (slot: PlanSlot, currency: Currency): PurchaseTerms => {
    const amountMinor = PLAN_PRICES[slot][currency];
    return {
        slot,
        currency,
        planName: PLAN_NAMES[slot],
        interval: PLAN_INTERVALS[slot],
        amountMinor,
        price: formatMoney(amountMinor, currency),
        taxInclusive: TAX_INCLUSIVE[currency],
    };
};

/**
 * The sentence the checkbox stands for, and the exact string stored as consent.
 *
 * Every element CA BPC §17602(a)(1) and NY GBL §527-a list is in it: continues
 * until cancelled, the charge and its frequency, the renewal term, no minimum
 * obligation, and how to cancel. The price comes first and with its tax
 * treatment, because "the amount that will be charged" is what both statutes
 * make the clear-and-conspicuous point.
 */
export const autoRenewalConsentText = (terms: PurchaseTerms): string => {
    const every = terms.interval === 'month' ? 'month' : 'year';
    const tax = terms.taxInclusive ? '(VAT included)' : '(plus any applicable sales tax, shown before you pay)';
    return (
        `I agree that my Cleffy ${terms.planName} subscription renews automatically every ${every} ` +
        `and that ${TRADER.name} will charge ${terms.price} ${tax} to my payment method every ${every} ` +
        'until I cancel. There is no minimum term. I can cancel at any time from my Account page or at ' +
        `${TRADER.website}${BILLING_PATHS.cancel}; cancelling stops the next renewal and I keep access ` +
        'until the end of the period I have paid for.'
    );
};

/** The refund promise, as one sentence for the dialog, Checkout and the emails. */
export const REFUND_SUMMARY =
    `Changed your mind? You get a full refund if you ask within ${REFUND_WINDOW_DAYS} days of your first ` +
    `purchase — just email ${TRADER.supportEmail} or tick the refund box when you cancel.`;

/**
 * The statutory withdrawal right, for buyers in the EU and UK. Placeholder text:
 * the final wording (and Annex A of the Refund Policy) is with counsel.
 */
export const WITHDRAWAL_SUMMARY =
    'If you live in the EU or UK, you also have a legal right to withdraw from this contract within 14 days ' +
    'of the day you subscribe, without giving any reason. To withdraw, tell us clearly — by email to ' +
    `${TRADER.supportEmail} or using the model withdrawal form in our Refund Policy — before the 14 days ` +
    'are up. We refund every payment you made for the subscription within 14 days of hearing from you, ' +
    'using the same payment method.';

/**
 * The model withdrawal form, after Annex I(B) of Directive 2011/83/EU and
 * Schedule 3 of the UK Consumer Contracts Regulations 2013. Sent in full in
 * every confirmation email so the buyer has it on a durable medium.
 */
export const MODEL_WITHDRAWAL_FORM = [
    'Model withdrawal form',
    '(Complete and return this form only if you wish to withdraw from the contract.)',
    '',
    `To: ${TRADER.name}, ${traderAddress()}, ${TRADER.supportEmail}`,
    '',
    'I hereby give notice that I withdraw from my contract for the supply of the following service:',
    'Cleffy subscription — plan: ____________________',
    'Ordered on: ____________________',
    'Name of consumer: ____________________',
    'Address of consumer: ____________________',
    'Email address used for Cleffy: ____________________',
    'Date: ____________________',
    '(Signature of consumer, only if this form is notified on paper)',
].join('\n');

/** The paragraph-level facts the dialog shows before the checkbox (item 15 of the launch packet). */
export const preCheckoutFacts = (terms: PurchaseTerms): string[] => [
    `${terms.price} ${intervalPhrase(terms.interval)}, ${taxPhrase(terms.currency)}` +
        (terms.taxInclusive ? '.' : ' (calculated from your billing address and shown before you pay).'),
    `Renews automatically every ${terms.interval} until you cancel. No minimum term.`,
    `Cancel any time from your Account page or at ${TRADER.website}${BILLING_PATHS.cancel} — you keep access until ` +
        'the end of the period you have paid for.',
    REFUND_SUMMARY,
];

/** The short line Stripe Checkout shows above its Pay button (`custom_text.submit`, max 1200 chars). */
export const checkoutSubmitMessage = (terms: PurchaseTerms): string =>
    `Renews automatically every ${terms.interval} at ${terms.price} (${taxPhrase(terms.currency)}) until you ` +
    `cancel at ${TRADER.website}${BILLING_PATHS.cancel} or from your Account page. Full refund within ` +
    `${REFUND_WINDOW_DAYS} days of your first purchase.`;

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export interface BillingEmail {
    subject: string;
    text: string;
    html: string;
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/** Plain paragraphs to the minimal HTML Resend sends beside the text part. */
const htmlFrom = (paragraphs: string[]): string =>
    paragraphs
        .map((paragraph) => `<p style="margin:0 0 12px">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');

const traderBlock = (): string =>
    [`${TRADER.name}, ${TRADER.description}`, traderAddress(), `${TRADER.supportEmail} · ${TRADER.website}`].join('\n');

/** `20 October 2026, 23:05 UTC` — UTC because the server has no idea of the reader's zone. */
export const formatUtc = (epochMs: number): string => {
    const date = new Date(epochMs);
    const months = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
    ];
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hh}:${mm} UTC`;
};

export const formatUtcDate = (epochMs: number): string => formatUtc(epochMs).replace(/, \d{2}:\d{2} UTC$/, '');

export interface PurchaseEmailInput {
    planName: string;
    interval: RenewalInterval;
    currency: Currency;
    /** What Stripe charged today, tax included (session.amount_total). */
    amountTotalMinor: number;
    /** The tax inside that total (session.total_details.amount_tax), when Stripe says. */
    amountTaxMinor: number | null;
    /**
     * The plan's regular price per interval -- what each renewal charges once
     * any promotion is over (the consent's amount_minor). Null when unknown.
     */
    recurringAmountMinor: number | null;
    /** A promotion code's discount on today's charge (session.total_details.amount_discount). */
    amountDiscountMinor: number | null;
    /** When it next renews (seconds → ms), when known. */
    renewsAtMs: number | null;
    purchasedAtMs: number;
    /** The storefront origin, for links: https://cleffy.io */
    origin: string;
    termsVersion: string;
    refundsVersion: string;
}

/** Sent on checkout.session.completed: the durable-medium confirmation of the contract. */
export const purchaseConfirmationEmail = (input: PurchaseEmailInput): BillingEmail => {
    const total = formatMoney(input.amountTotalMinor, input.currency);
    const tax =
        input.amountTaxMinor !== null && input.amountTaxMinor > 0
            ? ` (including ${formatMoney(input.amountTaxMinor, input.currency)} tax)`
            : TAX_INCLUSIVE[input.currency]
              ? ' (VAT included)'
              : '';
    const cancelUrl = `${input.origin}${BILLING_PATHS.cancel}`;
    const discounted = input.amountDiscountMinor !== null && input.amountDiscountMinor > 0;
    const renewalPrice =
        input.recurringAmountMinor !== null
            ? `${formatMoney(input.recurringAmountMinor, input.currency)} ${intervalPhrase(input.interval)} ` +
              `(${taxPhrase(input.currency)})`
            : "the plan's regular price";
    const paragraphs = [
        `Thank you for subscribing to Cleffy ${input.planName}.`,
        [
            `Plan: ${input.planName}, billed ${input.interval === 'month' ? 'monthly' : 'yearly'}`,
            `Charged today: ${total}${tax}`,
            discounted
                ? `Discount applied today: ${formatMoney(input.amountDiscountMinor ?? 0, input.currency)}`
                : null,
            `Purchased: ${formatUtc(input.purchasedAtMs)}`,
            input.renewsAtMs !== null ? `Next renewal: ${formatUtcDate(input.renewsAtMs)}` : null,
        ]
            .filter((line): line is string => line !== null)
            .join('\n'),
        `Your subscription renews automatically every ${input.interval} at ${renewalPrice}, charged to the ` +
            'payment method you used today, until you cancel. There is no minimum term.' +
            // Codex minor 1 on #62: "at the same price" was wrong whenever a
            // promotion code discounted the first charge.
            (discounted
                ? ' Today’s charge includes a promotional discount, which applies only for as long as your ' +
                  'promotion code states; after that, each renewal is charged at the regular price above.'
                : ''),
        `To cancel, visit ${cancelUrl} (no sign-in needed) or use "Manage billing" on your Account page. ` +
            'Cancelling stops the next renewal; you keep access until the end of the period you have paid for.',
        REFUND_SUMMARY,
        WITHDRAWAL_SUMMARY,
        MODEL_WITHDRAWAL_FORM,
        `You agreed to our Terms of Service (version ${input.termsVersion}) and Refund Policy (version ` +
            `${input.refundsVersion}): ${input.origin}${BILLING_PATHS.terms} and ${input.origin}${BILLING_PATHS.refunds}.`,
        traderBlock(),
    ];
    return {
        subject: `Your Cleffy ${input.planName} subscription`,
        text: paragraphs.join('\n\n'),
        html: htmlFrom(paragraphs),
    };
};

export interface CancellationEmailInput {
    planName: string | null;
    /** When the cancellation was made. */
    cancelledAtMs: number;
    /** When access ends (the end of the paid period), when known. */
    endsAtMs: number | null;
    origin: string;
}

/** Sent when a subscription is set to cancel, whichever route set it (portal or /cancel). */
export const cancellationConfirmationEmail = (input: CancellationEmailInput): BillingEmail => {
    const plan = input.planName ? `Cleffy ${input.planName}` : 'Cleffy';
    const paragraphs = [
        `Your ${plan} subscription has been cancelled.`,
        [
            `Cancelled: ${formatUtc(input.cancelledAtMs)}`,
            input.endsAtMs !== null
                ? `Access until: ${formatUtc(input.endsAtMs)} — you will not be charged again.`
                : 'You will not be charged again.',
        ].join('\n'),
        `Changed your mind? You can resume it before then from your Account page (${input.origin}${BILLING_PATHS.account}).`,
        REFUND_SUMMARY,
        'If you did not cancel this yourself, reply to this email straight away.',
        traderBlock(),
    ];
    return {
        subject: `Your ${plan} subscription is cancelled`,
        text: paragraphs.join('\n\n'),
        html: htmlFrom(paragraphs),
    };
};

/**
 * The signed-out cancel link (the "magic link" of item 19). `expiresAtMs` is the link's own expiry, fixed when
 * it was asked for (billing_mail_outbox.link_expires_at): the email names that
 * moment rather than a duration, so it stays true for a link the mail budget
 * held back, and stays byte-identical on every retry of the row.
 */
export const cancelLinkEmail = (link: string, expiresAtMs: number): BillingEmail => {
    const paragraphs = [
        'Someone — hopefully you — asked to cancel the Cleffy subscription for this email address.',
        `Open this link to review and cancel it. It works once, until ${formatUtc(expiresAtMs)}:\n${link}`,
        'If you did not ask for this, you can ignore this email: nothing changes until the link is used.',
        traderBlock(),
    ];
    return { subject: 'Cancel your Cleffy subscription', text: paragraphs.join('\n\n'), html: htmlFrom(paragraphs) };
};

export interface RefundRequestInput {
    userId: string;
    email: string;
    subscriptionId: string;
    planName: string | null;
    mode: string;
    firstPurchaseAtMs: number | null;
    requestedAtMs: number;
    /**
     * The account is being deleted (launch-fix item 16): the cancel page left
     * the subscription alone, because the deletion cancels it.
     */
    accountDeletionPending?: boolean;
}

/** To support@: a buyer asked for the 14-day refund while cancelling. Reply-To is the buyer. */
export const refundRequestEmail = (input: RefundRequestInput): BillingEmail => {
    const paragraphs = [
        `A customer asked for the ${REFUND_WINDOW_DAYS}-day full refund while cancelling.`,
        [
            `Email: ${input.email}`,
            `User id: ${input.userId}`,
            `Subscription: ${input.subscriptionId} (${input.mode})`,
            `Plan: ${input.planName ?? 'unknown'}`,
            `First purchase: ${input.firstPurchaseAtMs !== null ? formatUtc(input.firstPurchaseAtMs) : 'unknown'}`,
            `Requested: ${formatUtc(input.requestedAtMs)}`,
        ].join('\n'),
        ...(input.accountDeletionPending
            ? [
                  'This account is being deleted. The cancel page did not change the subscription, because the deletion cancels it.',
              ]
            : []),
        'Refund the payment(s) in the Stripe dashboard and reply to the customer (Reply-To is set to them).',
    ];
    return {
        subject: `[support] Refund request — ${input.email}`,
        text: paragraphs.join('\n\n'),
        html: htmlFrom(paragraphs),
    };
};

/** Whether a first purchase at `firstPurchaseAtMs` is still inside the refund window at `nowMs`. */
export const withinRefundWindow = (firstPurchaseAtMs: number | null, nowMs: number): boolean =>
    firstPurchaseAtMs !== null && nowMs - firstPurchaseAtMs <= REFUND_WINDOW_DAYS * 24 * 60 * 60_000;
