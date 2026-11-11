/**
 * The version of each legal document currently published — what a consent
 * record stores ("agreed to terms 2026-10-20-draft"), what the purchase
 * confirmation email names, and what each page shows under its title.
 *
 * Import-free and tiny on purpose: checkout and billing code read it without
 * pulling any document text into their bundles. The Edge Functions read the
 * same values from supabase/functions/_shared/legalVersions.ts, and
 * src/features/legal/legalVersions.test.ts fails CI when the two differ.
 *
 * Bump a document's version whenever its text changes in a way a reader would
 * care about, and its date in LEGAL_LAST_UPDATED with it. A `-draft` suffix
 * marks text that counsel has not signed off; the pages say so in a banner
 * while LEGAL_DOCUMENTS_ARE_DRAFTS is true.
 */

export const LEGAL_DOCUMENT_IDS = ['privacy', 'terms', 'refunds', 'copyright'] as const;

export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[number];

export const LEGAL_VERSIONS: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '2026-10-20-draft',
    terms: '2026-10-20-draft',
    refunds: '2026-10-20-draft',
    copyright: '2026-10-20-draft',
};

/** Shown at the top of each document as "Last updated …". */
export const LEGAL_LAST_UPDATED: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '20 October 2026',
    terms: '20 October 2026',
    refunds: '20 October 2026',
    copyright: '20 October 2026',
};

/** Where each document is published. */
export const LEGAL_PATHS: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '/privacy',
    terms: '/terms',
    refunds: '/refunds',
    copyright: '/copyright',
};

/**
 * True until counsel's final text replaces the placeholders. The pages show a
 * draft banner, and the tests require every document to carry its version's
 * `-draft` suffix while it is set.
 */
export const LEGAL_DOCUMENTS_ARE_DRAFTS = true;
