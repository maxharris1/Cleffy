import { describe, expect, it } from 'vitest';

import { MAX_RETRY_AFTER_MS, noteRetryAfter, parseRetryAfter, takeRetryAfterHint } from '@/lib/retryAfter';

describe('parseRetryAfter', () => {
    it('reads delta-seconds', () => {
        expect(parseRetryAfter('12')).toBe(12_000);
        expect(parseRetryAfter(' 0 ')).toBe(0);
    });

    it('reads an HTTP date relative to now', () => {
        const now = Date.parse('2026-10-07T12:00:00Z');
        expect(parseRetryAfter('Wed, 07 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
        expect(parseRetryAfter('Wed, 07 Oct 2026 11:00:00 GMT', now)).toBe(0);
    });

    it('caps absurd waits and ignores garbage', () => {
        expect(parseRetryAfter('999999')).toBe(MAX_RETRY_AFTER_MS);
        expect(parseRetryAfter('soon')).toBeNull();
        expect(parseRetryAfter(null)).toBeNull();
    });
});

describe('Retry-After hint', () => {
    it('is recorded only for throttled responses and read once', () => {
        noteRetryAfter({ status: 500, headers: new Headers({ 'retry-after': '3' }) });
        expect(takeRetryAfterHint()).toBeUndefined();

        noteRetryAfter({ status: 503, headers: new Headers({ 'retry-after': '3' }) });
        expect(takeRetryAfterHint()).toBe(3000);
        expect(takeRetryAfterHint()).toBeUndefined();
    });

    it('goes stale', () => {
        noteRetryAfter({ status: 429, headers: new Headers({ 'retry-after': '3' }) });
        expect(takeRetryAfterHint(Date.now() + 60_000)).toBeUndefined();
    });
});
