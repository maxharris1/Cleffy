/**
 * Who runs Cleffy and how to reach them, plus the documents' revision date.
 *
 * Kept apart from legalContent.ts — which re-exports both — because several
 * always-loaded screens (the library shell, the footer links, the Account page)
 * need the support address, and importing it from legalContent.ts would carry
 * the whole Privacy Policy and Terms into the main bundle, defeating the lazy
 * /privacy and /terms routes. Import from here outside src/features/legal.
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
