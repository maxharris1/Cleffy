/**
 * Every legal document, in one import, for the pages and the tests.
 *
 * Each document is its own versioned module — privacyPolicy.ts,
 * termsOfService.ts (with the School Use Addendum), refundPolicy.ts (with the
 * model withdrawal form) and copyrightPolicy.ts — so a change to one is a
 * change to one file and one entry in LEGAL_VERSIONS. Placeholders that
 * counsel must settle are listed in docs/LEGAL_REVIEW.md.
 *
 * Outside src/features/legal, import the business details from legalEntity.ts
 * and the versions from legalVersions.ts, not from here: this module carries
 * the full text of all four documents.
 */

import { COPYRIGHT_POLICY } from '@/features/legal/copyrightPolicy';
import type { LegalDocument } from '@/features/legal/legalDocument';
import type { LegalDocumentId } from '@/features/legal/legalVersions';
import { PRIVACY_POLICY } from '@/features/legal/privacyPolicy';
import { REFUND_POLICY } from '@/features/legal/refundPolicy';
import { TERMS_OF_SERVICE } from '@/features/legal/termsOfService';

export { COPYRIGHT_POLICY, PRIVACY_POLICY, REFUND_POLICY, TERMS_OF_SERVICE };
export { legalText, type LegalBlock, type LegalDocument, type LegalSection } from '@/features/legal/legalDocument';
export { LEGAL_ENTITY } from '@/features/legal/legalEntity';
export {
    LEGAL_DOCUMENTS_ARE_DRAFTS,
    LEGAL_LAST_UPDATED,
    LEGAL_PATHS,
    LEGAL_VERSIONS,
} from '@/features/legal/legalVersions';

/** In the order the pages list them. */
export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentId, LegalDocument>> = {
    privacy: PRIVACY_POLICY,
    terms: TERMS_OF_SERVICE,
    refunds: REFUND_POLICY,
    copyright: COPYRIGHT_POLICY,
};
