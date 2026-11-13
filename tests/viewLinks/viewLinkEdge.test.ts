// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PROXY_HEADER,
    VIEW_PDF_PROXY_MAX_DEFAULT,
    VIEW_RATE_LIMIT,
    VIEW_SIGNED_URL_TTL_S,
    handleViewLink,
    viewRateLimitKey,
    type ViewLinkDeps,
    type ViewPollRow,
} from '../../supabase/functions/_shared/viewLink';
import { readCappedJson } from '../../supabase/functions/_shared/readCappedJson';
import { secretsEqual } from '../../supabase/functions/_shared/secretCompare';

/**
 * The view-link Edge Function's control flow (supabase/functions/_shared/
 * viewLink.ts), run for real against stubs. index.ts only wires these deps to
 * Supabase; the same file is what Deno loads.
 */

const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21);
const SECRET = 'proxy-secret-for-tests';

const POLL: ViewPollRow = {
    doc: { pages: 3, pdf_rev: 2 },
    pdf_bytes: 1_000_000,
    annotations: [
        {
            id: 'a1',
            page: 0,
            kind: 'stroke',
            color: '#000',
            payload: { pts: [0, 0, 1], w: 0.01 },
            seq: 7,
            deleted: false,
            // Never sent, even if the SQL ever returned it.
            created_by: 'user-uuid',
            email: 'teacher@example.test',
        } as never,
    ],
    max_seq: 7,
    more: false,
};

const env = (overrides: Record<string, string | undefined> = {}) => {
    const values: Record<string, string | undefined> = {
        VIEW_LINKS_ENABLED: '1',
        VIEW_PROXY_SECRET: SECRET,
        ...overrides,
    };
    return (name: string) => values[name];
};

const deps = (overrides: Partial<ViewLinkDeps> = {}): ViewLinkDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
        calls,
        env: env(),
        secretsEqual,
        readJson: readCappedJson,
        checkRateLimit: vi.fn(async (key: string) => {
            calls.push(`rate:${key}`);
            return { ok: true as const };
        }),
        poll: vi.fn(async (token: string, since: number) => {
            calls.push(`poll:${since}`);
            return token === TOKEN ? POLL : null;
        }),
        pdfObject: vi.fn(async (token: string) => {
            calls.push('pdfObject');
            return token === TOKEN ? { storagePath: 'doc/original.pdf', bytes: 1_000_000 } : null;
        }),
        download: vi.fn(async () => {
            calls.push('download');
            return new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]);
        }),
        signedUrl: vi.fn(async (_path: string, ttl: number) => {
            calls.push(`signedUrl:${ttl}`);
            return 'https://project.supabase.co/storage/v1/object/sign/scores/doc/original.pdf?token=sig';
        }),
        ...overrides,
    };
};

const post = (body: unknown, headers: Record<string, string> = { [PROXY_HEADER]: SECRET }, method = 'POST') =>
    new Request('https://edge.test/functions/v1/view-link', {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the server switch', () => {
    it('answers 404 and touches nothing while VIEW_LINKS_ENABLED is not 1', async () => {
        for (const value of [undefined, '', '0', 'true', 'yes']) {
            const d = deps({ env: env({ VIEW_LINKS_ENABLED: value }) });
            const res = await handleViewLink(post({ token: TOKEN }), d);
            expect(res.status).toBe(404);
            expect(d.calls).toEqual([]);
        }
    });
});

describe('the proxy secret', () => {
    it('refuses a request without the proxy header', async () => {
        const d = deps();
        const res = await handleViewLink(post({ token: TOKEN }, {}), d);
        expect(res.status).toBe(401);
        expect(d.calls).toEqual([]);
    });

    it('refuses a wrong secret', async () => {
        const d = deps();
        const res = await handleViewLink(post({ token: TOKEN }, { [PROXY_HEADER]: `${SECRET}x` }), d);
        expect(res.status).toBe(401);
        expect(d.calls).toEqual([]);
    });

    it('fails closed when VIEW_PROXY_SECRET is unset, even for an empty header', async () => {
        const d = deps({ env: env({ VIEW_PROXY_SECRET: undefined }) });
        const res = await handleViewLink(post({ token: TOKEN }, { [PROXY_HEADER]: '' }), d);
        expect(res.status).toBe(401);
    });

    it('compares in constant time (secretCompare.ts), not with ===', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/view-link/index.ts'), 'utf8');
        expect(source).toMatch(/secretsEqual/);
    });

    it('only takes POST', async () => {
        const res = await handleViewLink(post(null, { [PROXY_HEADER]: SECRET }, 'GET'), deps());
        expect(res.status).toBe(405);
    });
});

