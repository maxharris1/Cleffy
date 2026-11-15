/**
 * The version of each legal document currently published — what a consent
 * record stores ("agreed to terms 2026-10-20-draft"), what the purchase
 * confirmation email names, and what each page shows under its title.
 *
 * Tiny on purpose, and its one import (src/lib/features.ts) is import-free:
 * checkout and billing code read it without pulling any document text into
 * their bundles. The Edge Functions read the
 * same values from supabase/functions/_shared/legalVersions.ts, and
 * src/features/legal/legalVersions.test.ts fails CI when the two differ.
 *
 * Bump a document's version whenever its text changes in a way a reader would
 * care about, and its date in LEGAL_LAST_UPDATED with it. A `-draft` suffix
 * marks text that counsel has not signed off; the pages say so in a banner
 * while LEGAL_DOCUMENTS_ARE_DRAFTS is true.
 *
 * A build with VITE_FEATURE_SHARE_V2 on publishes the Share v2 text of the
 * Privacy Policy and the Children's Notice, so it shows their
 * SHARE_V2_LEGAL_VERSIONS stamps instead. Nothing asks anyone to agree again
 * when a stamp changes. The server records only terms and refunds, which the
 * flag never changes, so the Edge Function mirror keeps the base stamps.
 */

import { features } from '@/lib/features';

export const LEGAL_DOCUMENT_IDS = ['privacy', 'children', 'terms', 'refunds', 'copyright'] as const;

export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[number];

const BASE_LEGAL_VERSIONS: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '2026-10-20-draft',
    children: '2026-11-12-draft',
    terms: '2026-10-20-draft',
    refunds: '2026-10-20-draft',
    copyright: '2026-10-20-draft',
};

const BASE_LEGAL_LAST_UPDATED: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '20 October 2026',
    children: '12 November 2026',
    terms: '20 October 2026',
    refunds: '20 October 2026',
    copyright: '20 October 2026',
};

export const SHARE_V2_LEGAL_VERSIONS = {
    privacy: '2026-11-14-draft',
    children: '2026-11-14-draft',
} as const satisfies Partial<Record<LegalDocumentId, string>>;

const SHARE_V2_LEGAL_LAST_UPDATED = {
    privacy: '14 November 2026',
    children: '14 November 2026',
} as const satisfies Record<keyof typeof SHARE_V2_LEGAL_VERSIONS, string>;

export const LEGAL_VERSIONS: Readonly<Record<LegalDocumentId, string>> = features.shareV2
    ? { ...BASE_LEGAL_VERSIONS, ...SHARE_V2_LEGAL_VERSIONS }
    : BASE_LEGAL_VERSIONS;

/** Shown at the top of each document as "Last updated …". */
export const LEGAL_LAST_UPDATED: Readonly<Record<LegalDocumentId, string>> = features.shareV2
    ? { ...BASE_LEGAL_LAST_UPDATED, ...SHARE_V2_LEGAL_LAST_UPDATED }
    : BASE_LEGAL_LAST_UPDATED;

/** Where each document is published. */
export const LEGAL_PATHS: Readonly<Record<LegalDocumentId, string>> = {
    privacy: '/privacy',
    children: '/children-privacy',
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
