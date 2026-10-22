import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CONTROL_BODY_MAX_BYTES,
    readCappedBytes,
    readCappedJson,
    readCappedJsonObject,
    readCappedText,
    WEBHOOK_BODY_MAX_BYTES,
} from '../../supabase/functions/_shared/readCappedJson';
import { buildSignatureHeader, verifyStripeSignature } from '../../supabase/functions/_shared/stripeSignature';
import { buildSvixSignatureHeader, verifySvixSignature } from '../../supabase/functions/_shared/svixSignature';
import { chunkedJson, chunkedRequest } from './chunkedBody';

/**
 * Every Edge Function reads its request body through readCappedJson.ts: a cap
 * counted on the bytes as they stream, never on Content-Length. The handlers
 * whose code vitest can load are tested in their own files (student-login,
 * stripe-checkout, billing-cancel, guest-email, content-report and
 * content-moderation, resend-inbound); the Deno-only entry points are held
 * here by reading their source.
 */

const FUNCTIONS = resolve(__dirname, '../../supabase/functions');
const source = (path: string): string => readFileSync(join(FUNCTIONS, path), 'utf8');

const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });

describe('readCappedBytes / readCappedJson', () => {
    it('refuses a chunked body past the cap without trusting any header, and stops reading', async () => {
        const { request, pulled } = chunkedRequest(10 * CONTROL_BODY_MAX_BYTES, { chunkBytes: 1024 });
        expect(await readCappedBytes(request, CONTROL_BODY_MAX_BYTES)).toEqual({ ok: false, status: 413 });
        // It stopped one chunk past the cap, not at the end of the stream.
        expect(pulled()).toBeLessThanOrEqual(CONTROL_BODY_MAX_BYTES + 2 * 1024);
    });

    it('refuses an oversize body whose Content-Length understates it', async () => {
        const request = new Request('https://edge.test/fn', {
            method: 'POST',
            headers: { 'content-length': '10' },
            body: JSON.stringify({ a: 'x'.repeat(CONTROL_BODY_MAX_BYTES) }),
        });
        expect(await readCappedJson(request, CONTROL_BODY_MAX_BYTES)).toEqual({ ok: false, status: 413 });
    });

    it('reads a body under the cap whatever Content-Length claims', async () => {
        const request = chunkedJson({ documentId: 'd' }, 1000, { headers: { 'content-length': '999999999' } });
        const read = await readCappedJsonObject(request, CONTROL_BODY_MAX_BYTES);
        expect(read.ok && read.value['documentId']).toBe('d');
    });

    it('accepts exactly the cap and refuses one byte more', async () => {
        const at = chunkedRequest(CONTROL_BODY_MAX_BYTES, { chunkBytes: 3000 });
        const read = await readCappedBytes(at.request, CONTROL_BODY_MAX_BYTES);
        expect(read.ok && read.value.byteLength).toBe(CONTROL_BODY_MAX_BYTES);
        const over = chunkedRequest(CONTROL_BODY_MAX_BYTES + 1, { chunkBytes: 3000 });
        expect(await readCappedBytes(over.request, CONTROL_BODY_MAX_BYTES)).toEqual({ ok: false, status: 413 });
    });

    it('checks the JSON shape: invalid JSON, null, arrays and scalars are 400', async () => {
        const post = (body: string) => new Request('https://edge.test/fn', { method: 'POST', body });
        expect(await readCappedJson(post('{nope'), 100)).toEqual({ ok: false, status: 400 });
        for (const body of ['null', '[1]', '"x"', '3']) {
            expect(await readCappedJsonObject(post(body), 100)).toEqual({ ok: false, status: 400 });
        }
        expect(await readCappedJsonObject(new Request('https://edge.test/fn', { method: 'POST' }), 100)).toEqual({
            ok: false,
            status: 400,
        });
    });

    it('decodes text exactly as Request.text() does, multi-byte and invalid sequences included', async () => {
        const bytes = new Uint8Array([...new TextEncoder().encode('{"n":"Dvořák — 𝄞"}'), 0xff, 0xfe]);
        const capped = await readCappedText(new Request('https://edge.test/', { method: 'POST', body: bytes }), 1024);
        const plain = await new Request('https://edge.test/', { method: 'POST', body: bytes }).text();
        expect(capped).toEqual({ ok: true, value: plain });
    });
});

