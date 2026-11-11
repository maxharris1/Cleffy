import { describe, expect, it } from 'vitest';

import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import { LEGAL_DOCUMENT_IDS, LEGAL_LAST_UPDATED, LEGAL_PATHS, LEGAL_VERSIONS } from '@/features/legal/legalVersions';

import {
    LEGAL_OPERATOR,
    LEGAL_VERSIONS as SERVER_LEGAL_VERSIONS,
} from '../../../supabase/functions/_shared/legalVersions';

describe('LEGAL_VERSIONS', () => {
    it('covers each document, with a date, a page and a route', () => {
        expect(Object.keys(LEGAL_VERSIONS).sort()).toEqual([...LEGAL_DOCUMENT_IDS].sort());
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(LEGAL_VERSIONS[id], id).toMatch(/^\d{4}-\d{2}-\d{2}(-draft)?$/);
            expect(LEGAL_LAST_UPDATED[id], id).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
            expect(LEGAL_PATHS[id], id).toBe(`/${id}`);
        }
    });

    it('is what the Edge Functions record and mail', () => {
        // Consent records and purchase emails are written server-side: a
        // version bumped on one side only would store the wrong one.
        expect(SERVER_LEGAL_VERSIONS).toEqual(LEGAL_VERSIONS);
        expect(LEGAL_OPERATOR).toEqual({
            name: LEGAL_ENTITY.name,
            postalAddress: LEGAL_ENTITY.postalAddress,
            legalEmail: LEGAL_ENTITY.emails.legal,
            privacyEmail: LEGAL_ENTITY.emails.privacy,
            supportEmail: LEGAL_ENTITY.emails.support,
            website: LEGAL_ENTITY.website,
        });
    });
});
