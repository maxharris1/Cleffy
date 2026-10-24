import { describe, expect, it } from 'vitest';

import {
    environmentForHost,
    redactLocation,
    redactString,
    scrubBreadcrumb,
    scrubEvent,
    scrubValue,
} from '@/lib/monitoring/scrub';

describe('redactString', () => {
    it('removes email addresses', () => {
        expect(redactString('no account for Teacher.Name+x@example.co.uk, sorry')).toBe(
            'no account for [email], sorry',
        );
    });

    it('removes JWTs and bearer credentials', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl';
        expect(redactString(`token ${jwt} expired`)).toBe('token [token] expired');
        expect(redactString('Authorization: Bearer sb_secret_abc123')).toBe('Authorization: Bearer [token]');
    });

    it('drops query strings and fragments from URLs but keeps the path', () => {
        expect(
            redactString('GET https://x.supabase.co/storage/v1/object/sign/scores/doc/original.pdf?token=abc failed'),
        ).toBe('GET https://x.supabase.co/storage/v1/object/sign/scores/doc/original.pdf?[redacted] failed');
        expect(redactString('https://cleffy.io/auth/callback#access_token=abc&refresh_token=def')).toBe(
            'https://cleffy.io/auth/callback?[redacted]',
        );
        expect(redactString('wss://x.supabase.co/realtime/v1/websocket?apikey=k&vsn=1')).toBe(
            'wss://x.supabase.co/realtime/v1/websocket?[redacted]',
        );
    });
});

describe('share-link tokens', () => {
    it('are redacted from paths, absolute or relative, because the token is the credential', () => {
        expect(redactString('could not open https://cleffy.io/join/Zq9xK2abc')).toBe(
            'could not open https://cleffy.io/join/[token]',
        );
        expect(redactString('route /join/Zq9xK2abc/ failed')).toBe('route /join/[token]/ failed');
    });
});

describe('redactLocation', () => {
    it('keeps the path of an app-relative location and drops its query and fragment', () => {
        expect(redactLocation('/auth/callback?code=secret-pkce-code')).toBe('/auth/callback');
        expect(redactLocation('/login?next=/join/abc')).toBe('/login');
        expect(redactLocation('/update-password#access_token=abc')).toBe('/update-password');
        expect(redactLocation('/join/abc')).toBe('/join/[token]');
        expect(redactLocation('/library')).toBe('/library');
    });

    it('applies to navigation breadcrumbs', () => {
        expect(
            scrubBreadcrumb({ category: 'navigation', data: { from: '/join/tok123', to: '/doc/1?import=1#p2' } }),
        ).toEqual({ category: 'navigation', data: { from: '/join/[token]', to: '/doc/1' } });
    });
});

describe('scrubValue', () => {
    it('drops keys that name content or credentials, at any depth', () => {
        const scrubbed = scrubValue({
            documentId: 'doc-1',
            nested: { payload: { points: [1, 2] }, text: 'Watch bar 12', kind: 'stroke' },
            list: [{ email: 'a@b.co', page: 3 }],
            headers: { Authorization: 'Bearer x' },
        });
        expect(scrubbed).toEqual({
            documentId: 'doc-1',
            nested: { kind: 'stroke' },
            list: [{ page: 3 }],
        });
    });

    it('terminates on cyclic input', () => {
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic['self'] = cyclic;
        expect(() => scrubValue(cyclic)).not.toThrow();
    });
});

describe('scrubBreadcrumb', () => {
    it('drops console breadcrumbs entirely', () => {
        expect(scrubBreadcrumb({ category: 'console', message: 'Ignoring malformed annotation broadcast' })).toBeNull();
    });

    it('keeps a UI breadcrumb but drops its selector, which can carry names and titles', () => {
        for (const category of ['ui.click', 'ui.input']) {
            expect(
                scrubBreadcrumb({
                    category,
                    timestamp: 1,
                    message: 'button.roster-row[aria-label="Open Ada Lovelace’s assignments"]',
                }),
            ).toEqual({ category, timestamp: 1 });
        }
    });

    it('still redacts the message of other breadcrumbs', () => {
        expect(scrubBreadcrumb({ category: 'auth', message: 'signed in as a@b.co' })).toEqual({
            category: 'auth',
            message: 'signed in as [email]',
        });
    });

    it('keeps only safe data fields of a fetch breadcrumb, redacted', () => {
        const crumb = scrubBreadcrumb({
            category: 'fetch',
            data: {
                url: 'https://x.supabase.co/rest/v1/documents?owner_id=eq.1',
                method: 'GET',
                status_code: 500,
                request_body_size: 10,
                arguments: ['secret'],
            },
        });
        expect(crumb).toEqual({
            category: 'fetch',
            data: { url: 'https://x.supabase.co/rest/v1/documents', method: 'GET', status_code: 500 },
        });
    });
});

describe('scrubEvent', () => {
    it('reduces the user to an id and the request to url + method', () => {
        const event = scrubEvent({
            message: 'failed for someone@example.com',
            user: { id: 'user-1', email: 'someone@example.com', ip_address: '1.2.3.4', username: 'x' },
            request: {
                url: 'https://cleffy.io/join/abc?x=1',
                method: 'GET',
                headers: { Cookie: 'c' },
                cookies: { a: 'b' },
                data: 'raw',
            },
            extra: { annotations: [{ payload: {} }], docId: 'd' },
            exception: { values: [{ type: 'Error', value: 'Bearer abc.def broke' }] },
            breadcrumbs: [
                { category: 'console', message: 'payload {"text":"x"}' },
                { category: 'navigation', data: { from: '/library', to: '/doc/1?import=1' } },
            ],
        });
        expect(event['user']).toEqual({ id: 'user-1' });
        expect(event['request']).toEqual({ url: 'https://cleffy.io/join/[token]?[redacted]', method: 'GET' });
        expect(event['message']).toBe('failed for [email]');
        expect(event['extra']).toEqual({ docId: 'd' });
        expect(event['exception']).toEqual({ values: [{ type: 'Error', value: 'Bearer [token] broke' }] });
        expect(event['breadcrumbs']).toEqual([{ category: 'navigation', data: { from: '/library', to: '/doc/1' } }]);
    });

    it('drops a user with no id at all', () => {
        expect(scrubEvent({ user: { email: 'a@b.co' } })).not.toHaveProperty('user');
    });

    it('never echoes an email anywhere in the serialised event', () => {
        const event = scrubEvent({
            contexts: { state: { who: 'parent@family.org', nested: { deeper: ['kid@school.edu'] } } },
            tags: { route: '/account' },
        });
        expect(JSON.stringify(event)).not.toMatch(/@[a-z]+\.(org|edu)/);
    });
});

describe('environmentForHost', () => {
    it('maps the two storefront hosts and everything else', () => {
        expect(environmentForHost('cleffy.io')).toBe('production');
        expect(environmentForHost('www.cleffy.io')).toBe('production');
        expect(environmentForHost('dev.cleffy.io')).toBe('development');
        expect(environmentForHost('localhost')).toBe('local');
        expect(environmentForHost('192.168.1.20')).toBe('local');
        expect(environmentForHost('cleffy-git-dev.vercel.app')).toBe('preview');
    });
});
