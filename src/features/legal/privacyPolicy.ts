import { aiFeatures, sendsToAnthropic } from '@/features/legal/aiFeatures';
import { h, list, p, placeholder, type LegalDocument } from '@/features/legal/legalDocument';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';

/**
 * The Privacy Policy, as data.
 *
 * Every statement describes what the code actually does, and each one names
 * where that is in a comment, so a change to the data practices has an obvious
 * place to be reflected. Anything the code cannot establish is either left
 * general or written as a `placeholder(...)` block, and listed in
 * docs/LEGAL_REVIEW.md for counsel to settle.
 *
 * Features switched off in this build (src/lib/features.ts, aiFeatures.ts) are
 * omitted rather than described: the policy covers what this release does.
 * In particular, Anthropic is named only while a feature that calls it is on.
 */

const { brand, name, legalForm, postalAddress, emails, website, dataRegion } = LEGAL_ENTITY;

const hostingSentence = dataRegion
    ? `Our database, sign-in service and file storage are provided by Supabase, Inc. and hosted on Amazon Web Services in the ${dataRegion}.`
    : 'Our database, sign-in service and file storage are provided by Supabase, Inc. and hosted on Amazon Web Services infrastructure.';

/** AI processing, by feature, for only the features this build ships. */
const aiProcessing: string[] = [];
if (aiFeatures.smartImport) {
    // supabase/functions/analyze-annotations — owner-only, metered as vision_reads.
    aiProcessing.push(
        'Smart import (when you choose to import the handwritten or printed markings already on a scanned score): an image of the page you are importing, and the positions of the marks our app detected on it, are sent to Anthropic, PBC (the Claude API) to recognise what each mark is. Only the owner of a score can start this, and only by choosing to.',
    );
}
if (aiFeatures.fingering) {
    // supabase/functions/analyze-notes — any member, billed to the owner.
    aiProcessing.push(
        'Fingering suggestions (when you select a passage and ask for fingerings): an image of the selected passage and of the page it is on are sent to Anthropic, PBC (the Claude API) to read the notes.',
    );
}
if (aiFeatures.playalong) {
    // supabase/functions/score-analyze → services/omr-service on Google Cloud Run.
    aiProcessing.push(
        'Play-along (when you ask Cleffy to play a score): the score’s PDF is processed by our own music-recognition service, which runs on Google Cloud. No third-party AI provider receives it.',
    );
}

const aiSection: LegalDocument['sections'] =
    aiProcessing.length > 0
        ? [
              {
                  id: 'ai',
                  heading: 'Artificial-intelligence features',
                  blocks: [
                      p(
                          'Some features use AI to read what is on a page. They run only when you ask for them, and send only what that feature needs:',
                      ),
                      list(...aiProcessing),
                      ...(sendsToAnthropic
                          ? [
                                p(
                                    'Our AI provider processes this content to return a result to us. Under its commercial terms it does not use our requests to train its models.',
                                ),
                            ]
                          : []),
                  ],
              },
          ]
        : [];

