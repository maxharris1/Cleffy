// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CHILDREN_NOTICE } from '@/features/legal/childrenNotice';
import { TERMS_OF_SERVICE } from '@/features/legal/termsOfService';
import { features } from '@/lib/features';

describe('the Share v2 flag', () => {
    it('is off unless VITE_FEATURE_SHARE_V2 is set', () => {
        expect(features.shareV2).toBe(false);
    });

    it('drives the deprecated viewLinks alias, so the two cannot disagree', () => {
        expect(features.viewLinks).toBe(features.shareV2);
    });

    it('leaves the published Children’s Notice and Terms exactly as on dev while off', () => {
        // sha256 of JSON.stringify([CHILDREN_NOTICE, TERMS_OF_SERVICE]) built
        // from dev at 25aaefc0, before the flag was renamed.
        const digest = createHash('sha256')
            .update(JSON.stringify([CHILDREN_NOTICE, TERMS_OF_SERVICE]))
            .digest('hex');
        expect(digest).toBe('96a6de478cf0c78b6839dd1b614956144694d7dd4c88546f60b672e7bf7dfbf1');
    });
});
