import { describe, expect, it } from 'vitest';

import { isLinkSessionPath } from '@/features/share/linkPaths';

describe('isLinkSessionPath', () => {
    it('is true on /s and /join/… only', () => {
        expect(isLinkSessionPath('/s')).toBe(true);
        expect(isLinkSessionPath('/join/abc')).toBe(true);
        for (const path of ['/search', '/settings', '/join', '/library', '/invite', '/']) {
            expect(isLinkSessionPath(path)).toBe(false);
        }
    });
});