describe('webhook bodies: the signature is verified over exactly the capped bytes', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { note: 'Ünïcödé — 𝄞' } });
    const streamed = (headers: Record<string, string>): Request => {
        const bytes = new TextEncoder().encode(payload);
        return new Request('https://edge.test/webhook', {
            method: 'POST',
            headers,
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let i = 0; i < bytes.length; i += 7) {
                        controller.enqueue(bytes.slice(i, i + 7));
                    }
                    controller.close();
                },
            }),
            duplex: 'half',
        } as RequestInit);
    };

    it('Stripe: a chunked, multi-byte event still verifies', async () => {
        const now = 1_800_000_000;
        const header = await buildSignatureHeader(now, payload, 'whsec_test_secret');
        const read = await readCappedText(streamed({ 'stripe-signature': header }), WEBHOOK_BODY_MAX_BYTES);
        expect(read.ok).toBe(true);
        expect((await verifyStripeSignature(read.ok ? read.value : '', header, 'whsec_test_secret', now)).ok).toBe(
            true,
        );
    });

    it('Svix (Resend): a chunked, multi-byte event still verifies', async () => {
        const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
        const timestamp = '1800000000';
        const signature = (await buildSvixSignatureHeader('msg_1', timestamp, payload, secret)) ?? '';
        const read = await readCappedText(streamed({}), WEBHOOK_BODY_MAX_BYTES);
        const check = await verifySvixSignature(
            read.ok ? read.value : '',
            { id: 'msg_1', timestamp, signature },
            secret,
            1_800_000_000,
        );
        expect(check.ok).toBe(true);
    });

    it('a chunked webhook body past 256 KiB is refused before any verification', async () => {
        const { request } = chunkedRequest(WEBHOOK_BODY_MAX_BYTES + 1);
        expect(await readCappedText(request, WEBHOOK_BODY_MAX_BYTES)).toEqual({ ok: false, status: 413 });
        expect(WEBHOOK_BODY_MAX_BYTES).toBe(256 * 1024);
    });

    it('stripe-webhook and resend-inbound read their raw body capped, before verifying it', () => {
        for (const [path, verify] of [
            ['stripe-webhook/index.ts', 'verifyStripeSignature(rawBody'],
            ['resend-inbound/index.ts', 'verifySvixSignature('],
        ] as const) {
            const text = source(path);
            const read = text.indexOf('readCappedText(req, WEBHOOK_BODY_MAX_BYTES)');
            expect(read, path).toBeGreaterThan(-1);
            expect(text.indexOf(verify), path).toBeGreaterThan(read);
            expect(text, path).toContain('jsonResponse(PAYLOAD_TOO_LARGE, 413)');
        }
    });
});

describe('vision bodies: an explicit cap, streamed', () => {
    it('analyze-notes and analyze-annotations read through readCappedJson with their 8 MiB MAX_BODY_BYTES', () => {
        for (const path of ['analyze-notes/index.ts', 'analyze-annotations/index.ts']) {
            const text = source(path);
            expect(text, path).toMatch(/const MAX_BODY_BYTES = 8 \* 1024 \* 1024;/);
            expect(text, path).toContain('readCappedJson(req, MAX_BODY_BYTES)');
            expect(text, path).toContain('jsonResponse(PAYLOAD_TOO_LARGE, 413)');
        }
    });

    it('an 8 MiB cap refuses a chunked body one byte past it', async () => {
        const cap = 8 * 1024 * 1024;
        const { request, pulled } = chunkedRequest(cap + 1, { chunkBytes: 64 * 1024 });
        expect(await readCappedJson(request, cap)).toEqual({ ok: false, status: 413 });
        expect(pulled()).toBe(cap + 1);
    });
});

describe('control bodies: every Deno entry point is capped', () => {
    it.each([
        'delete-account/index.ts',
        'imslp-download/index.ts',
        'imslp-search/index.ts',
        'imslp-work/index.ts',
        'score-analyze/index.ts',
        'student-provision/index.ts',
        '_shared/analyzeScaffold.ts',
    ])('%s reads through readCappedJson at CONTROL_BODY_MAX_BYTES and answers 413', (path) => {
        const text = source(path);
        expect(text).toContain('readCappedJson(req, CONTROL_BODY_MAX_BYTES)');
        expect(text).toContain('jsonResponse(PAYLOAD_TOO_LARGE, 413)');
    });

    it.each([
        ['_shared/guestEmail.ts', 'deps.readJson(req, BODY_MAX_BYTES)'],
        ['_shared/checkoutFlow.ts', 'deps.readJson(req, BODY_MAX_BYTES)'],
        ['_shared/cancelFlow.ts', 'deps.readJson(req, BODY_MAX_BYTES)'],
        ['_shared/contentReports.ts', 'deps.readJson(req, REPORT_BODY_MAX_BYTES)'],
        ['student-login/handler.ts', 'deps.readJson(req, BODY_MAX_BYTES)'],
        ['student-claim/handler.ts', 'deps.readJson(req, BODY_MAX_BYTES)'],
    ])('%s reads through the injected capped reader', (path, call) => {
        expect(source(path)).toContain(call);
    });

    it('every function wiring that takes readJson is given the real readCappedJson', () => {
        for (const path of [
            '_shared/guestEmailWiring.ts',
            '_shared/contentReportsWiring.ts',
            'billing-cancel/index.ts',
            'stripe-checkout/index.ts',
            'student-login/index.ts',
            'student-claim/index.ts',
        ]) {
            expect(source(path), path).toContain('readJson: readCappedJson,');
        }
    });

    it('no function reads a request body any other way', () => {
        const uncapped = /\b(?:req|request)\.(?:json|text|arrayBuffer|formData|blob)\(\)/;
        const offenders = walk(FUNCTIONS)
            .filter((path) => !path.endsWith('_shared/ipv4Fetch.ts'))
            .filter((path) => uncapped.test(readFileSync(path, 'utf8')))
            .map((path) => path.slice(FUNCTIONS.length + 1));
        expect(offenders).toEqual([]);
    });
});
