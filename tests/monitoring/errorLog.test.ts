import { describe, expect, it, vi } from 'vitest';

import {
    buildErrorRecord,
    createErrorLogger,
    edgeEnvironment,
    parseSentryDsn,
    redact,
    sentryEnvelope,
} from '../../supabase/functions/_shared/errorLog';

const envOf =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
        values[name];

describe('redact', () => {
    it('removes emails, tokens, secret keys and URL query strings', () => {
        expect(
            redact(
                'customer teacher@example.com key sk_live_abcdef123456 at https://api.stripe.com/v1/x?expand=a Bearer eyJa.eyJb.sig1',
            ),
        ).toBe('customer [email] key [secret] at https://api.stripe.com/v1/x?[redacted] Bearer [token]');
    });
});

describe('buildErrorRecord', () => {
    it('keeps the error shape and ids, drops content and credentials from context', () => {
        const record = buildErrorRecord(
            'delete-account',
            new Error('could not cancel sub_123 for a@b.co'),
            {
                code: 'stripe_cancel_failed',
                userId: 'u-1',
                email: 'a@b.co',
                payload: { text: 'secret marks' },
                nested: { authorization: 'Bearer x', count: 2 },
            },
            new Date('2026-10-08T00:00:00Z'),
        );
        expect(record).toMatchObject({
            level: 'error',
            fn: 'delete-account',
            code: 'stripe_cancel_failed',
            errorName: 'Error',
            message: 'could not cancel sub_123 for [email]',
            context: { userId: 'u-1', nested: { count: 2 } },
            at: '2026-10-08T00:00:00.000Z',
        });
        expect(JSON.stringify(record)).not.toContain('a@b.co');
        expect(JSON.stringify(record)).not.toContain('secret marks');
    });

    it('describes the plain-object rejections supabase-js and Stripe produce', () => {
        const record = buildErrorRecord('fn', { message: 'duplicate key', code: '23505' });
        expect(record.errorName).toBe('23505');
        expect(record.message).toBe('duplicate key');
        expect(buildErrorRecord('fn', 'just a string').message).toBe('just a string');
        const cyclic: Record<string, unknown> = {};
        cyclic['self'] = cyclic;
        expect(buildErrorRecord('fn', cyclic).message).toBe('[object Object]');
    });
});

describe('parseSentryDsn', () => {
    it('derives the envelope endpoint', () => {
        expect(parseSentryDsn('https://abc123@o42.ingest.us.sentry.io/4507')).toEqual({
            dsn: 'https://abc123@o42.ingest.us.sentry.io/4507',
            publicKey: 'abc123',
            envelopeUrl: 'https://o42.ingest.us.sentry.io/api/4507/envelope/',
        });
        expect(parseSentryDsn('https://k@self.hosted/sentry/7')?.envelopeUrl).toBe(
            'https://self.hosted/sentry/api/7/envelope/',
        );
    });

    it('turns forwarding off for anything malformed', () => {
        expect(parseSentryDsn(undefined)).toBeNull();
        expect(parseSentryDsn('')).toBeNull();
        expect(parseSentryDsn('not a url')).toBeNull();
        expect(parseSentryDsn('https://o42.ingest.sentry.io/4507')).toBeNull();
        expect(parseSentryDsn('https://k@o42.ingest.sentry.io/notanumber')).toBeNull();
    });
});

describe('edgeEnvironment', () => {
    it('names the project from SUPABASE_URL unless overridden', () => {
        expect(edgeEnvironment(envOf({ SUPABASE_URL: 'https://jibgwgosihadbjgxdsfe.supabase.co' }))).toBe('production');
        expect(edgeEnvironment(envOf({ SUPABASE_URL: 'https://qdbnlrgylelelvwbkvnm.supabase.co' }))).toBe(
            'development',
        );
        expect(edgeEnvironment(envOf({ SUPABASE_URL: 'http://kong:8000' }))).toBe('local');
        expect(edgeEnvironment(envOf({ SENTRY_ENVIRONMENT: 'staging' }))).toBe('staging');
    });
});

describe('sentryEnvelope', () => {
    it('is three JSON lines: envelope header, item header, event', () => {
        const target = parseSentryDsn('https://abc@o1.ingest.sentry.io/9');
        if (!target) {
            throw new Error('dsn did not parse');
        }
        const record = buildErrorRecord('stripe-webhook', new Error('boom'), { code: 'x' });
        const lines = sentryEnvelope(record, target, 'production', 'cleffy@abc', 'f'.repeat(32)).split('\n');
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0] ?? '')).toMatchObject({ event_id: 'f'.repeat(32), dsn: target.dsn });
        expect(JSON.parse(lines[1] ?? '')).toEqual({ type: 'event' });
        expect(JSON.parse(lines[2] ?? '')).toMatchObject({
            event_id: 'f'.repeat(32),
            environment: 'production',
            release: 'cleffy@abc',
            tags: { function: 'stripe-webhook', code: 'x' },
            exception: { values: [{ type: 'Error', value: 'boom' }] },
        });
    });
});

describe('createErrorLogger', () => {
    it('logs one JSON line and posts nothing without a DSN', async () => {
        const log = vi.fn();
        const fetchImpl = vi.fn();
        const logger = createErrorLogger({ env: envOf({}), fetch: fetchImpl, log });
        await logger('fn', new Error('x'), { code: 'c' });
        expect(log).toHaveBeenCalledTimes(1);
        expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({ fn: 'fn', code: 'c', message: 'x' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('forwards to the envelope endpoint with the public key when SENTRY_DSN is set', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const logger = createErrorLogger({
            env: envOf({ SENTRY_DSN: 'https://pub@o1.ingest.sentry.io/9' }),
            fetch: fetchImpl as unknown as typeof fetch,
            log: () => undefined,
        });
        await logger('fn', new Error('x'));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://o1.ingest.sentry.io/api/9/envelope/');
        expect((init.headers as Record<string, string>)['X-Sentry-Auth']).toContain('sentry_key=pub');
    });

    it('never rejects, even when Sentry is unreachable or hangs', async () => {
        const failing = createErrorLogger({
            env: envOf({ SENTRY_DSN: 'https://pub@o1.ingest.sentry.io/9' }),
            fetch: (async () => {
                throw new Error('network down');
            }) as unknown as typeof fetch,
            log: () => undefined,
        });
        await expect(failing('fn', new Error('x'))).resolves.toBeUndefined();

        const hanging = createErrorLogger({
            env: envOf({ SENTRY_DSN: 'https://pub@o1.ingest.sentry.io/9' }),
            fetch: ((_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })) as unknown as typeof fetch,
            log: () => undefined,
            timeoutMs: 10,
        });
        await expect(hanging('fn', new Error('x'))).resolves.toBeUndefined();
    });
});
