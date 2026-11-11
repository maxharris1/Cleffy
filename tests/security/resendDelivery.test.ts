// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
    classifyResendStatus,
    RESEND_EMAILS_URL,
    RESEND_IDEMPOTENCY_KEY_MAX,
    resendIdempotencyKey,
    type ResendEmail,
    sendViaResend,
} from '../../supabase/functions/_shared/resendDelivery';

/**
 * The one way an outbox mails through Resend (_shared/resendDelivery.ts): a
 * key derived from the row, sent as Idempotency-Key, and every result placed
 * as sent, rejected (refund) or unknown (keep the reservation, retry with the
 * same key). Codex round 3, new major on #62: an accepted email whose answer
 * was lost used to be refunded and sent again.
 */

const ROW = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_ROW = '0b5e0000-0000-4000-8000-0000000000c1';

const EMAIL: ResendEmail = {
    from: 'Cleffy <noreply@cleffy.io>',
    to: ['ada@example.com'],
    subject: 'Your Cleffy subscription',
    text: 'Thanks.',
    html: '<p>Thanks.</p>',
};

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** fetch that answers with `respond` and remembers every request it was given. */
const fakeFetch = (respond: (init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init: RequestInit; headers: Record<string, string> }> = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> });
        return respond(init ?? {});
    });
    return { fetch: fn as unknown as typeof fetch, calls };
};

const send = (respond: (init: RequestInit) => Response | Promise<Response>, overrides = {}) => {
    const fake = fakeFetch(respond);
    return {
        ...fake,
        result: sendViaResend({
            apiKey: 're_test_key',
            idempotencyKey: resendIdempotencyKey('billing-outbox', ROW),
            email: EMAIL,
            fetch: fake.fetch,
            ...overrides,
        }),
    };
};

describe('resendIdempotencyKey', () => {
    it('is the same on every retry of a row, and different for every other row', () => {
        const first = resendIdempotencyKey('billing-outbox', ROW);
        expect(first).toBe(`billing-outbox-${ROW}`);
        expect(resendIdempotencyKey('billing-outbox', ROW)).toBe(first);
        expect(resendIdempotencyKey('billing-outbox', OTHER_ROW)).not.toBe(first);
        // And for the same row id in another outbox.
        expect(resendIdempotencyKey('district-notice', ROW)).not.toBe(first);
    });

    it('cannot carry an address or other personal text', () => {
        for (const rowId of ['ada@example.com', 'Ada Lovelace', 'a.b', '', 'row/1']) {
            expect(() => resendIdempotencyKey('billing-outbox', rowId), rowId).toThrow();
        }
        for (const outbox of ['Billing', 'billing outbox', 'billing@outbox', '-billing', '']) {
            expect(() => resendIdempotencyKey(outbox, ROW), outbox).toThrow();
        }
    });

    it("stays inside Resend's 256 characters", () => {
        const longest = 'r'.repeat(RESEND_IDEMPOTENCY_KEY_MAX - 'billing-outbox-'.length);
        expect(resendIdempotencyKey('billing-outbox', longest)).toHaveLength(RESEND_IDEMPOTENCY_KEY_MAX);
        expect(() => resendIdempotencyKey('billing-outbox', `${longest}r`)).toThrow();
    });
});

