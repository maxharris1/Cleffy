import { form, list, p, placeholder, type LegalDocument } from '@/features/legal/legalDocument';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';

/**
 * The Refund Policy, with EU/UK withdrawal information and the model
 * withdrawal form (Annex A), as data.
 *
 * The business decision it states: everyone gets a full refund on request
 * within 14 days of their first purchase, and nobody is asked to waive the
 * EU/UK right of withdrawal. Because the refund is full, the withdrawal text
 * below has no "proportionate amount" clause for service already provided.
 * The withdrawal wording follows the model in Directive 2011/83/EU Annex I and
 * UK Consumer Contracts Regulations 2013 Schedule 3.
 */

const { brand, name, postalAddress, emails } = LEGAL_ENTITY;

export const REFUND_POLICY: LegalDocument = {
    id: 'refunds',
    title: 'Refund Policy',
    shortTitle: 'Refunds',
    summary: `When and how ${name} refunds a ${brand} subscription, and how customers in the EU, the EEA and the UK can withdraw from their purchase.`,
    sections: [
        {
            id: 'fourteen-days',
            heading: '14-day full refund',
            blocks: [
                p(
                    `Wherever you live, if you are not happy with ${brand}, you can ask for a full refund within 14 days of your first purchase of a paid plan. You do not need to give a reason, and you do not lose this right by using ${brand} during those 14 days.`,
                ),
                list(
                    `To ask, email ${emails.support} from the address on your account (or tell us that address), within 14 days of the day you first subscribed.`,
                    'We refund the full amount you paid, including tax, to the payment method you used, within 14 days of your request. Your bank may take a few more days to show it.',
                    'When we refund, your subscription is cancelled and your account returns to the free plan. Nothing is deleted: scores beyond the free plan’s limits become read-only until you subscribe again.',
                ),
                placeholder(
                    'Counsel to confirm how the 14-day refund applies to a later re-subscription, a plan change within the 14 days, and Academy studios with several teacher seats.',
                ),
            ],
        },
        {
            id: 'after-fourteen-days',
            heading: 'After 14 days',
            blocks: [
                list(
                    'You can cancel at any time from Manage subscription on the Account page. Your plan stays active until the end of the period you have paid for, and you are not charged again. There is no minimum term and no cancellation fee.',
                    'Renewal payments, and payments made more than 14 days after your first purchase, are not refunded, except where the law gives you a right to a refund or we charged you in error.',
                    `If you think you were charged in error, write to ${emails.support} and we will put it right.`,
                ),
            ],
        },
        {
            id: 'withdrawal',
            heading: 'Right of withdrawal (EU, EEA and UK consumers)',
            blocks: [
                p(
                    'If you are a consumer in the European Union, the European Economic Area or the United Kingdom, the law gives you the following right in addition to our 14-day refund. In practice the two work the same way.',
                ),
                p(
                    'You have the right to withdraw from this contract within 14 days without giving any reason. The withdrawal period will expire after 14 days from the day of the conclusion of the contract.',
                ),
                p(
                    `To exercise the right of withdrawal, you must inform us (${name}, ${postalAddress}, ${emails.support}) of your decision to withdraw from this contract by an unequivocal statement (for example a letter sent by post or an email). You may use the model withdrawal form below, but it is not obligatory.`,
                ),
                p(
                    'To meet the withdrawal deadline, it is sufficient for you to send your communication concerning your exercise of the right of withdrawal before the withdrawal period has expired.',
                ),
            ],
        },
        {
            id: 'effects-of-withdrawal',
            heading: 'Effects of withdrawal',
            blocks: [
                p(
                    'If you withdraw from this contract, we shall reimburse to you all payments received from you without undue delay and in any event not later than 14 days from the day on which we are informed about your decision to withdraw from this contract. We will carry out such reimbursement using the same means of payment as you used for the initial transaction, unless you have expressly agreed otherwise; in any event, you will not incur any fees as a result of such reimbursement.',
                ),
                p(
                    'We do not ask you to give up this right when you subscribe, and we do not keep back any amount for the days you used the service before withdrawing.',
                ),
            ],
        },
        {
            id: 'model-withdrawal-form',
            heading: 'Annex A — Model withdrawal form',
            blocks: [
                p('(Complete and return this form only if you wish to withdraw from the contract.)'),
                form(
                    `To: ${name}, ${postalAddress}, ${emails.support}`,
                    'I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract for the provision of the following service (*): a Cleffy subscription — plan: ____________',
                    'Ordered on (*) ____________',
                    'Name of consumer(s): ____________',
                    'Address of consumer(s): ____________',
                    'Email address of the Cleffy account: ____________',
                    'Signature of consumer(s) (only if this form is notified on paper): ____________',
                    'Date: ____________',
                    '(*) Delete as appropriate.',
                ),
            ],
        },
        {
            id: 'schools',
            heading: 'Schools and districts',
            blocks: [
                p(
                    'Subscriptions bought by a school or district under an order form and invoice are governed by that order form and the School Use Addendum in our Terms of Service.',
                ),
            ],
        },
        {
            id: 'your-rights',
            heading: 'Your other rights',
            blocks: [
                p(
                    'Nothing in this policy limits any right you have as a consumer under the law where you live, for example if the service is faulty or not as described.',
                ),
            ],
        },
        {
            id: 'contact',
            heading: 'Contact',
            blocks: [p(`Refunds and billing questions: ${emails.support}, or by post to ${name}, ${postalAddress}.`)],
        },
    ],
};
