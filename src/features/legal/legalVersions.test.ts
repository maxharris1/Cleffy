import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import {
    LEGAL_DOCUMENT_IDS,
    LEGAL_LAST_UPDATED,
    LEGAL_PATHS,
    LEGAL_VERSIONS,
    SHARE_V2_LEGAL_VERSIONS,
} from '@/features/legal/legalVersions';
import type * as FeaturesModule from '@/lib/features';

import {
    LEGAL_OPERATOR,
    LEGAL_VERSIONS as SERVER_LEGAL_VERSIONS,
    SHARE_V2_LEGAL_VERSIONS as SERVER_SHARE_V2_LEGAL_VERSIONS,
} from '../../../supabase/functions/_shared/legalVersions';

/**
 * The stamps as published, written out. The mirror check below only holds the
 * two sides equal, so a bump made on both sides at once would slip past it;
 * pinning the literals makes every bump a deliberate edit here too.
 */
const PUBLISHED_VERSIONS = {
    privacy: '2026-10-20-draft',
    children: '2026-11-12-draft',
    terms: '2026-10-20-draft',
    refunds: '2026-10-20-draft',
    copyright: '2026-10-20-draft',
};

/** The stamps a build with VITE_FEATURE_SHARE_V2 on publishes. */
const PUBLISHED_SHARE_V2_VERSIONS = {
    ...PUBLISHED_VERSIONS,
    privacy: '2026-11-14-draft',
    children: '2026-11-14-draft',
};

const loadWithShareV2 = async (shareV2: boolean) => {
    vi.resetModules();
    vi.doMock('@/lib/features', async (importOriginal) => {
        const actual = await importOriginal<typeof FeaturesModule>();
        return { features: { ...actual.features, shareV2 } };
    });
    return import('@/features/legal/legalVersions');
};

afterEach(() => {
    vi.doUnmock('@/lib/features');
    vi.resetModules();
});

describe('LEGAL_VERSIONS', () => {
    it('covers each document, with a date, a page and a route', () => {
        expect(Object.keys(LEGAL_VERSIONS).sort()).toEqual([...LEGAL_DOCUMENT_IDS].sort());
        for (const id of LEGAL_DOCUMENT_IDS) {
            expect(LEGAL_VERSIONS[id], id).toMatch(/^\d{4}-\d{2}-\d{2}(-draft)?$/);
            expect(LEGAL_LAST_UPDATED[id], id).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
            // Every page is /<id>, except the children's notice, which lives at a readable /children-privacy.
            expect(LEGAL_PATHS[id], id).toBe(id === 'children' ? '/children-privacy' : `/${id}`);
        }
    });

    it('is what the Edge Functions record and mail', async () => {
        // Consent records and purchase emails are written server-side: a
        // version bumped on one side only would store the wrong one.
        expect(SERVER_LEGAL_VERSIONS.terms).toBe(LEGAL_VERSIONS.terms);
        expect(SERVER_LEGAL_VERSIONS.refunds).toBe(LEGAL_VERSIONS.refunds);
        expect(SERVER_LEGAL_VERSIONS).toEqual((await loadWithShareV2(false)).LEGAL_VERSIONS);
        expect(SERVER_LEGAL_VERSIONS.children).toBe('2026-11-12-draft');
        expect(LEGAL_OPERATOR).toEqual({
            name: LEGAL_ENTITY.name,
            postalAddress: LEGAL_ENTITY.postalAddress,
            legalEmail: LEGAL_ENTITY.emails.legal,
            privacyEmail: LEGAL_ENTITY.emails.privacy,
            supportEmail: LEGAL_ENTITY.emails.support,
            website: LEGAL_ENTITY.website,
        });
    });

    it('is pinned to the published stamps, on both sides', async () => {
        const off = await loadWithShareV2(false);
        expect(off.LEGAL_VERSIONS).toEqual(PUBLISHED_VERSIONS);
        expect(SERVER_LEGAL_VERSIONS).toEqual(PUBLISHED_VERSIONS);
    });

    it('bumps only the privacy and children stamps when Share v2 is on', async () => {
        const on = await loadWithShareV2(true);
        expect(on.LEGAL_VERSIONS).toEqual(PUBLISHED_SHARE_V2_VERSIONS);
        expect(on.LEGAL_LAST_UPDATED).toEqual({
            privacy: '14 November 2026',
            children: '14 November 2026',
            terms: '20 October 2026',
            refunds: '20 October 2026',
            copyright: '20 October 2026',
        });
    });

    it('mirrors the Share v2 stamps on the server, which records only terms and refunds', () => {
        expect(SERVER_SHARE_V2_LEGAL_VERSIONS).toEqual(SHARE_V2_LEGAL_VERSIONS);
        expect(Object.keys(SHARE_V2_LEGAL_VERSIONS).sort()).toEqual(['children', 'privacy']);
    });
});
