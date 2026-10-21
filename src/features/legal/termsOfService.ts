import { aiFeatures } from '@/features/legal/aiFeatures';
import { list, p, placeholder, type LegalDocument, type LegalSection } from '@/features/legal/legalDocument';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';

/**
 * The Terms of Service, including the School Use Addendum, as data.
 *
 * Where the business has decided something (the operator, the age limits, the
 * 14-day refund, how schools buy) the terms say it; wording counsel still has
 * to settle is a `placeholder(...)` block. See docs/LEGAL_REVIEW.md.
 */

const { brand, name, legalForm, postalAddress, emails, website } = LEGAL_ENTITY;

const anyAiFeature = aiFeatures.smartImport || aiFeatures.fingering || aiFeatures.playalong;

const aiTerms: LegalSection[] = anyAiFeature
    ? [
          {
              id: 'ai-features',
              heading: 'AI features',
              blocks: [
                  p(
                      'Features that read your scores with AI can make mistakes. Review their results before relying on them; they are suggestions, not a substitute for your own judgement.',
                  ),
              ],
          },
      ]
    : [];

export const TERMS_OF_SERVICE: LegalDocument = {
    id: 'terms',
    title: 'Terms of Service',
    shortTitle: 'Terms',
    summary: `The agreement between you and ${name} for using ${website}, including the School Use Addendum for schools and districts.`,
    sections: [
        {
            id: 'agreement',
            heading: 'Agreement',
            blocks: [
                p(
                    `These terms are an agreement between you and ${name} (“we”, “us”), ${legalForm}, ${postalAddress}, about your use of ${brand}. By creating an account, opening a share link, or subscribing, you agree to them and to our Privacy Policy, Refund Policy, and Copyright and Content Policy, which form part of them. If you use ${brand} for a school or business, you agree on its behalf and confirm you may do so; a school or district that buys ${brand} under a contract also agrees to the School Use Addendum below.`,
                ),
            ],
        },
        {
            id: 'accounts',
            heading: 'Your account',
            blocks: [
                list(
                    'You must be at least 13 to create an account or join a score as a guest, or older where your country sets a higher age for agreeing to the use of your information online (up to 16 in some European countries). Students below that age may not use Cleffy yet.',
                    'Keep your password to yourself and tell us if you think someone else has used your account. You are responsible for what happens under it.',
                    'Give us an email address you can receive mail at; we use it for sign-in and important notices.',
                ),
            ],
        },
        {
            id: 'teachers',
            heading: 'Teachers and student accounts',
            blocks: [
                list(
                    'If you create student accounts, you confirm that each student meets the minimum age for their country and that you have the authority to create the account, including any consent required from parents, guardians or a school, and you are responsible for how those accounts are used.',
                    'Student accounts belong to your roster. Archiving a student removes their access; deleting a student removes the account and their markings on your scores; deleting your own account deletes the student accounts you created and their work on your scores.',
                ),
            ],
        },
        {
            id: 'your-content',
            heading: 'Your content',
            blocks: [
                p(
                    `You keep ownership of the scores you upload and the markings you make. You give us permission to store, copy, display, process and transmit them only as needed to run ${brand} for you and the people you share with${anyAiFeature ? ' — including sending content to the AI features you choose to use, as our Privacy Policy describes' : ''}.`,
                ),
                p(
                    'When you share a score, its collaborators see and, if they can edit, change its one shared set of markings. Markings that collaborators make on your score stay on it if they later leave or delete their accounts, and markings you make on someone else’s score stay on theirs.',
                ),
                p(
                    'Cleffy keeps your work in sync and available offline, but no service is infallible. Keep your own copies of anything you cannot afford to lose.',
                ),
            ],
        },
        {
            id: 'copyright',
            heading: 'Copyright and IMSLP',
            blocks: [
                list(
                    'Upload only scores you have the right to use. Many printed editions are protected by copyright even when the music is old.',
                    'Scores imported from IMSLP come with the licence and copyright information IMSLP provides. Whether a work is in the public domain depends on the country you are in; it is your responsibility to check before you use, print or share it.',
                    `If you believe something on ${brand} infringes your rights or is illegal, report it through the form at ${website}/report or write to ${emails.legal}. Our Copyright and Content Policy explains what happens next, how to send a counter-notice, and how we deal with repeat infringers.`,
                ),
            ],
        },
        {
            id: 'acceptable-use',
            heading: 'Acceptable use',
            blocks: [
                p('Do not use Cleffy to:'),
                list(
                    'break the law or infringe anyone’s rights;',
                    'upload malware, or anything designed to harm Cleffy or its users;',
                    'harass anyone, or share content that is abusive or inappropriate for a teaching setting;',
                    'get around plan limits, rate limits or security controls, or access accounts or scores that are not yours;',
                    'scrape, resell or bulk-download from Cleffy or IMSLP through Cleffy.',
                ),
                p(
                    'We may restrict or remove content, or suspend or close an account, that breaks these rules. When we do, we tell you why and how to challenge the decision, as our Copyright and Content Policy describes.',
                ),
            ],
        },
        {
            id: 'plans-and-billing',
            heading: 'Plans, billing and cancellation',
            blocks: [
                list(
                    'Paid plans are billed in advance, monthly, through Stripe, and renew automatically until you cancel. There is no minimum term. Prices in euros and pounds include VAT; prices in US dollars do not include sales tax, which is added at checkout where it applies. The total, including any tax, is shown before you pay.',
                    'You can cancel at any time from Manage subscription on the Account page. A cancelled plan stays active until the end of the period you have paid for, and is not charged again.',
                    `If you are not happy, you can ask for a full refund within 14 days of your first purchase. If you live in the EU, the EEA or the UK you also have a legal right to withdraw within 14 days. Our Refund Policy explains both, and includes a model withdrawal form.`,
                    // apply_free_tier_archival / restore_plan_archived_scores (20261007120300). Only a new
                    // entitlement un-archives (the Stripe webhook, or an Academy seat via
                    // studio_members_restore_plan_archived); the app has no owner unarchive action.
                    'If your plan ends or you move to a smaller one, nothing is deleted: scores beyond the new plan’s limits become read-only — you can still open them — until you upgrade again.',
                    'Deleting your account cancels your subscription immediately.',
                    `If you think you were charged in error, write to ${emails.support} and we will put it right.`,
                    'If we change our prices, we will tell you in advance, and the change will apply from your next billing period; you can cancel before then.',
                ),
            ],
        },
        ...aiTerms,
        {
            id: 'service',
            heading: 'Changes to Cleffy',
            blocks: [
                p(
                    'We are always improving Cleffy and may add, change or remove features. If we make a change that significantly reduces what a paid plan includes, we will tell you in advance.',
                ),
            ],
        },
        {
            id: 'ending',
            heading: 'Ending this agreement',
            blocks: [
                p(
                    'You can stop using Cleffy and delete your account at any time from the Account page. We may suspend or close an account that seriously or repeatedly breaks these terms — including an account that repeatedly uploads infringing material — or where the law requires it; where we reasonably can, we will tell you first and give you a chance to retrieve your content.',
                ),
            ],
        },
        {
            id: 'disclaimers',
            heading: 'Disclaimers and liability',
            blocks: [
                p(
                    'Cleffy is provided “as is” and “as available”. To the extent the law allows, we disclaim implied warranties, and we are not liable for indirect or consequential losses, or for loss of data you could have kept a copy of. Our total liability for any claim is limited to the amount you paid us in the twelve months before it arose. Nothing in these terms limits liability that cannot be limited by law, or your statutory rights as a consumer.',
                ),
                placeholder(
                    'Counsel to confirm the warranty disclaimer and liability cap for US, EU and UK consumers.',
                ),
            ],
        },
        {
            id: 'law',
            heading: 'Governing law and disputes',
            blocks: [
                placeholder(
                    'Counsel to set the governing law, courts and any dispute-resolution clause. Expected: the laws of the State of New York and the courts of New York County, without taking away any mandatory protection the law of your own country gives you as a consumer, or your right to bring proceedings in your home courts.',
                ),
            ],
        },
        {
            id: 'school-addendum',
            heading: 'School Use Addendum',
            blocks: [
                p(
                    `This addendum applies when a school, district or other educational institution (“the school”) buys ${brand} for its teachers and students under an order form or invoice from us. Where it conflicts with the rest of these terms, it wins for that school.`,
                ),
                list(
                    'Ordering and seats: the school’s order form sets the price, the number of teacher seats and the term. We invoice through Stripe and the school pays by the due date on the invoice. Seats beyond those ordered need an updated order.',
                    'Roles: the school decides how its students’ information is used, and we process it on the school’s behalf, only to provide Cleffy to the school and for no other purpose. For US schools, we act as a “school official” with a legitimate educational interest under FERPA, under the school’s direct control for the use and maintenance of education records.',
                    'Age and authority: teachers confirm, for each student they add, that the student meets the minimum age for their country, and the school is responsible for any consent or notice its students and their parents must be given.',
                    'Student information is never sold, never used for advertising or to build profiles unrelated to the school’s use of Cleffy, and never used to train artificial-intelligence models.',
                    'Our service providers are those listed in our Privacy Policy. We tell the school before adding one that receives student information.',
                    'Security: we protect student information as our Privacy Policy describes, and tell the school without undue delay if we learn of a breach that affects it.',
                    'Access and deletion: the school can ask us to give it, correct or delete its students’ information at any time. When the school’s contract ends, we delete its data 30 days later, unless the school asks us to return it first or the law requires us to keep it.',
                ),
                placeholder(
                    'Counsel to complete the addendum: data-processing terms for EU/UK schools (GDPR Art. 28), any state student-privacy law terms (for example California SOPIPA, New York Education Law §2-d), payment terms, term and termination, and the order of precedence with a school’s own contract.',
                ),
            ],
        },
        {
            id: 'changes',
            heading: 'Changes to these terms',
            blocks: [
                p(
                    'We may update these terms. We will change the date and version at the top and, for significant changes, tell you by email or in the app before they take effect. If you keep using Cleffy after that, the new terms apply.',
                ),
            ],
        },
        {
            id: 'contact',
            heading: 'Contact',
            blocks: [
                p(
                    `Questions about these terms: ${emails.support}, or by post to ${name}, ${postalAddress}. Legal notices: ${emails.legal}.`,
                ),
            ],
        },
    ],
};
