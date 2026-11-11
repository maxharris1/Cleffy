/**
 * The published legal documents' versions and addresses, for the Edge
 * Functions — a mirror of src/features/legal/legalVersions.ts and the parts of
 * src/features/legal/legalEntity.ts that mail needs. The browser modules
 * cannot be imported from Deno (they live outside supabase/functions and use
 * the `@/` alias), so these are restated, and
 * src/features/legal/legalVersions.test.ts holds the two sides equal.
 *
 * NO imports, so vitest and Deno load the same file.
 */

export const LEGAL_VERSIONS = {
    privacy: '2026-10-20-draft',
    terms: '2026-10-20-draft',
    refunds: '2026-10-20-draft',
    copyright: '2026-10-20-draft',
} as const;

export const LEGAL_OPERATOR = {
    name: 'Cleffy LLC',
    postalAddress: '245 East 37th Street, Apt 3E, New York, NY 10016, USA',
    legalEmail: 'legal@cleffy.io',
    privacyEmail: 'privacy@cleffy.io',
    supportEmail: 'support@cleffy.io',
    website: 'cleffy.io',
} as const;
