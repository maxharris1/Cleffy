import { jsonResponse } from '../_shared/cors.ts';
import { tryDownloadPdfWith } from '../_shared/imslpDownload.ts';
import { runImslpImport, type ImslpImportDeps } from '../_shared/imslpImportFlow.ts';
import {
    imslpFileId,
    withImslpPdfCache,
    type PdfCacheDeps,
    type PdfCacheSession,
    type SharedPdfEntry,
} from '../_shared/imslpPdfCache.ts';
import { withServerTiming } from '../_shared/serverTiming.ts';
import { downloadFields, timedCacheDeps, timedImportDeps, type ImslpDownloadSpan } from './timing.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const FILENAME = 'IMSLP12345-PMLP1-Etude.pdf';
const DOCUMENT_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-token-value';
const EMAIL = 'teacher@example.com';
const PDF_MARKER = 'PDF-BODY-MARKER';
const PDF = new TextEncoder().encode(`%PDF-1.7\n${PDF_MARKER}\n${'x'.repeat(2048)}\n%%EOF\n`);
const CDN_URL = 'https://cdn.imslp.org/files/etude.pdf';
const WAIT_PAGE = `<html><body><span id="sm_dl_wait" data-id="${CDN_URL}"></span></body></html>`;

const memoryCache = (initial: SharedPdfEntry | null): PdfCacheDeps => {
    const entries = new Map<string, SharedPdfEntry>();
    if (initial) entries.set(initial.imslp_file_id, initial);
    return {
        read: async (fileId) => entries.get(fileId) ?? null,
        claim: async () => true,
        release: async () => undefined,
        upload: async () => undefined,
        publish: async (entry) => {
            entries.set(entry.imslp_file_id, entry);
        },
    };
};

const cachedEntry: SharedPdfEntry = {
    imslp_file_id: imslpFileId(FILENAME),
    filename: FILENAME,
    storage_path: `00000000-0000-0000-0000-000000000000/${'a'.repeat(64)}.pdf`,
    sha256: 'a'.repeat(64),
    size: 734_003,
    fetched_at: new Date().toISOString(),
    work_title: 'Etude (Composer, A.)',
    license_label: 'Public Domain',
    provenance: {
        source_url: 'https://imslp.org/wiki/Etude',
        source_filename: FILENAME,
        source_license: 'Public Domain',
        source_attribution: {
            source: 'imslp',
            work: 'Etude (Composer, A.)',
            composer: 'Composer, A.',
            editor: null,
            arranger: null,
            publisher: null,
            year: null,
        },
    },
};

const stubFetch: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    return url === CDN_URL
        ? new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
        : new Response(WAIT_PAGE, { headers: { 'content-type': 'text/html' } });
};

const stubImportDeps = (
    cache: PdfCacheSession,
    onPhase: <T>(phase: ImslpDownloadSpan, run: () => Promise<T>) => Promise<T>,
    tier: { set: (tier: string) => void },
): ImslpImportDeps => ({
    cachedClearance: async () =>
        cache.entry
            ? {
                  downloadable: true,
                  restriction: null,
                  licenseLabel: 'Public Domain',
                  workTitle: cache.entry.work_title,
              }
            : null,
    precheckCreate: async () => {
        tier.set('pro');
        return null;
    },
    pace: async () => ({ ok: true }),
    liveLicense: async () => ({
        kind: 'found',
        downloadable: true,
        restriction: null,
        licenseLabel: 'Public Domain',
    }),
    backOff: async () => ({ status: 429, body: {} }),
    enforceQuota: async () => ({ ok: true, consumed: true }),
    refundQuota: async () => undefined,
    downloadPdf: async () => {
        let entry = cache.entry;
        if (!entry) {
            const result = await tryDownloadPdfWith(FILENAME, {
                mwFetch: () => Promise.reject(new Error('fallback not expected')),
                fetchImpl: stubFetch,
                onPhase,
            });
            if (!result.ok) return result;
            await onPhase('imslp_credits', async () => null);
            entry = await cache.store(result.bytes, {
                work_title: cachedEntry.work_title,
                license_label: cachedEntry.license_label,
                provenance: cachedEntry.provenance,
            });
        }
        return {
            ok: true,
            filename: entry.filename,
            shared: { storagePath: entry.storage_path, byteLength: entry.size },
        };
    },
    createDocument: async () => null,
    deleteDocument: async () => undefined,
    uploadPdf: async () => 'unexpected per-user upload',
    removePdf: async () => undefined,
    recordProvenance: async () => null,
});

