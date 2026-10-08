import { features } from '@/lib/features';

/**
 * The Privacy Policy and Terms of Service, as data — the one place to edit
 * either. The pages (LegalPage.tsx) only render what is here.
 *
 * Every statement in the privacy policy describes what the code actually does,
 * and each section names where that is in a comment, so a change to the data
 * practices has an obvious place to be reflected. Anything the code cannot
 * establish — who the legal entity is, where it is established, the hosting
 * region, the refund policy, age thresholds — is NOT invented here: it is either
 * left general or written as a clearly marked placeholder, and every one is
 * listed in docs/LEGAL_REVIEW.md for counsel to settle before launch.
 *
 * Sections for features that are switched off in this build (src/lib/features.ts)
 * are omitted rather than described: the policy covers what this release does.
 */

/** Business details. Change these here and both documents follow. */
export const LEGAL_ENTITY = {
    /** The operator's name as it appears to customers. See LEGAL_REVIEW.md §1. */
    name: 'Cleffy',
    /** The address that reaches a human (supabase/functions/resend-inbound). */
    contactEmail: 'support@cleffy.io',
    website: 'cleffy.io',
    /**
     * Where the database and file storage are hosted, as Supabase reports it
     * (Project Settings → General → Region). Null until confirmed: the policy
     * then names the provider without a region. See LEGAL_REVIEW.md §3.
     */
    dataRegion: null as string | null,
} as const;

/** Shown at the top of both documents; update whenever either changes. */
export const LEGAL_LAST_UPDATED = '8 October 2026';

/** A sub-heading, a paragraph, or a bulleted list. Email addresses render as mailto links. */
export type LegalBlock = { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'list'; items: string[] };

export interface LegalSection {
    /** Stable anchor: /privacy#retention links survive copy edits. */
    id: string;
    heading: string;
    blocks: LegalBlock[];
}

export interface LegalDocument {
    title: string;
    summary: string;
    sections: LegalSection[];
}

const h = (text: string): LegalBlock => ({ kind: 'h', text });
const p = (text: string): LegalBlock => ({ kind: 'p', text });
const list = (...items: string[]): LegalBlock => ({ kind: 'list', items });

const { name, contactEmail, website, dataRegion } = LEGAL_ENTITY;

const hostingSentence = dataRegion
    ? `Our database, sign-in service and file storage are provided by Supabase, Inc. and hosted on Amazon Web Services in ${dataRegion}.`
    : 'Our database, sign-in service and file storage are provided by Supabase, Inc. and hosted on Amazon Web Services infrastructure.';

/** AI processing, by feature, for only the features this build ships. */
const aiProcessing: string[] = [
    // supabase/functions/analyze-annotations — owner-only, metered as vision_reads.
    'Smart import (when you choose to import the handwritten or printed markings already on a scanned score): an image of the page you are importing, and the positions of the marks our app detected on it, are sent to Anthropic, PBC (the Claude API) to recognise what each mark is. Only the owner of a score can start this, and only by choosing to.',
];
if (features.fingering) {
    // supabase/functions/analyze-notes — any member, billed to the owner.
    aiProcessing.push(
        'Fingering suggestions (when you select a passage and ask for fingerings): an image of the selected passage and of the page it is on are sent to Anthropic, PBC (the Claude API) to read the notes.',
    );
}
if (features.playalong) {
    // supabase/functions/score-analyze → services/omr-service on Google Cloud Run.
    aiProcessing.push(
        'Play-along (when you ask Cleffy to play a score): the score’s PDF is processed by our own music-recognition service, which runs on Google Cloud. No third-party AI provider receives it.',
    );
}

