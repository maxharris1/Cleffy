import { list, p, placeholder, type LegalDocument } from '@/features/legal/legalDocument';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import { REPEAT_INFRINGER_STRIKES, STRIKE_WINDOW_MONTHS } from '@/features/moderation/moderationRules';

/**
 * The Copyright, DMCA and Illegal-Content Policy, as data: how to report a
 * score, what a notice needs, what we do with it, and how the uploader can
 * challenge it.
 *
 * Describes the tooling in src/features/moderation and the content-report /
 * content-moderation Edge Functions: the report form (works signed out), the
 * emailed acknowledgment, the two takedown actions, the statement of reasons
 * sent to the uploader, and the strike count. Wording for the US DMCA (17
 * U.S.C. §512) and the EU Digital Services Act (Arts. 11–17, 20–21, 23) that
 * counsel still has to settle is marked as placeholders.
 */

const { brand, name, postalAddress, emails, website } = LEGAL_ENTITY;

export const COPYRIGHT_POLICY: LegalDocument = {
    id: 'copyright',
    title: 'Copyright and Content Policy',
    shortTitle: 'Copyright',
    summary: `How to report a score on ${brand} that infringes copyright or is illegal, what ${name} does with a report, and how to challenge a decision.`,
    // The form itself: src/features/moderation/ReportContentPage.tsx.
    action: { label: 'Report content', to: '/report' },
    sections: [
        {
            id: 'overview',
            heading: 'Overview',
            blocks: [
                p(
                    `${brand} hosts scores that its users upload. We do not check them before they are uploaded, but we act on reports. Anyone — with or without a ${brand} account — can tell us about a score they believe infringes copyright or is otherwise illegal, using the report form at ${website}/report or by writing to ${emails.legal}.`,
                ),
            ],
        },
        {
            id: 'reporting',
            heading: 'How to report',
            blocks: [
                p('Use the report form, or include the following in your email, so we can act quickly:'),
                list(
                    'Where the content is: the link to the score (it looks like cleffy.io/doc/…) or the share link you were given. Content we cannot locate, we cannot act on.',
                    'What is wrong with it, and why you believe it is illegal or infringing — enough for us to see that without a detailed legal examination.',
                    'Your name and email address, so we can confirm we received your report and tell you what we decided.',
                    'A statement that you believe in good faith that the information in your report is accurate and complete.',
                ),
                p(
                    'We email you a confirmation with a reference number when we receive your report, and tell you what we decided and why once we have reviewed it.',
                ),
            ],
        },
        {
            id: 'dmca-notice',
            heading: 'Copyright notices (DMCA)',
            blocks: [
                p(
                    'If you are a copyright owner, or authorised to act for one, a notice under the US Digital Millennium Copyright Act must include:',
                ),
                list(
                    'a physical or electronic signature of the person authorised to act on behalf of the owner (typing your full name in the report form is an electronic signature);',
                    'identification of the copyrighted work you say is infringed — for example the title, composer, arranger and edition;',
                    'identification of the material on Cleffy you say infringes it, and where it is (the score link);',
                    'your name, address, telephone number and email address;',
                    'a statement that you have a good-faith belief that the use is not authorised by the copyright owner, its agent or the law;',
                    'a statement that the information in the notice is accurate and, under penalty of perjury, that you are authorised to act on behalf of the owner.',
                ),
                p(
                    `Send notices through the report form, or to our designated agent: Copyright Agent, ${name}, ${postalAddress}, ${emails.legal}.`,
                ),
                placeholder(
                    'Max to register the designated agent with the US Copyright Office (DMCA Designated Agent Directory) and add the registration number here.',
                ),
                p(
                    'Knowingly misrepresenting that material is infringing can make you liable for damages (17 U.S.C. §512(f)). If you are not sure, consider getting legal advice first.',
                ),
            ],
        },
        {
            id: 'what-we-do',
            heading: 'What happens after a report',
            blocks: [
                list(
                    'A person at Cleffy reviews every report. We do not use automated tools to decide on reports.',
                    'If we find the report valid, we either restrict the score — it can no longer be shared, and only its uploader can open it — or remove it, so that nobody, including its uploader, can open it. Removed scores are kept, out of reach, so they can be restored if a counter-notice or complaint succeeds.',
                    'We email the uploader a statement of reasons: what we did and to which score, the facts we relied on, whether the content was found illegal or against our terms (and which law or term), that no automated means was used, and how to challenge the decision.',
                    'We email the person who reported it to tell them what we decided. If we decide not to act, we say why.',
                    'We keep a log of every report, decision and notice we send.',
                ),
            ],
        },
        {
            id: 'counter-notice',
            heading: 'Counter-notices',
            blocks: [
                p(
                    `If a score you uploaded was restricted or removed after a copyright notice and you believe that was a mistake or misidentification, you can send a counter-notice to ${emails.legal}. It must include:`,
                ),
                list(
                    'your physical or electronic signature;',
                    'identification of the score that was restricted or removed and where it was (its link);',
                    'a statement, under penalty of perjury, that you have a good-faith belief the material was restricted or removed as a result of mistake or misidentification;',
                    'your name, address and telephone number, and a statement that you consent to the jurisdiction of the US federal district court for your address (or, if you are outside the United States, any judicial district in which Cleffy may be found), and that you will accept service of process from the person who sent the original notice or their agent.',
                ),
                p(
                    'We forward a valid counter-notice to the person who sent the original notice. Unless they tell us within 10 business days that they have filed a court action, we restore the score within 10 to 14 business days of receiving the counter-notice.',
                ),
            ],
        },
        {
            id: 'complaints',
            heading: 'Challenging a decision',
            blocks: [
                p(
                    `Whatever the reason for a decision — a copyright notice, a report of illegal content, or a breach of our Terms — the uploader, and the person who reported it, can ask us to look again. Reply to the email we sent, or write to ${emails.legal}, within six months of the decision, saying why you think it is wrong. A different person from the one who made the decision reviews it, and we tell you the outcome and reverse the decision without delay if we got it wrong.`,
                ),
                p(
                    'If you are in the EU you may also refer the dispute to a certified out-of-court dispute settlement body, and in any country you can go to court.',
                ),
            ],
        },
        {
            id: 'repeat-infringers',
            heading: 'Repeat infringers',
            blocks: [
                p(
                    `Each time we restrict or remove a score after a valid copyright notice, the uploader’s account gets a strike. An account with ${REPEAT_INFRINGER_STRIKES} strikes within ${STRIKE_WINDOW_MONTHS} months is closed in appropriate circumstances. A strike is withdrawn if a counter-notice or complaint succeeds.`,
                ),
                p(
                    `Deleting an account does not clear its strikes. After deletion we keep the strike record and a keyed hash of the account’s email address for up to ${STRIKE_WINDOW_MONTHS} months after the most recent strike, to enforce these rules: an account later created with that address carries the strikes that still count.`,
                ),
                placeholder(
                    'Counsel to confirm the strike threshold and window, and what closing an account involves.',
                ),
            ],
        },
        {
            id: 'misuse',
            heading: 'Misuse of reporting',
            blocks: [
                p(
                    'If someone frequently sends reports that are manifestly unfounded, we may, after a warning, stop processing their reports for a reasonable period. Likewise, we may suspend, after a warning, an account that frequently uploads manifestly illegal content.',
                ),
            ],
        },
        {
            id: 'contact-points',
            heading: 'Points of contact',
            blocks: [
                list(
                    `For authorities in the EU and the European Commission, the single point of contact under the Digital Services Act is ${emails.legal}. We accept communications in English.`,
                    `For users and everyone else: ${emails.legal} for anything about content, ${emails.support} for anything else.`,
                    `By post: ${name}, ${postalAddress}.`,
                ),
                placeholder(
                    'Counsel to confirm whether a legal representative in the EU is required (DSA Art. 13) and, if so, name them here; and whether additional languages must be accepted.',
                ),
            ],
        },
        {
            id: 'imslp',
            heading: 'Public-domain scores from IMSLP',
            blocks: [
                p(
                    'Scores imported from IMSLP come with the licence and copyright information IMSLP provides. Whether a work is in the public domain depends on the country; a report about an IMSLP score is handled in the same way as any other.',
                ),
            ],
        },
    ],
};
