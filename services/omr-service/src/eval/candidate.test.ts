import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION } from '../job.js';
import { artifactCacheKey, assertDocumentReady, DOCUMENT_ID_RE } from './candidate.js';

describe('artifactCacheKey', () => {
    const sha = 'ab'.repeat(32);

    it('includes the full PDF digest and ENGINE_VERSION (+svc-N)', () => {
        const key = artifactCacheKey(sha, '-option Book.Lyrics=false');
        expect(key.startsWith(sha)).toBe(true);
        expect(key).toContain(ENGINE_VERSION.match(/svc-\d+$/)?.[0]);
        expect(ENGINE_VERSION).toMatch(/\+svc-\d+$/);
        expect(key).toContain(ENGINE_VERSION.replace(/[^a-zA-Z0-9._+-]+/g, '_'));
        expect(key.length).toBeGreaterThan(sha.length + ENGINE_VERSION.length);
    });

    it('does not collide when options share a 48-char prefix', () => {
        const a = `${'x'.repeat(48)}-one`;
        const b = `${'x'.repeat(48)}-two`;
        expect(artifactCacheKey(sha, a)).not.toBe(artifactCacheKey(sha, b));
    });
});

describe('fromDocument guards', () => {
    it('accepts UUIDs only', () => {
        expect(DOCUMENT_ID_RE.test('dcca6082-3b58-42a6-a643-de6f196ef9f9')).toBe(true);
        expect(DOCUMENT_ID_RE.test('not-a-uuid')).toBe(false);
    });

    it('requires ready + title + owner', () => {
        expect(() => assertDocumentReady('pending', 'Moonlight', 'owner')).toThrow(/ready/);
        expect(() => assertDocumentReady('ready', '', 'owner')).toThrow(/title/);
        expect(() => assertDocumentReady('ready', 'Moonlight', '')).toThrow(/owner/);
        expect(() => assertDocumentReady('ready', 'Moonlight', 'owner')).not.toThrow();
    });
});