export const PRIVACY_POLICY: LegalDocument = {
    title: 'Privacy Policy',
    summary: `How ${name} collects, uses, shares and deletes information when you use ${website}.`,
    sections: [
        {
            id: 'overview',
            heading: 'The short version',
            blocks: [
                list(
                    'We collect what we need to run Cleffy: your account, the scores you upload, the markings you and your collaborators make, and — if you subscribe — your billing status.',
                    'Your scores and markings are visible only to you and the people you share them with.',
                    'We do not sell your personal information, show advertising, or use third-party analytics or advertising trackers.',
                    'Card payments are handled by Stripe; your card details never reach our servers.',
                    'You can delete your account, and everything it owns, yourself from the Account page.',
                ),
                p(
                    `This policy applies to the Cleffy website and app at ${website}, operated by ${name} (“we”, “us”). If you have a question about it, write to ${contactEmail}.`,
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
                    // managed_students, assignments, practice_notes (roster migration).
                    'If you are a teacher: the student accounts you create (the name you give each student, their username or, for an email invitation, their email address, and optionally a parent’s email address), the scores you assign, due dates, and the practice notes you write.',
                ),
                h('Billing information'),
                list(
                    // billing_customers, subscriptions (billing migration).
                    'If you subscribe: your Stripe customer and subscription identifiers, your plan, its status and renewal date. Payment details are collected and kept by Stripe, not by us.',
                    // usage_counters.
                    'How much of each metered feature you have used this month, so we can apply your plan’s limits.',
                ),
                h('Messages you send us'),
                list(
                    // support_messages via resend-inbound.
                    `When you email ${contactEmail}, we keep your email address, the subject and the message so we can answer it.`,
                ),
                h('Technical and security information'),
                list(
                    // edge_rate_buckets keyed by IP / account.
                    'Your IP address and account identifier are used to limit how often some features can be used, to prevent abuse.',
                    'Our hosting providers record standard request logs (for example IP address, time and page requested).',
                    // src/lib/monitoring.
                    'If the app crashes, an error report may be sent to our error-monitoring provider. Reports are stripped of email addresses, sign-in tokens, the contents of your markings and web-address parameters before they leave your device, and identify you only by an internal account number.',
                ),
            ],
        },
        {
            id: 'how-we-use',
            heading: 'How we use information',
            blocks: [
                list(
                    'To provide Cleffy: store and display your scores, sync your markings across your devices and to your collaborators in real time, and let you work offline.',
                    'To run your account and subscription, apply your plan’s limits, and send the emails the service needs (sign-up confirmation, password reset, student invitations).',
                    'To answer support requests.',
                    'To keep Cleffy secure and working: preventing abuse, investigating problems and fixing errors.',
                    'To meet legal obligations, such as keeping billing records.',
                ),
                p(
                    'We do not use your scores or markings to train artificial-intelligence models, and we do not sell your personal information or use it for advertising.',
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
                    // Presence uses displayNameOf(): display name, else email.
                    'While a score is open, the people viewing it see each other’s names — your display name, or your email address if you have not set one.',
                    'If you are removed from a score, or delete your account, the markings you made on someone else’s score stay on that score, no longer attributed to you.',
                    // practice_notes.shared.
                    'Teachers see their students’ work on the scores they assign. A teacher’s practice notes are private to the teacher unless they choose to share them with the student.',
                ),
            ],
        },
        {
            id: 'ai',
            heading: 'Artificial-intelligence features',
            blocks: [
                p(
                    'Some features use AI to read what is on a page. They run only when you ask for them, and send only what that feature needs:',
                ),
                list(...aiProcessing),
                p(
                    'Our AI provider processes this content to return a result to us. Under its commercial terms it does not use our requests to train its models.',
                ),
            ],
        },
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
                    'Stripe, Inc. — processes subscription payments and keeps payment records.',
                    'Resend (Plus Five Five, Inc.) — sends our account emails and receives email sent to our support address.',
                    'Anthropic, PBC — processes the content you send to the AI features described above.',
                    ...(features.playalong
                        ? ['Google LLC (Google Cloud) — runs our music-recognition service for play-along.']
                        : []),
                    'Functional Software, Inc. (Sentry) — receives scrubbed error reports, when error monitoring is enabled.',
                ),
                p(
                    'We may also disclose information if the law requires it, to protect the rights and safety of our users or the public, or as part of a sale or reorganisation of our business, in which case this policy would continue to apply to it.',
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
                    // session.ts signOut(): the ops queue and annotation mirror are kept on purpose.
                    'Signing out removes your sign-in, your cached plan and library, and the downloaded copies of your scores from that device. Markings and changes that have not finished syncing are kept, so no work is lost. You can remove downloaded scores at any time from the Account page. Deleting your account removes everything Cleffy has stored in that browser.',
                ),
            ],
        },
        {
            id: 'children',
            heading: 'Children and student accounts',
            blocks: [
                p(
                    'Cleffy accounts that people create for themselves are for adults and teenagers old enough to agree to these terms where they live. Younger students use Cleffy through an account their teacher creates.',
                ),
                list(
                    'A teacher who creates a student account is responsible for having the authority to do so — for example the consent of the student’s parent or guardian, or of the school.',
                    'For a student account we hold only what the teacher enters (a name and, optionally, the student’s or a parent’s email address), the username and password the student chooses, and the student’s work on the scores assigned to them.',
                    'Student accounts never pay and are never shown advertising.',
                    `A student account is managed by the teacher who created it. To have one deleted, ask the teacher, or contact us at ${contactEmail}. When a teacher deletes their own account, the student accounts they created are deleted too.`,
                ),
            ],
        },
        {
            id: 'retention',
            heading: 'How long we keep information',
            blocks: [
                list(
                    'We keep your account and content for as long as your account exists.',
                    'Erased markings remain in a score’s version history, so they can be restored, until the score itself is deleted.',
                    'Deleting a score removes its file, its preview images, its markings and its history.',
                    `Support emails are kept for as long as we need them to help you; you can ask us to delete yours at ${contactEmail}.`,
                    'Stripe keeps payment and invoice records for as long as the law requires, even after your account is deleted.',
                    'Our providers keep request logs and backups for a limited period, after which deleted information is gone from them too.',
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
            ],
        },
        {
            id: 'your-rights',
            heading: 'Your choices and rights',
            blocks: [
                p(
                    `You can see and change your display name and password on the Account page, and delete your account there. To change your sign-in email address, get a copy of your information, correct something, or object to how we use it, write to ${contactEmail}. Depending on where you live, you may have further rights, including to complain to a data-protection authority. We will not treat you differently for exercising them.`,
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
                    'Our providers may process information in countries other than yours, including the United States. Where the law requires it, we rely on appropriate safeguards for those transfers.',
                ),
            ],
        },
        {
            id: 'changes',
            heading: 'Changes to this policy',
            blocks: [
                p(
                    'If we change this policy, we will update the date at the top. If a change is significant, we will tell you by email or in the app before it takes effect.',
                ),
            ],
        },
        {
            id: 'contact',
            heading: 'Contact',
            blocks: [p(`Questions or requests about privacy: ${contactEmail}.`)],
        },
    ],
};

