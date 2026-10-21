import { describe, expect, it, vi } from 'vitest';

import {
    outboxIdempotencyKey,
    refundsMailBudget,
    resendStatusOutcome,
    sendViaResend,
} from '../../supabase/functions/_shared/mailDelivery';

/**
 * The send contract every outbox sender follows: an outcome that may have
 * delivered keeps its mail-budget reservation; only a definite refusal hands
 * it back; and the Idempotency-Key is the outbox row's, the same on every
 * attempt.
 */
describe('what a Resend answer says about the mail', () => {
    it.each([
        [200, 'sent'],
        [202, 'sent'],
        [400, 'rejected'],
        [401, 'rejected'],
        [403, 'rejected'],
        [422, 'rejected'],
        [408, 'unknown'],
        [409, 'unknown'],
        [429, 'unknown'],
        [500, 'unknown'],
        [502, 'unknown'],
        [503, 'unknown'],
    ] as const)('%i is %s', (status, outcome) => {
        expect(resendStatusOutcome(status)).toBe(outcome);
    });

    it('refunds the budget only when no mail can have gone out', () => {
        expect(refundsMailBudget('rejected')).toBe(true);
        expect(refundsMailBudget('unconfigured')).toBe(true);
        expect(refundsMailBudget('unknown')).toBe(false);
        expect(refundsMailBudget('sent')).toBe(false);
    });

    it('keys a send by its outbox row, not its attempt', () => {
        expect(outboxIdempotencyKey('content_notice_outbox', 'abc')).toBe('content_notice_outbox/abc');
        expect(outboxIdempotencyKey('content_notice_outbox', 'abc')).toBe(
            outboxIdempotencyKey('content_notice_outbox', 'abc'),
        );
        expect(outboxIdempotencyKey('billing_mail_outbox', 'abc')).not.toBe(
            outboxIdempotencyKey('content_notice_outbox', 'abc'),
        );
    });
});

describe('sendViaResend', () => {
    const send = (fetchImpl: typeof fetch, apiKey: string | null = 're_test') => {
        const failures: Array<[number | null, string]> = [];
        const outcome = sendViaResend({
            apiKey: apiKey ?? undefined,
            idempotencyKey: 'content_notice_outbox/n1',
            body: { to: ['a@example.com'], subject: 'S', text: 'T' },
            onFailure: (status, detail) => failures.push([status, detail]),
            fetch: fetchImpl,
            timeoutMs: 50,
        });
        return { outcome, failures };
    };

    it('sends the Idempotency-Key it was given, on every attempt', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
        await send(fetchImpl as unknown as typeof fetch).outcome;
        await send(fetchImpl as unknown as typeof fetch).outcome;
        const keys = fetchImpl.mock.calls.map(
            (call) =>
                ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'],
        );
        expect(keys).toEqual(['content_notice_outbox/n1', 'content_notice_outbox/n1']);
    });

    it('a network error is unknown, not a refusal', async () => {
        const { outcome, failures } = send((async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof fetch);
        expect(await outcome).toBe('unknown');
        expect(failures[0]?.[0]).toBeNull();
    });

    it('a timeout is unknown', async () => {
        const hang = ((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
            })) as unknown as typeof fetch;
        expect(await send(hang).outcome).toBe('unknown');
    });

    it('a 5xx is unknown and a 4xx validation error is a rejection', async () => {
        expect(await send((async () => new Response('down', { status: 503 })) as unknown as typeof fetch).outcome).toBe(
            'unknown',
        );
        const { outcome, failures } = send(
            (async () => new Response('{"name":"validation_error"}', { status: 422 })) as unknown as typeof fetch,
        );
        expect(await outcome).toBe('rejected');
        expect(failures).toEqual([[422, '{"name":"validation_error"}']]);
    });

    it('makes no request without a key', async () => {
        const fetchImpl = vi.fn();
        expect(await send(fetchImpl as unknown as typeof fetch, null).outcome).toBe('unconfigured');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