describe('token validation', () => {
    it.each([
        ['missing', {}],
        ['not a string', { token: 42 }],
        ['too short', { token: 'abc' }],
        ['too long', { token: `${TOKEN}A` }],
        ['outside base64url', { token: `${'A'.repeat(42)}+` }],
    ])('answers 410 gone, without a lookup, for a token that is %s', async (_label, body) => {
        const d = deps();
        const res = await handleViewLink(post(body), d);
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({ gone: true });
        expect(d.calls).toEqual([]);
    });

    it('answers 410 gone for a revoked, expired or unknown token (the lookup says null)', async () => {
        const d = deps();
        const res = await handleViewLink(post({ token: 'Z'.repeat(43) }), d);
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({ gone: true });
    });

    it('refuses an oversized body with 413', async () => {
        const res = await handleViewLink(post({ token: TOKEN, pad: 'x'.repeat(4096) }), deps());
        expect(res.status).toBe(413);
    });

    it('refuses a body that is not JSON with 400', async () => {
        const res = await handleViewLink(post('not json'), deps());
        expect(res.status).toBe(400);
    });

    it('takes since as a non-negative integer and defaults it to 0', async () => {
        const d = deps();
        await handleViewLink(post({ token: TOKEN }), d);
        await handleViewLink(post({ token: TOKEN, since: 12 }), d);
        await handleViewLink(post({ token: TOKEN, since: -5 }), d);
        await handleViewLink(post({ token: TOKEN, since: 'x' }), d);
        expect(d.calls.filter((c) => c.startsWith('poll:'))).toEqual(['poll:0', 'poll:12', 'poll:0', 'poll:0']);
    });
});

describe('rate limiting', () => {
    it('limits by a hash of the token, never by IP', async () => {
        const d = deps();
        await handleViewLink(
            post(
                { token: TOKEN },
                {
                    [PROXY_HEADER]: SECRET,
                    'x-forwarded-for': '203.0.113.9',
                    'cf-connecting-ip': '203.0.113.9',
                    'x-real-ip': '203.0.113.9',
                },
            ),
            d,
        );
        const key = await viewRateLimitKey(TOKEN);
        expect(key).toMatch(/^view:[0-9a-f]{64}$/);
        expect(key).not.toContain(TOKEN);
        expect(d.checkRateLimit).toHaveBeenCalledWith(key, VIEW_RATE_LIMIT.limit, VIEW_RATE_LIMIT.windowMs);
        expect(JSON.stringify(vi.mocked(d.checkRateLimit).mock.calls)).not.toContain('203.0.113.9');
    });

    it('is about 60 a minute', () => {
        expect(VIEW_RATE_LIMIT).toEqual({ limit: 60, windowMs: 60_000 });
    });

    it('answers 429 with Retry-After when the token is over its limit', async () => {
        const d = deps({ checkRateLimit: vi.fn(async () => ({ ok: false as const, retryAfterSec: 9 })) });
        const res = await handleViewLink(post({ token: TOKEN }), d);
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('9');
        expect(d.poll).not.toHaveBeenCalled();
    });

    it('never reads the client address (no clientKey in the function)', () => {
        const shared = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/viewLink.ts'), 'utf8');
        const index = readFileSync(resolve(process.cwd(), 'supabase/functions/view-link/index.ts'), 'utf8');
        for (const source of [shared, index]) {
            expect(source).not.toMatch(/clientKey|x-forwarded-for|cf-connecting-ip|x-real-ip/i);
        }
    });
});

