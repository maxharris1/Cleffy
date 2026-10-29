import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { imslpCachedClearance } from './imslpCachedClearance.ts';
import { imslpPdfCacheStore } from './imslpPdfCacheStore.ts';
import { pdfSha256, IMSLP_CACHE_PREFIX, SharedPdfBlockedError } from './imslpPdfCache.ts';
import { runImslpImport, type ImslpImportDeps } from './imslpImportFlow.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};
const row = {
    downloadable: true,
    fetched_at: '2026-10-29T00:00:00Z',
    work_title: 'Sonata',
    license_label: 'Public Domain',
    restriction: null,
};
const now = Date.parse(row.fetched_at);

Deno.test('license clearance requires a present, fresh, valid license row on byte-cache hits', () => {
    assert(imslpCachedClearance(null, now) === null);
    assert(imslpCachedClearance({ ...row, fetched_at: 'bad date' }, now) === null);
    assert(imslpCachedClearance({ ...row, fetched_at: '2026-09-01T00:00:00Z' }, now) === null);
    assert(imslpCachedClearance({ ...row, downloadable: null }, now) === null);
    assert(imslpCachedClearance(row, now)?.downloadable === true);
    assert(imslpCachedClearance({ ...row, downloadable: false }, now)?.downloadable === false);
});

Deno.test('stale clearance on a byte-cache hit paces and checks live licensing before spending', async () => {
    for (const kind of ['not_listed', 'restricted', 'unavailable'] as const) {
        const calls: string[] = [];
        const never = async (): Promise<never> => {
            throw new Error('must refuse before quota or download');
        };
        const deps: ImslpImportDeps = {
            cachedClearance: async () => imslpCachedClearance({ ...row, fetched_at: '2026-09-01T00:00:00Z' }, now),
            precheckCreate: async () => null,
            pace: async () => {
                calls.push('pace');
                return { ok: true };
            },
            liveLicense: async () => {
                calls.push('liveLicense');
                return kind === 'restricted'
                    ? { kind: 'found', downloadable: false, restriction: 'Non-PD', licenseLabel: 'Restricted' }
                    : { kind };
            },
            backOff: never,
            enforceQuota: never,
            refundQuota: never,
            downloadPdf: never,
            createDocument: never,
            deleteDocument: never,
            uploadPdf: never,
            removePdf: never,
            recordProvenance: never,
        };
        const result = await runImslpImport(
            {
                filename: 'score.pdf',
                workTitle: 'Sonata',
                documentId: 'test',
                storagePath: 'test/original.pdf',
                openUrl: 'https://imslp.org',
                createTitle: 'Sonata',
            },
            deps,
        );
        assert(result.status === 409);
        assert(calls.join(',') === 'pace,liveLicense');
    }
});

const bytes = new TextEncoder().encode('%PDF-1.4\nscore\n%%EOF\n');
Deno.test('duplicate upload verifies committed bytes after a transient read failure', async () => {
    let reads = 0;
    const admin = {
        storage: {
            from: () => ({
                upload: async () => ({ error: { message: 'Already exists' } }),
                download: async () =>
                    ++reads === 1
                        ? { data: null, error: { message: 'Not found yet' } }
                        : { data: new Blob([bytes]), error: null },
            }),
        },
    } as unknown as SupabaseClient;
    await imslpPdfCacheStore(admin).upload(`${IMSLP_CACHE_PREFIX}${await pdfSha256(bytes)}.pdf`, bytes);
    assert(reads === 2);
});

Deno.test('duplicate upload refuses different bytes at the expected hash path', async () => {
    const admin = {
        storage: {
            from: () => ({
                upload: async () => ({ error: { message: 'Already exists' } }),
                download: async () => ({ data: new Blob([new Uint8Array(bytes.length)]), error: null }),
            }),
        },
    } as unknown as SupabaseClient;
    let refused = false;
    try {
        await imslpPdfCacheStore(admin).upload(`${IMSLP_CACHE_PREFIX}${await pdfSha256(bytes)}.pdf`, bytes);
    } catch {
        refused = true;
    }
    assert(refused);
});

