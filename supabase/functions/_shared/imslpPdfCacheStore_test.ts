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

type DownloadHandler = (request: Request) => Promise<Response>;
let downloadHandler: DownloadHandler | undefined;
const getDownloadHandler = async (): Promise<DownloadHandler> => {
    if (!downloadHandler) {
        const originalServe = Deno.serve;
        try {
            Object.defineProperty(Deno, 'serve', {
                configurable: true,
                value: (handler: DownloadHandler) => {
                    downloadHandler = handler;
                },
            });
            await import('../imslp-download/index.ts');
        } finally {
            Object.defineProperty(Deno, 'serve', { configurable: true, value: originalServe });
        }
    }
    if (!downloadHandler) throw new Error('Deno handler was not registered');
    return downloadHandler;
};

Deno.test('real download handler refuses anonymous, student and ineligible callers before cache writes', async () => {
    const originalFetch = globalThis.fetch;
    const originalEnvGet = Deno.env.get;
    let user: { is_anonymous: boolean; app_metadata: { user_type?: string } } = {
        is_anonymous: true,
        app_metadata: {},
    };
    const requests: string[] = [];
    try {
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
        const handler = await getDownloadHandler();
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
        Deno.env.get = originalEnvGet;
    }
});

Deno.test(
    'real handler keeps not-listed refusals import-only and checks the cached filename on stale alias hits',
    async () => {
        const originalFetch = globalThis.fetch;
        const originalEnvGet = Deno.env.get;
        const filename = 'IMSLP51037-real.pdf';
        const stale = { ...row, filename, fetched_at: '2020-01-01T00:00:00Z' };
        const entry = {
            imslp_file_id: '51037',
            filename,
            work_title: 'Sonata',
            storage_path: `${IMSLP_CACHE_PREFIX}${'a'.repeat(64)}.pdf`,
            blocked_at: null,
        };
        const listedHtml = `<span class="we_file_dlarrwrap"></span><span class="we_file_info2">
        <a title="File:${filename}">#51037</a></span>
        <th>Copyright</th><td><a href="/PD">Public Domain</a><a href="?indexes=51037">tag</a></td>`;
        try {
            Deno.env.get = (key: string) =>
                ({
                    SUPABASE_URL: 'https://supabase.invalid',
                    SUPABASE_ANON_KEY: 'test-anon-key',
                    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
                })[key];
            const handler = await getDownloadHandler();
            for (const scenario of ['stale-hit-unlisted', 'miss-wrong-work', 'stale-hit-listed'] as const) {
                const hit = scenario !== 'miss-wrong-work';
                const listed = scenario === 'stale-hit-listed';
                let licenseRow = { ...stale };
                const writes: Record<string, unknown>[] = [];
                const licenseQueries: string[] = [];
                const workQueries: string[] = [];
                let quotaChecks = 0;
                let paced = false;
                globalThis.fetch = async (input, init) => {
                    const url = new URL(String(input instanceof Request ? input.url : input));
                    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
                    const body = init?.body ? JSON.parse(String(init.body)) : null;
                    const reply = (value: unknown) => Response.json(value);
                    if (url.pathname.endsWith('/auth/v1/user'))
                        return reply({
                            id: 'ab281200-0000-4000-8000-000000000001',
                            is_anonymous: false,
                            app_metadata: {},
                        });
                    if (url.pathname.endsWith('/rpc/check_edge_rate_limit')) {
                        if (String(body.p_key).includes('global')) paced = true;
                        return reply({ ok: true });
                    }
                    if (url.pathname.endsWith('/rpc/can_import_imslp')) return reply(true);
                    if (url.pathname.endsWith('/rpc/account_deletion_pending')) return reply(false);
                    if (url.pathname.endsWith('/imslp_pdf_cache')) return reply(hit ? entry : null);
                    if (url.pathname.endsWith('/rpc/is_shared_imslp_pdf')) return reply(true);
                    if (url.pathname.endsWith('/rpc/claim_imslp_pdf')) return reply(true);
                    if (url.pathname.endsWith('/rpc/release_imslp_pdf')) return reply(null);
                    if (url.pathname.endsWith('/imslp_file_licenses')) {
                        if (method === 'POST') {
                            writes.push(body);
                            licenseRow = { ...licenseRow, ...body };
                            return new Response(null, { status: 201 });
                        }
                        licenseQueries.push(url.searchParams.get('filename') ?? '');
                        return reply(licenseRow);
                    }
                    if (url.pathname.endsWith('/documents')) return reply(null);
                    if (url.pathname.endsWith('/rpc/get_entitlements'))
                        return reply({ tier: 'free', limits: { cloud_scores: -1, smart_imports: 0 } });
                    if (url.pathname.endsWith('/rpc/consume_quota')) {
                        quotaChecks++;
                        return reply({ ok: false, count: 0 });
                    }
                    if (url.hostname === 'imslp.org' && url.searchParams.get('action') === 'parse') {
                        assert(paced, 'live licensing must be paced');
                        workQueries.push(url.searchParams.get('page') ?? '');
                        return reply({ parse: { text: { '*': listed ? listedHtml : '<html>unrelated page</html>' } } });
                    }
                    throw new Error(`Unexpected downstream request: ${method} ${url}`);
                };
                const response = await handler(
                    new Request('https://edge.invalid/imslp-download', {
                        method: 'POST',
                        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            filename: hit ? 'IMSLP51037-attacker.pdf' : filename,
                            workTitle: 'Wrong work',
                            create: true,
                            acceptedDisclaimer: true,
                            documentId: 'ab281200-0000-4000-8000-000000000010',
                        }),
                    }),
                );
                const result = await response.json();
                assert(
                    response.status === (listed ? 402 : 409),
                    `${scenario}: ${response.status} ${JSON.stringify(result)}`,
                );
                assert(licenseQueries.join() === `eq.${filename}`, 'license cache uses canonical cached filename');
                assert(workQueries.join() === (hit ? 'Sonata' : 'Wrong work'), 'hit uses trusted work title');
                assert(quotaChecks === (listed ? 1 : 0), 'not listed refuses before spending');
                if (!listed) {
                    assert(result.code === 'license_unknown');
                    assert(writes.length === 0, 'not_listed must not write a license row');
                    assert(
                        JSON.stringify(licenseRow) === JSON.stringify(stale),
                        'existing clearance remains unchanged',
                    );
                } else {
                    assert(writes.length === 1 && writes[0]?.filename === filename);
                    assert(licenseRow.downloadable === true, 'alias must not downgrade canonical clearance');
                }
            }
        } finally {
            globalThis.fetch = originalFetch;
            Deno.env.get = originalEnvGet;
        }
    },
);