describe('the poll answer', () => {
    it('returns the doc, the marks and the watermark, with no-store', async () => {
        const res = await handleViewLink(post({ token: TOKEN, since: 3 }), deps());
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(await res.json()).toEqual({
            doc: { pages: 3, pdf_rev: 2 },
            pdf: 'proxy',
            annotations: [
                {
                    id: 'a1',
                    page: 0,
                    kind: 'stroke',
                    color: '#000',
                    payload: { pts: [0, 0, 1], w: 0.01 },
                    seq: 7,
                    deleted: false,
                },
            ],
            max_seq: 7,
            more: false,
        });
    });

    it('never sends created_by, names or emails, whatever the lookup returned', async () => {
        const res = await handleViewLink(post({ token: TOKEN }), deps());
        const text = await res.text();
        expect(text).not.toMatch(/created_by|createdBy|email|display_name|owner_id|storage_path/);
    });

    it('says direct when the PDF is over the proxy limit, or its size is unknown', async () => {
        for (const bytes of [VIEW_PDF_PROXY_MAX_DEFAULT + 1, null]) {
            const d = deps({ poll: vi.fn(async () => ({ ...POLL, pdf_bytes: bytes })) });
            const body = (await (await handleViewLink(post({ token: TOKEN }), d)).json()) as { pdf: string };
            expect(body.pdf).toBe('direct');
        }
        const d = deps({ poll: vi.fn(async () => ({ ...POLL, pdf_bytes: VIEW_PDF_PROXY_MAX_DEFAULT })) });
        const body = (await (await handleViewLink(post({ token: TOKEN }), d)).json()) as { pdf: string };
        expect(body.pdf).toBe('proxy');
    });

    it('answers 503 when the lookup fails', async () => {
        const res = await handleViewLink(post({ token: TOKEN }), deps({ poll: vi.fn(async () => 'error' as const) }));
        expect(res.status).toBe(503);
    });
});

describe('the PDF', () => {
    it('streams the bytes through when the file is at most VIEW_PDF_PROXY_MAX', async () => {
        const d = deps();
        const res = await handleViewLink(post({ token: TOKEN, pdf: true }), d);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        expect(d.signedUrl).not.toHaveBeenCalled();
    });

    it('hands back a 60-second signed URL when the file is larger', async () => {
        const d = deps({
            pdfObject: vi.fn(async () => ({ storagePath: 'doc/original.pdf', bytes: VIEW_PDF_PROXY_MAX_DEFAULT + 1 })),
        });
        const res = await handleViewLink(post({ token: TOKEN, pdf: true }), d);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            pdf: 'direct',
            url: 'https://project.supabase.co/storage/v1/object/sign/scores/doc/original.pdf?token=sig',
        });
        expect(VIEW_SIGNED_URL_TTL_S).toBe(60);
        expect(d.signedUrl).toHaveBeenCalledWith('doc/original.pdf', 60);
        expect(d.download).not.toHaveBeenCalled();
    });

    it('honours VIEW_PDF_PROXY_MAX', async () => {
        const d = deps({ env: env({ VIEW_PDF_PROXY_MAX: '500000' }) });
        const res = await handleViewLink(post({ token: TOKEN, pdf: true }), d);
        expect(((await res.json()) as { pdf: string }).pdf).toBe('direct');
    });

    it('defaults the proxy limit to 4,000,000 bytes, under Vercel’s 4.5 MB body limit', () => {
        expect(VIEW_PDF_PROXY_MAX_DEFAULT).toBe(4_000_000);
    });

    it('answers 410 for a dead link', async () => {
        const res = await handleViewLink(post({ token: 'Z'.repeat(43), pdf: true }), deps());
        expect(res.status).toBe(410);
    });

    it('is rate limited by token too', async () => {
        const d = deps({ checkRateLimit: vi.fn(async () => ({ ok: false as const, retryAfterSec: 3 })) });
        const res = await handleViewLink(post({ token: TOKEN, pdf: true }), d);
        expect(res.status).toBe(429);
        expect(d.pdfObject).not.toHaveBeenCalled();
    });
});

describe('logging', () => {
    it('logs nothing about the request: no token, IP or headers', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => undefined),
        );
        const d = deps({ poll: vi.fn(async () => 'error' as const) });
        await handleViewLink(post({ token: TOKEN }, { [PROXY_HEADER]: SECRET, 'x-forwarded-for': '203.0.113.9' }), d);
        await handleViewLink(post({ token: TOKEN, pdf: true }), deps());
        await handleViewLink(post({ token: 'bad' }), deps());
        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('has no console call that could print the token in the function source', () => {
        const shared = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/viewLink.ts'), 'utf8');
        expect(shared).not.toMatch(/console\./);
        const index = readFileSync(resolve(process.cwd(), 'supabase/functions/view-link/index.ts'), 'utf8');
        // index.ts may log a fixed message on a failed lookup, never a variable.
        for (const call of index.match(/console\.\w+\([^)]*\)/g) ?? []) {
            expect(call).toMatch(/^console\.\w+\('[^'$`]*'\)$/);
        }
    });
});