describe('sendViaResend', () => {
    it('sends the Idempotency-Key header with the email', async () => {
        const h = send(() => json({ id: 'email_1' }, 200));
        expect(await h.result).toEqual({ outcome: 'sent', reason: 'sent', status: 200, id: 'email_1' });
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]?.url).toBe(RESEND_EMAILS_URL);
        expect(h.calls[0]?.init.method).toBe('POST');
        expect(h.calls[0]?.headers['Idempotency-Key']).toBe(`billing-outbox-${ROW}`);
        expect(h.calls[0]?.headers.Authorization).toBe('Bearer re_test_key');
        expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual(EMAIL);
    });

    describe('places every answer as sent, rejected or unknown', () => {
        it.each([
            [200, 'sent'],
            [201, 'sent'],
            [202, 'sent'],
        ] as const)('%s with an id is %s', async (status, outcome) => {
            expect((await send(() => json({ id: 'email_1' }, status)).result).outcome).toBe(outcome);
        });

        it.each([400, 401, 403, 404, 405, 413, 422])('%s is a definite rejection', async (status) => {
            const result = await send(() => json({ name: 'validation_error', message: 'no' }, status)).result;
            expect(result).toMatchObject({
                outcome: 'rejected',
                reason: `http_${status}`,
                status,
                errorName: 'validation_error',
            });
        });

        it('429 is a rejection -- Resend sent nothing -- and carries its Retry-After', async () => {
            const result = await send(() =>
                json({ name: 'rate_limit_exceeded', message: 'slow down' }, 429, { 'Retry-After': '7' }),
            ).result;
            expect(result).toMatchObject({ outcome: 'rejected', status: 429, retryAfterMs: 7000 });
        });

        it.each([
            [409, 'concurrent_idempotent_requests'],
            [409, 'invalid_idempotent_request'],
            [408, 'request_timeout'],
        ])('%s (%s) is unknown: an earlier request with this key may have sent', async (status, name) => {
            const result = await send(() => json({ name, message: '' }, status)).result;
            expect(result).toMatchObject({ outcome: 'unknown', status, errorName: name });
        });

        it.each([500, 502, 503, 504])('%s is unknown', async (status) => {
            expect(await send(() => new Response('upstream', { status })).result).toMatchObject({
                outcome: 'unknown',
                reason: `http_${status}`,
            });
        });

        it('a 2xx that is not an answer (no id, not JSON, cut off) is unknown, not sent', async () => {
            expect((await send(() => json({}, 200)).result).outcome).toBe('unknown');
            expect((await send(() => new Response('<html>', { status: 200 })).result).outcome).toBe('unknown');
            const cutOff = new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"id":'));
                        controller.error(new TypeError('connection reset'));
                    },
                }),
                { status: 200 },
            );
            expect(await send(() => cutOff).result).toMatchObject({
                outcome: 'unknown',
                reason: 'unparseable_response',
            });
        });

        it('a connection reset once the request was attempted is unknown', async () => {
            const result = await send(() => {
                throw new TypeError('fetch failed: ECONNRESET');
            }).result;
            expect(result).toEqual({ outcome: 'unknown', reason: 'network', status: null });
        });

        it('an abort or a timeout is unknown', async () => {
            const aborted = await send(() => {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }).result;
            expect(aborted).toMatchObject({ outcome: 'unknown', reason: 'timeout' });

            // A Resend that never answers: our own timeout aborts it.
            const hanging = send(
                (init) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () =>
                            reject(new DOMException('The operation was aborted.', 'AbortError')),
                        );
                    }),
                { timeoutMs: 5 },
            );
            expect(await hanging.result).toMatchObject({ outcome: 'unknown', reason: 'timeout' });
        });

        it.each([3, 1])('the classification table never calls a %sxx sent', (hundreds) => {
            expect(classifyResendStatus(hundreds * 100 + 2)).toBe('unknown');
        });

        it('what fails before a request exists is a rejection, and nothing is fetched', async () => {
            const cases: Array<[string, Partial<Parameters<typeof sendViaResend>[0]>, string]> = [
                ['no API key', { apiKey: undefined }, 'unconfigured'],
                ['an empty API key', { apiKey: '' }, 'unconfigured'],
                ['an empty key', { idempotencyKey: '' }, 'invalid_request'],
                ['a key over 256', { idempotencyKey: 'k'.repeat(257) }, 'invalid_request'],
                ['a key with a space', { idempotencyKey: 'billing outbox' }, 'invalid_request'],
                ['no recipient', { email: { ...EMAIL, to: [] } }, 'invalid_request'],
                ['no sender', { email: { ...EMAIL, from: '' } }, 'invalid_request'],
            ];
            for (const [label, overrides, reason] of cases) {
                const h = send(() => json({ id: 'email_1' }, 200), overrides);
                expect(await h.result, label).toEqual({ outcome: 'rejected', reason, status: null });
                expect(h.calls, label).toHaveLength(0);
            }
        });
    });

    it('never throws', async () => {
        const result = await send(() => {
            throw 'not even an Error';
        }).result;
        expect(result.outcome).toBe('unknown');
    });
});

/**
 * Resend's documented idempotency, modelled: a key seen with the same payload
 * in the last 24 hours replays the first answer without sending; with another
 * payload it is a 409.
 */
class FakeResend {
    delivered: Array<{ key: string; body: string }> = [];
    private seen = new Map<string, { body: string; id: string }>();
    /** Accept the next request, then drop the connection before answering. */
    dropNextAnswer = false;

    fetch = (async (_url: string, init: RequestInit) => {
        const key = (init.headers as Record<string, string>)['Idempotency-Key'] ?? '';
        const body = String(init.body);
        const prior = this.seen.get(key);
        if (prior) {
            return prior.body === body
                ? json({ id: prior.id }, 200)
                : json({ name: 'invalid_idempotent_request', message: 'different payload' }, 409);
        }
        const id = `email_${this.delivered.length + 1}`;
        this.seen.set(key, { body, id });
        this.delivered.push({ key, body });
        if (this.dropNextAnswer) {
            this.dropNextAnswer = false;
            throw new TypeError('fetch failed: other side closed (ECONNRESET)');
        }
        return json({ id }, 200);
    }) as unknown as typeof fetch;
}

describe('an email Resend accepted whose answer was lost', () => {
    it('is unknown, and its retry with the same key is answered without a second email', async () => {
        const resend = new FakeResend();
        const attempt = () =>
            sendViaResend({
                apiKey: 're_test_key',
                idempotencyKey: resendIdempotencyKey('billing-outbox', ROW),
                email: EMAIL,
                fetch: resend.fetch,
            });

        resend.dropNextAnswer = true;
        expect(await attempt()).toMatchObject({ outcome: 'unknown', reason: 'network' });
        expect(resend.delivered).toHaveLength(1);

        expect(await attempt()).toMatchObject({ outcome: 'sent', id: 'email_1' });
        expect(resend.delivered).toHaveLength(1);
        expect(resend.delivered[0]?.key).toBe(`billing-outbox-${ROW}`);
    });
});