const handlerFor = (initial: SharedPdfEntry | null, refuseAtAddressLimit = false) =>
    withServerTiming<ImslpDownloadSpan>('imslp-download', async (_req, timing, telemetry) => {
        const fields = downloadFields(telemetry);
        const addressOk = await timing.time('rl_ip', async () => !refuseAtAddressLimit);
        if (!addressOk) {
            return jsonResponse({ error: 'Too many requests', retryAfterSec: 30 }, 429);
        }
        await timing.time('auth', async () => undefined);
        await timing.time('elig_rl_del', async () => undefined);
        const flow = await withImslpPdfCache(
            FILENAME,
            timedCacheDeps(timing, memoryCache(initial)),
            async (cache) => {
                fields.cacheHit = cache.entry !== null;
                return runImslpImport(
                    {
                        filename: FILENAME,
                        workTitle: cachedEntry.work_title,
                        documentId: DOCUMENT_ID,
                        storagePath: `${DOCUMENT_ID}/original.pdf`,
                        openUrl: 'https://imslp.org/wiki/Special:ImagefromIndex',
                        createTitle: 'Etude',
                    },
                    timedImportDeps(
                        timing,
                        fields,
                        stubImportDeps(cache, (phase, run) => timing.time(phase, run), {
                            set: (tier) => {
                                fields.tier = tier;
                            },
                        }),
                    ),
                );
            },
            () => ({ status: 429, body: { code: 'queued' } }),
        );
        return jsonResponse(flow.body, flow.status);
    });

const request = () =>
    new Request('https://x.test/functions/v1/imslp-download', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: FILENAME, email: EMAIL, documentId: DOCUMENT_ID, acceptedDisclaimer: true }),
    });

const run = async (handler: (req: Request) => Promise<Response>) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    let res: Response;
    try {
        res = await handler(request());
    } finally {
        console.log = original;
    }
    const header = res.headers.get('Server-Timing') ?? '';
    const spans = header.split(', ').map((entry) => entry.split(';dur=')[0]);
    return { res, header, spans, lines };
};

const assertSafeSingleLine = (lines: string[]): Record<string, unknown> => {
    assert(lines.length === 1, `one log line, got ${lines.length}: ${lines.join('\n')}`);
    const line = lines[0]!;
    for (const secret of [TOKEN, 'Bearer', EMAIL, PDF_MARKER, '%PDF', DOCUMENT_ID, FILENAME]) {
        assert(!line.includes(secret), `log line leaks ${secret}: ${line}`);
    }
    return JSON.parse(line);
};

const same = (actual: unknown, expected: unknown, label: string) =>
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual)}`);

Deno.test('a cache miss times every flow span, IMSLP fetches included, and logs one safe line', async () => {
    const { res, header, spans, lines } = await run(handlerFor(null));
    assert(res.status === 200, `status ${res.status}: ${await res.text()}`);
    same(
        spans,
        [
            'rl_ip',
            'auth',
            'elig_rl_del',
            'cache_read_claim',
            'lic_cache',
            'precheck_pace_quota',
            'lic_live',
            'imslp_wait',
            'imslp_cdn',
            'imslp_credits',
            'hash_upload_pub',
            'db_doc_write',
            'cache_release',
            'total',
        ],
        header,
    );
    assert(/^(\w+;dur=\d+\.\d)(, \w+;dur=\d+\.\d)*$/.test(header), header);

    const log = assertSafeSingleLine(lines);
    same(
        {
            fn: log.fn,
            status: log.status,
            cacheHit: log.cacheHit,
            licenseHit: log.licenseHit,
            tier: log.tier,
            byteLength: log.byteLength,
        },
        {
            fn: 'imslp-download',
            status: 200,
            cacheHit: false,
            licenseHit: false,
            tier: 'pro',
            byteLength: PDF.byteLength,
        },
        'miss fields',
    );
    assert(typeof log.coldStart === 'boolean', 'coldStart is logged');
    same(Object.keys(log.spans as object), spans.slice(0, -1), 'log spans match the header');
});

Deno.test('a cache hit with fresh clearance skips IMSLP and the upload and logs one safe line', async () => {
    const { res, header, spans, lines } = await run(handlerFor(cachedEntry));
    assert(res.status === 200, `status ${res.status}: ${await res.text()}`);
    same(
        spans,
        [
            'rl_ip',
            'auth',
            'elig_rl_del',
            'cache_read_claim',
            'lic_cache',
            'precheck_pace_quota',
            'db_doc_write',
            'total',
        ],
        header,
    );

    const log = assertSafeSingleLine(lines);
    same([log.cacheHit, log.licenseHit, log.tier, log.byteLength], [true, true, 'pro', cachedEntry.size], 'hit fields');
    assert(typeof log.coldStart === 'boolean', 'coldStart is logged');
});

Deno.test('an early refusal still carries the header and one safe line with null flow fields', async () => {
    const { res, spans, lines } = await run(handlerFor(cachedEntry, true));
    assert(res.status === 429, `status ${res.status}`);
    same(spans, ['rl_ip', 'total'], 'refusal spans');

    const log = assertSafeSingleLine(lines);
    same(
        [log.status, log.cacheHit, log.licenseHit, log.tier, log.byteLength],
        [429, null, null, null, null],
        'refusal fields',
    );
    assert(typeof log.coldStart === 'boolean', 'coldStart is logged');
});
