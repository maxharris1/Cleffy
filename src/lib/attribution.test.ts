import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ATTRIBUTION_STORAGE_KEY,
    ATTRIBUTION_TTL_MS,
    captureAttribution,
    parseUtm,
    readAttribution,
    resetAttributionForTests,
} from '@/lib/attribution';

const T0 = Date.parse('2026-11-12T10:00:00.000Z');

const at = (pathname: string, search: string) => ({ pathname, search });

beforeEach(() => {
    window.localStorage.clear();
    resetAttributionForTests();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('parseUtm', () => {
    it('keeps the five utm_ tags that match the whitelist, and nothing else', () => {
        expect(
            parseUtm(
                '?utm_source=newsletter&utm_medium=email&utm_campaign=launch_v1&utm_content=hero-a.2&utm_term=sight_reading' +
                    '&gclid=abc&fbclid=def&email=a%40b.c&utm_id=7',
            ),
        ).toEqual({
            utm_source: 'newsletter',
            utm_medium: 'email',
            utm_campaign: 'launch_v1',
            utm_content: 'hero-a.2',
            utm_term: 'sight_reading',
        });
    });

    it('drops a value with a space, a symbol, a non-ASCII letter, nothing at all, or over 100 characters', () => {
        expect(
            parseUtm(
                `?utm_source=a%20b&utm_medium=a%40b&utm_campaign=caf%C3%A9&utm_content=&utm_term=${'x'.repeat(101)}`,
            ),
        ).toEqual({});
        expect(parseUtm(`?utm_term=${'x'.repeat(100)}`)).toEqual({ utm_term: 'x'.repeat(100) });
    });
});

describe('captureAttribution and readAttribution', () => {
    it('stores the first touch with its route pattern and time, never the raw path', () => {
        captureAttribution(at('/join/s3cr3t-token', '?utm_campaign=launch_v1&utm_source=newsletter'), T0);

        const expected = {
            utm_campaign: 'launch_v1',
            utm_source: 'newsletter',
            landing_path: '/join/:token',
            first_seen_at: '2026-11-12T10:00:00.000Z',
        };
        expect(readAttribution(T0)).toEqual(expected);
        expect(JSON.parse(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)!)).toEqual(expected);
        expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).not.toContain('s3cr3t');
    });

    it('stores nothing for a visit with no valid tag', () => {
        captureAttribution(at('/try', '?utm_campaign=bad%20tag&ref=x'), T0);
        expect(readAttribution(T0)).toBeNull();
        expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();
    });

    it('keeps the first touch when a later visit carries other tags', () => {
        captureAttribution(at('/try', '?utm_campaign=launch_v1'), T0);
        captureAttribution(at('/', '?utm_campaign=other'), T0 + 1000);
        expect(readAttribution(T0 + 1000)).toEqual(expect.objectContaining({ utm_campaign: 'launch_v1' }));
    });

    it('expires 30 days after the first touch, and a new visit then becomes the first touch', () => {
        captureAttribution(at('/try', '?utm_campaign=launch_v1'), T0);
        expect(readAttribution(T0 + ATTRIBUTION_TTL_MS)).not.toBeNull();
        expect(readAttribution(T0 + ATTRIBUTION_TTL_MS + 1)).toBeNull();
        expect(window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY)).toBeNull();

        captureAttribution(at('/', '?utm_campaign=spring'), T0 + ATTRIBUTION_TTL_MS + 2);
        expect(readAttribution(T0 + ATTRIBUTION_TTL_MS + 2)).toEqual(
            expect.objectContaining({ utm_campaign: 'spring', landing_path: '/' }),
        );
    });

    it('ignores a stored value that was tampered with', () => {
        window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, '{not json');
        expect(readAttribution(T0)).toBeNull();

        window.localStorage.setItem(
            ATTRIBUTION_STORAGE_KEY,
            JSON.stringify({
                utm_campaign: 'launch v1',
                utm_source: 'ok',
                landing_path: '/try?x=1',
                first_seen_at: '2026-11-12T10:00:00.000Z',
                email: 'a@b.c',
            }),
        );
        expect(readAttribution(T0)).toEqual({ utm_source: 'ok', first_seen_at: '2026-11-12T10:00:00.000Z' });
    });

    it('works for this page load when storage throws, and never throws itself', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });

        expect(() => captureAttribution(at('/try', '?utm_campaign=launch_v1'), T0)).not.toThrow();
        expect(readAttribution(T0)).toEqual(expect.objectContaining({ utm_campaign: 'launch_v1' }));
        expect(readAttribution(T0 + ATTRIBUTION_TTL_MS + 1)).toBeNull();
    });
});