Deno.test('cache read refuses a hash blocked through any edition id', async () => {
    const entry = { imslp_file_id: '1', storage_path: 'hash.pdf', blocked_at: null };
    const admin = {
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: entry, error: null }) }) }) }),
        rpc: async () => ({ data: false, error: null }),
    } as unknown as SupabaseClient;
    let blocked = false;
    try {
        await imslpPdfCacheStore(admin).read('1');
    } catch (error) {
        blocked = error instanceof SharedPdfBlockedError;
    }
    assert(blocked);
});

Deno.test('cache read accepts an unblocked service-verified entry', async () => {
    const entry = { imslp_file_id: '1', storage_path: 'hash.pdf', blocked_at: null };
    const admin = {
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: entry, error: null }) }) }) }),
        rpc: async () => ({ data: true, error: null }),
    } as unknown as SupabaseClient;
    assert((await imslpPdfCacheStore(admin).read('1'))?.imslp_file_id === '1');
});

Deno.test('real download handler refuses anonymous, student and ineligible callers before cache writes', async () => {
    const originalFetch = globalThis.fetch;
    const originalServe = Deno.serve;
    const originalEnvGet = Deno.env.get;
    let handler: ((request: Request) => Promise<Response>) | undefined;
    let user: { is_anonymous: boolean; app_metadata: { user_type?: string } } = {
        is_anonymous: true,
        app_metadata: {},
    };
    const requests: string[] = [];
    try {
        Object.defineProperty(Deno, 'serve', {
            configurable: true,
            value: (fn: typeof handler) => {
                handler = fn;
            },
        });
        Deno.env.get = (key: string) =>
            (
                ({
                    SUPABASE_URL: 'https://supabase.invalid',
                    SUPABASE_ANON_KEY: 'test-anon-key',
                    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
                }) as Record<string, string>
            )[key];
        globalThis.fetch = (input) => {
            const url = String(input instanceof Request ? input.url : input);
            requests.push(url);
            if (url.endsWith('/rpc/check_edge_rate_limit')) {
                return Promise.resolve(Response.json({ ok: true }));
            }
            if (url.endsWith('/auth/v1/user')) {
                return Promise.resolve(Response.json({ id: 'ab281200-0000-4000-8000-000000000001', ...user }));
            }
            if (url.endsWith('/rpc/can_import_imslp')) {
                return Promise.resolve(Response.json(false));
            }
            throw new Error(`Unexpected downstream request: ${url}`);
        };
        await import('../imslp-download/index.ts');
        assert(handler, 'Deno handler was registered');
        for (const account of [
            { is_anonymous: true, app_metadata: {} },
            { is_anonymous: false, app_metadata: { user_type: 'student' } },
            { is_anonymous: false, app_metadata: {} },
        ]) {
            user = account;
            requests.length = 0;
            const response = await handler!(
                new Request('https://edge.invalid', {
                    method: 'POST',
                    headers: { Authorization: 'Bearer test-token' },
                    body: JSON.stringify({ filename: 'IMSLP51037-score.pdf', create: true, acceptedDisclaimer: true }),
                }),
            );
            assert(response.status === 403);
            assert(
                requests.some((url) => url.endsWith('/auth/v1/user')),
                'identity validated by Auth',
            );
            assert(
                !requests.some((url) => /imslp_pdf|storage|quota|imslp\.org/.test(url)),
                'no cache or upstream write',
            );
            assert(
                requests.some((url) => url.endsWith('/rpc/can_import_imslp')) ===
                    (!account.is_anonymous && account.app_metadata.user_type !== 'student'),
            );
        }
    } finally {
        globalThis.fetch = originalFetch;
        Object.defineProperty(Deno, 'serve', { configurable: true, value: originalServe });
        Deno.env.get = originalEnvGet;
    }
});
