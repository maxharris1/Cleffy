import { describe, expect, it } from 'vitest';

import { corpusOwnerUserId, isCorpusLookupEnabled } from './flag.js';

describe('isCorpusLookupEnabled', () => {
    it('is off when unset (prod default)', () => {
        expect(isCorpusLookupEnabled(undefined)).toBe(false);
        expect(isCorpusLookupEnabled('')).toBe(false);
        expect(isCorpusLookupEnabled('  ')).toBe(false);
    });

    it('treats 1/true/on/yes as on', () => {
        expect(isCorpusLookupEnabled('1')).toBe(true);
        expect(isCorpusLookupEnabled('TRUE')).toBe(true);
        expect(isCorpusLookupEnabled('on')).toBe(true);
        expect(isCorpusLookupEnabled('yes')).toBe(true);
    });

    it('treats 0/false/off/no/unknown as off', () => {
        expect(isCorpusLookupEnabled('0')).toBe(false);
        expect(isCorpusLookupEnabled('false')).toBe(false);
        expect(isCorpusLookupEnabled('off')).toBe(false);
        expect(isCorpusLookupEnabled('maybe')).toBe(false);
    });
});

describe('corpusOwnerUserId', () => {
    it('is null when unset or blank, else the trimmed id', () => {
        expect(corpusOwnerUserId(undefined)).toBeNull();
        expect(corpusOwnerUserId('  ')).toBeNull();
        expect(corpusOwnerUserId(' 11111111-1111-1111-1111-111111111111 ')).toBe(
            '11111111-1111-1111-1111-111111111111',
        );
    });
});
