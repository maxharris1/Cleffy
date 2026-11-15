import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as FeaturesModule from '@/lib/features';

/**
 * With VITE_FEATURE_SHARE_V2 off, the Privacy Policy, the Children's Notice
 * and their stamps read exactly as they did before the Share v2 text landed.
 * The snapshot was taken at dev's text; it must not change while the flag
 * stays off.
 */
const loadWithShareV2Off = async () => {
    vi.resetModules();
    vi.doMock('@/lib/features', async (importOriginal) => {
        const actual = await importOriginal<typeof FeaturesModule>();
        return { features: { ...actual.features, shareV2: false } };
    });
    const content = await import('@/features/legal/legalContent');
    const versions = await import('@/features/legal/legalVersions');
    return { ...content, ...versions };
};

afterEach(() => {
    vi.doUnmock('@/lib/features');
    vi.resetModules();
});

describe('legal text with Share v2 off', () => {
    it('reads as before', async () => {
        const { LEGAL_DOCUMENTS, legalText, LEGAL_VERSIONS, LEGAL_LAST_UPDATED } = await loadWithShareV2Off();
        for (const id of ['privacy', 'children'] as const) {
            const doc = LEGAL_DOCUMENTS[id];
            expect([doc.title, doc.summary, legalText(doc)].join('\n')).toMatchSnapshot(id);
            expect({ version: LEGAL_VERSIONS[id], lastUpdated: LEGAL_LAST_UPDATED[id] }).toMatchSnapshot(
                `${id} stamps`,
            );
        }
    });
});