export const PRIVACY_POLICY: LegalDocument = {
    id: 'privacy',
    title: 'Privacy Policy',
    shortTitle: 'Privacy',
    summary: `How ${name} collects, uses, shares and deletes information when you use ${website}.`,
    sections: [
        {
            id: 'overview',
            heading: 'The short version',
            blocks: [
                list(
                    'We collect what we need to run Cleffy: your account, the scores you upload, the markings you and your collaborators make, and — if you subscribe — your billing status.',
                    'Your scores and markings are visible only to you and the people you share them with.',
                    'We do not sell or share your personal information for advertising, show advertising, or use third-party analytics or advertising trackers.',
                    'Card payments are handled by Stripe; your card details never reach our servers.',
                    'You can delete your account, and everything it owns, yourself from the Account page.',
                ),
                p(
                    `This policy applies to the ${brand} website and app at ${website}, operated by ${name} (“we”, “us”), ${legalForm}, ${postalAddress}. ${name} is the controller of the personal information described here, except where a school uses ${brand} under our School Use Addendum, when the school decides how its students’ information is used and we process it for the school. If you have a question about this policy, write to ${emails.privacy}.`,
                ),
            ],
        },
        {
            id: 'information-we-collect',
            heading: 'Information we collect',
            blocks: [
                h('Account information'),
                list(
                    // Supabase Auth: email/password only (src/features/auth/session.ts).
                    'Your email address and password when you create an account. Passwords are stored only as a secure hash by our sign-in provider; we never see them.',
                    // user_metadata.display_name (AccountPage).
                    'The display name you choose, if you set one.',
                    // Age screen on /register and /join (mh/launch-consent): compared, then discarded.
                    'When you sign up or join as a guest, the country you choose and your confirmation that you meet the minimum age there. If you give a birth month and year to confirm it, we use it only for that check and do not keep it.',
                    // auth.users / auth sessions keep IP and user agent.
                    'Technical information recorded when you sign in, such as the time, your IP address and your browser type, which our sign-in provider keeps for security.',
                    // signInAnonymously in session.ts; JoinPage.
                    'If you open a share link without an account, a temporary guest session is created with the name you type. You can later add an email address to keep it.',
                ),
                h('Your content'),
                list(
                    'The PDF scores you upload or import, and the preview images we generate from them.',
                    // annotations, annotation_snapshots, library_tags, document_favorites.
                    'Your markings (pen strokes, highlights and text), the version history of each score’s markings, and how you organise your library (titles, tags, favourites).',
                    'Scores you import from the IMSLP public-domain library, and the licence information that comes with them.',
                ),
                h('Teaching information'),
                list(
                    // managed_students, teacher_attestations, assignments, practice_notes.
                    'If you are a teacher: the student accounts you create (the name you give each student, their country, your confirmation that they meet the minimum age there, their username or, for an email invitation, their email address, and optionally a parent’s email address), the scores you assign, due dates, and the practice notes you write.',
                ),
                h('Billing information'),
                list(
                    // billing_customers, subscriptions (billing migration).
                    'If you subscribe: your Stripe customer and subscription identifiers, your plan, its status and renewal date, and the billing country Stripe uses to work out tax. Payment details are collected and kept by Stripe, not by us.',
                    // usage_counters.
                    'How much of each metered feature you have used this month, so we can apply your plan’s limits.',
                ),
                h('Messages and reports you send us'),
                list(
                    // support_messages via resend-inbound.
                    `When you email ${emails.support}, ${emails.privacy} or ${emails.legal}, we keep your email address, the subject and the message so we can answer it.`,
                    // content_reports via the content-report function (/report).
                    'When you report content that you believe is illegal or infringes copyright, we keep your name, email address, what you report and why, and what we decided. If you were signed in, the report is linked to your account.',
                ),
                h('Technical and security information'),
                list(
                    // edge_rate_buckets keyed by IP / account.
                    'Your IP address and account identifier are used to limit how often some features can be used, to prevent abuse.',
                    'Our hosting providers record standard request logs (for example IP address, time and page requested).',
                    // src/lib/monitoring.
                    'If the app crashes, an error report may be sent to our error-monitoring provider. Reports are stripped of email addresses, sign-in tokens, the contents of your markings and web-address parameters before they leave your device, and identify you, if at all, only by an internal account number — never for a student account.',
                ),
            ],
        },
        {
            id: 'how-we-use',
            heading: 'How we use information',
            blocks: [
                list(
                    'To provide Cleffy: store and display your scores, sync your markings across your devices and to your collaborators in real time, and let you work offline.',
                    'To run your account and subscription, apply your plan’s limits, and send the emails the service needs (sign-up confirmation, password reset, student invitations, receipts).',
                    'To answer support requests and handle reports about content.',
                    'To keep Cleffy secure and working: preventing abuse, investigating problems and fixing errors.',
                    'To meet legal obligations, such as keeping billing and tax records and acting on notices about illegal content.',
                ),
                p(
                    'We do not use your scores or markings to train artificial-intelligence models, and we do not sell your personal information or use it for advertising.',
                ),
            ],
        },
        {
            id: 'legal-bases',
            heading: 'Our legal bases (EEA and UK)',
            blocks: [
                list(
                    'Contract: to provide the service you signed up for, run your account and subscription, and sync your work.',
                    'Legitimate interests: to keep Cleffy secure, prevent abuse, fix errors and answer messages — balanced against your rights, which you can object on.',
                    'Legal obligation: to keep billing and tax records, and to act on notices about illegal content.',
                ),
                placeholder(
                    'Counsel to confirm the legal basis for each purpose, including student accounts created by a teacher or school.',
                ),
            ],
        },
        {
            id: 'who-can-see',
            heading: 'Who can see your scores and markings',
            blocks: [
                list(
                    'A score you upload is private to you until you share it.',
                    // One shared annotation layer per score; document_members roles.
                    'Each score has one shared set of markings. Everyone you share a score with can see all of its markings; editors can also add, change and erase them.',
                    // share_links: anyone holding the link.
                    'Anyone who has a share link can open the score with the access that link grants, until you revoke it. Treat share links like a key.',
                    // presenceNameOf(): display name, else "Collaborator" / "Guest" (mh/launch-consent).
                    'While a score is open, the people viewing it see each other’s display names. Someone who has not set one is shown as “Collaborator”, or “Guest” for a guest; email addresses are never shown.',
                    'If you are removed from a score, the markings you made on it stay there. If you delete your account, the markings you made on other people’s scores stay on those scores, no longer attributed to you.',
                    // practice_notes.shared.
                    'Teachers see their students’ work on the scores they assign. A teacher’s practice notes are private to the teacher unless they choose to share them with the student.',
                ),
            ],
        },
        ...aiSection,
        {
            id: 'service-providers',
            heading: 'Service providers we share information with',
            blocks: [
                p(
                    'We share information only with the providers that run parts of Cleffy for us, and only what they need:',
                ),
                list(
                    `Supabase, Inc. — database, sign-in, file storage, real-time sync and server functions. ${hostingSentence}`,
                    'Vercel, Inc. — hosts and delivers the Cleffy website and app.',
                    'Stripe, Inc. — processes subscription payments, calculates tax and keeps payment records.',
                    'Resend (Plus Five Five, Inc.) — sends our emails and receives email sent to our addresses.',
                    ...(sendsToAnthropic
                        ? ['Anthropic, PBC — processes the content you send to the AI features described above.']
                        : []),
                    ...(aiFeatures.playalong
                        ? ['Google LLC (Google Cloud) — runs our music-recognition service for play-along.']
                        : []),
                    'Functional Software, Inc. (Sentry) — receives scrubbed error reports, when error monitoring is enabled.',
                ),
                p(
                    'We may also disclose information if the law requires it, to protect the rights and safety of our users or the public, or as part of a sale or reorganisation of our business, in which case this policy would continue to apply to it. When we act on a report about content, we tell the person who uploaded it why, without giving them the reporter’s contact details unless the law requires it (a copyright counter-notice process may).',
                ),
                p(
                    // imslp-download fetches server-side.
                    'When you search or import from IMSLP, our servers fetch the results and files on your behalf; IMSLP does not receive your account details or your IP address from us.',
                ),
            ],
        },
        {
            id: 'device-storage',
            heading: 'What Cleffy stores on your device',
            blocks: [
                p(
                    'Cleffy works offline, so it keeps some information in your browser. None of it is used for advertising or tracking.',
                ),
                list(
                    // authStorage.ts.
                    'Your sign-in session, in your browser’s local storage, plus one first-party cookie (cleffy-auth-restore) that lets the app restore your sign-in when it is opened from a phone’s home screen. It lasts up to 60 days and is cleared when you sign out.',
                    // src/sync/db.ts (IndexedDB).
                    'Offline copies of the scores you open, their markings, changes not yet synced, and a copy of your library and plan so the app opens quickly — in your browser’s IndexedDB storage.',
                    // *Prefs.ts.
                    'Display preferences, such as your library view and page layout, in local storage.',
                    // vite-plugin-pwa.
                    'The app itself, cached so it can start without a connection.',
                ),
                p(
                    // useGuardedSignOut.tsx + session.ts syncBeforeSignOut(): upload first, ask if anything is left.
                    'Signing out first uploads any markings and changes that have not finished syncing. If some cannot be uploaded — for example because you are offline — Cleffy tells you before going ahead, and if you sign out anyway they are lost.',
                ),
                p(
                    // session.ts signOut() + signOutSync.ts clearCloudAnnotationData(): local-… scores are kept.
                    'Signing out then removes from that device your sign-in, your cached plan and library, the downloaded copies of your scores, and the device’s copy of your markings on them and of their history; everything already uploaded stays in your account. Markings on files you opened from your device without uploading them stay on that device, as do your display preferences. You can remove downloaded scores at any time from the Account page. Deleting your account removes everything Cleffy has stored in that browser.',
                ),
            ],
        },
        {
            id: 'children',
            heading: 'Children and student accounts',
            blocks: [
                p(
                    'Cleffy is not directed at children under 13. To create an account yourself, or to join a score as a guest, you must be at least 13, or older where your country sets a higher age for agreeing to the use of your information online (up to 16 in some European countries). We ask your country and confirm the age before an account is created.',
                ),
                list(
                    'A teacher who creates a student account confirms that the student meets the minimum age for the student’s country, and is responsible for having the authority to create it — for example the consent of the student’s parent or guardian, or of the school.',
                    'For a student account we hold only what the teacher enters (a name, the student’s country and, optionally, the student’s or a parent’s email address), the teacher’s age confirmation, the username and password the student chooses, and the student’s work on the scores assigned to them.',
                    'Student accounts never pay and are never shown advertising.',
                    `A student account is managed by the teacher who created it. To have one deleted, ask the teacher, or contact us at ${emails.privacy}. When a teacher deletes a student, the student’s markings are removed from the teacher’s scores; when a teacher deletes their own account, the student accounts they created are deleted too.`,
                    // session.ts signOutKeepingChanges(): the outbox stays, stamped with the student.
                    'When a teacher archives a student or resets their access, the student is signed out on every device. Markings the student made that had not finished uploading stay on that device, where no other account can see them, and upload the next time the student signs in there.',
                ),
                p(
                    `If you believe a child under the minimum age has given us personal information, write to ${emails.privacy} and we will delete it.`,
                ),
            ],
        },
        {
            id: 'retention',
            heading: 'How long we keep information',
            blocks: [
                list(
                    'We keep your account and content for as long as your account exists.',
                    // Retention jobs (pg_cron, mh/launch-consent).
                    'Archived student accounts are deleted 12 months after they were archived, unless the teacher restores them first.',
                    'Guest profiles created through a share link are deleted after 90 days without use, unless an email address has been added to keep them.',
                    'Erased markings remain in a score’s version history, so they can be restored, until the score itself is deleted or the history is compacted.',
                    'Deleting a score removes its file, its preview images, its markings and its history.',
                    `Emails you send us are kept for 24 months after we receive them; you can ask us to delete yours sooner at ${emails.privacy}.`,
                    'Counters used to limit how often a feature can be used are cleared daily.',
                    // District retention (decisions item 1): contract_ends_at on the
                    // district billing record (mh/district-seats), purged by the
                    // retention job (mh/launch-consent); null never purges.
                    'For a school or district under our School Use Addendum, its data is deleted 30 days after its contract ends: the end date in its contract, or the day its subscription ends or is cancelled. At least 14 days before, we email the account owner so the school can export its data first. Deletion takes the data out of use first, then erases it for good. If a contract has no end date, nothing is deleted automatically, and the school can ask us to delete its data at any time.',
                    'Stripe keeps payment and invoice records for as long as tax and accounting law requires, even after your account is deleted.',
                    'Our providers keep request logs and backups for a limited period, after which deleted information is gone from them too.',
                ),
                placeholder(
                    'Counsel to set how long reports about content, the decisions taken on them and the related notices are kept (they are needed to handle counter-notices, complaints and repeat infringers).',
                ),
            ],
        },
        {
            id: 'deleting',
            heading: 'Deleting your account',
            blocks: [
                p('You can delete your account yourself from the Account page. When you do, straight away:'),
                list(
                    'Any subscription is cancelled, so you will not be charged again.',
                    'Every score you own is deleted — its file, markings, history and share links — for you and for everyone you shared it with.',
                    'Student accounts you created are deleted, with their assignments and your practice notes.',
                    'If you own an Academy studio, it is closed and its teachers lose their seats.',
                    'You are removed from scores other people shared with you. Markings you made on those scores stay there, no longer attributed to you.',
                    'Your sign-in account is deleted, and the information Cleffy kept in that browser is cleared.',
                ),
                p(
                    'This cannot be undone. Copies may persist in our providers’ backups and logs for a limited time before they expire.',
                ),
                // ShareDialog's guest action → delete-account's guest path (_shared/accountDeletion.ts deleteGuest).
                p(
                    'If you joined a score through a share link without an account, you can delete that guest profile from the score’s Sharing panel. You are removed from every score shared with you as a guest, the guest sign-in and the name you gave are deleted, and markings you made stay on those scores, no longer attributed to you.',
                ),
            ],
        },
        {
            id: 'your-rights',
            heading: 'Your choices and rights',
            blocks: [
                p(
                    `You can see and change your display name and password on the Account page, and delete your account there. To change your sign-in email address, get a copy of your information, correct something, restrict or object to how we use it, or ask us to delete it, write to ${emails.privacy}. We answer within one month (45 days for California residents), and may ask you to confirm the request comes from you.`,
                ),
                p(
                    'Depending on where you live, you have further rights. In the EEA and the UK you may complain to your data-protection authority. In California and other US states with privacy laws, you have the right to know, correct and delete your information; we do not sell or share it for cross-context advertising, so there is nothing to opt out of. We will not treat you differently for exercising any of these rights.',
                ),
                placeholder(
                    'Counsel to confirm whether an EU representative (GDPR Art. 27) and a UK representative are required, and if so name them here.',
                ),
            ],
        },
        {
            id: 'security',
            heading: 'Security',
            blocks: [
                p(
                    'Information is encrypted in transit, scores are stored in private storage that only their members can reach, and access to every score is enforced by our database itself, not just the app. No system is perfectly secure; if we learn of a breach that affects you, we will tell you as the law requires.',
                ),
            ],
        },
        {
            id: 'international',
            heading: 'International transfers',
            blocks: [
                p(
                    `${name} is in the United States and Cleffy’s data is stored there. If you use Cleffy from elsewhere, your information is transferred to the United States, and our providers may process it in other countries too.`,
                ),
                placeholder(
                    'Counsel to name the safeguard relied on for transfers from the EEA, UK and Switzerland (for example the EU Standard Contractual Clauses, the UK Addendum, or the EU-US Data Privacy Framework where a provider is certified).',
                ),
            ],
        },
        {
            id: 'changes',
            heading: 'Changes to this policy',
            blocks: [
                p(
                    'If we change this policy, we will update the date and version at the top. If a change is significant, we will tell you by email or in the app before it takes effect.',
                ),
            ],
        },
        {
            id: 'contact',
            heading: 'Contact',
            blocks: [
                p(
                    `Questions or requests about privacy: ${emails.privacy}, or by post to ${name}, ${postalAddress}. For anything else: ${emails.support}.`,
                ),
            ],
        },
    ],
};