export const TERMS_OF_SERVICE: LegalDocument = {
    title: 'Terms of Service',
    summary: `The agreement between you and ${name} for using ${website}.`,
    sections: [
        {
            id: 'agreement',
            heading: 'Agreement',
            blocks: [
                p(
                    `These terms are an agreement between you and ${name} (“we”, “us”) about your use of Cleffy. By creating an account, opening a share link, or subscribing, you agree to them and to our Privacy Policy. If you use Cleffy for a school or business, you agree on its behalf and confirm you may do so.`,
                ),
            ],
        },
        {
            id: 'accounts',
            heading: 'Your account',
            blocks: [
                list(
                    'You must be old enough to agree to these terms where you live. Younger students may use Cleffy only through an account their teacher creates.',
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
                    'If you create student accounts, you confirm you have the authority to do so, including any consent required from parents, guardians or a school, and you are responsible for how those accounts are used.',
                    'Student accounts belong to your roster. Archiving a student removes their access; deleting your own account deletes the student accounts you created and their work on your scores.',
                ),
            ],
        },
        {
            id: 'your-content',
            heading: 'Your content',
            blocks: [
                p(
                    'You keep ownership of the scores you upload and the markings you make. You give us permission to store, copy, display, process and transmit them only as needed to run Cleffy for you and the people you share with — including sending content to the AI features you choose to use, as our Privacy Policy describes.',
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
                    `If you believe something on Cleffy infringes your rights, write to ${contactEmail} with the details, and we will look into it promptly and remove material where appropriate.`,
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
                p('We may remove content or suspend access that breaks these rules.'),
            ],
        },
        {
            id: 'plans-and-billing',
            heading: 'Plans, billing and cancellation',
            blocks: [
                list(
                    'Paid plans are billed in advance, monthly or annually, through Stripe, and renew automatically until cancelled. The price and any tax are shown before you pay.',
                    'You can change or cancel your plan at any time from Manage subscription on the Account page. A cancelled plan stays active until the end of the period you have paid for.',
                    'If your plan ends or you move to a smaller one, nothing is deleted: scores beyond the new plan’s limits become read-only until you upgrade again or remove others.',
                    'Deleting your account cancels your subscription immediately.',
                    // Placeholder — see LEGAL_REVIEW.md §6. Not invented: deliberately general.
                    `Except where the law gives you a right to one, payments are not refundable. If you think you were charged in error, write to ${contactEmail} and we will put it right.`,
                    'If we change our prices, we will tell you in advance, and the change will apply from your next billing period.',
                ),
            ],
        },
        {
            id: 'ai-features',
            heading: 'AI features',
            blocks: [
                p(
                    'Features that read your scores with AI can make mistakes. Review their results before relying on them; they are suggestions, not a substitute for your own judgement.',
                ),
            ],
        },
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
                    'You can stop using Cleffy and delete your account at any time from the Account page. We may suspend or close an account that seriously or repeatedly breaks these terms, or where the law requires it; where we reasonably can, we will tell you first and give you a chance to retrieve your content.',
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
            ],
        },
        {
            id: 'law',
            heading: 'Governing law',
            blocks: [
                // Placeholder — see LEGAL_REVIEW.md §1–2.
                p(
                    'These terms are governed by the laws of the place where Cleffy is established, without affecting any mandatory protection the law of your own country gives you as a consumer.',
                ),
            ],
        },
        {
            id: 'changes',
            heading: 'Changes to these terms',
            blocks: [
                p(
                    'We may update these terms. We will change the date at the top and, for significant changes, tell you by email or in the app before they take effect. If you keep using Cleffy after that, the new terms apply.',
                ),
            ],
        },
        {
            id: 'contact',
            heading: 'Contact',
            blocks: [p(`Questions about these terms: ${contactEmail}.`)],
        },
    ],
};
