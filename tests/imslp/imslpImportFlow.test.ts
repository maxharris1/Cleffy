import { describe, expect, it } from 'vitest';

import {
    runImslpImport,
    type CachedClearance,
    type FetchedPdf,
    type FlowResponse,
    type ImslpImportDeps,
    type ImslpImportRequest,
    type LiveLicense,
    type PacingGate,
    type QuotaGate,
} from '../../supabase/functions/_shared/imslpImportFlow';

/**
 * imslp-download's order of operations, pinned: which steps run, in which
 * order, and what is undone when one fails. Every dependency records itself
 * in `calls`, so a reordering (pacing after the live license parse, quota
 * after the fetch, the row before the PDF) fails here.
 */

const WORK = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
const PDF = new TextEncoder().encode('%PDF-1.4 tiny');
const QUEUED: FlowResponse = { status: 429, body: { ok: false, code: 'download_queued', retryAfterSec: 1 } };

interface Script {
    cached?: CachedClearance | null;
    precheck?: FlowResponse | null;
    pace?: PacingGate;
    live?: LiveLicense;
    quota?: QuotaGate;
    download?: FetchedPdf | Error;
    create?: FlowResponse | null;
    upload?: string | null | Error;
    provenance?: string | null;
}

const harness = (script: Script = {}) => {
    const calls: string[] = [];
    const args: Record<string, unknown[]> = {};
    const record = (name: string, ...values: unknown[]) => {
        calls.push(name);
        args[name] = values;
    };
    const deps: ImslpImportDeps = {
        cachedClearance: async () => {
            record('cachedClearance');
            return script.cached ?? null;
        },
        precheckCreate: async () => {
            record('precheckCreate');
            return script.precheck ?? null;
        },
        pace: async () => {
            record('pace');
            return script.pace ?? { ok: true };
        },
        liveLicense: async (title) => {
            record('liveLicense', title);
            return (
                script.live ?? {
                    kind: 'found',
                    downloadable: true,
                    restriction: null,
                    licenseLabel: 'Public Domain',
                }
            );
        },
        backOff: async (retryAfterSec) => {
            record('backOff', retryAfterSec);
            return QUEUED;
        },
        enforceQuota: async () => {
            record('enforceQuota');
            return script.quota ?? { ok: true, consumed: true };
        },
        refundQuota: async () => {
            record('refundQuota');
        },
        downloadPdf: async () => {
            record('downloadPdf');
            if (script.download instanceof Error) {
                throw script.download;
            }
            return script.download ?? { ok: true, bytes: PDF, filename: 'a.pdf' };
        },
        createDocument: async (title) => {
            record('createDocument', title);
            return script.create ?? null;
        },
        deleteDocument: async () => {
            record('deleteDocument');
        },
        uploadPdf: async (bytes) => {
            record('uploadPdf', bytes);
            if (script.upload instanceof Error) {
                throw script.upload;
            }
            return script.upload ?? null;
        },
        removePdf: async () => {
            record('removePdf');
        },
        recordProvenance: async (title, licenseLabel) => {
            record('recordProvenance', title, licenseLabel);
            return script.provenance ?? null;
        },
    };
    return { calls, args, deps };
};

const request = (overrides: Partial<ImslpImportRequest> = {}): ImslpImportRequest => ({
    filename: 'a.pdf',
    workTitle: WORK,
    documentId: '00000000-0000-4000-8000-000000000001',
    storagePath: '00000000-0000-4000-8000-000000000001/original.pdf',
    openUrl: 'https://imslp.org/wiki/Special:ImagefromIndex/a.pdf',
    createTitle: 'Piano Sonata No.14',
    ...overrides,
});

const legacy = (overrides: Partial<ImslpImportRequest> = {}) => request({ createTitle: null, ...overrides });

describe('runImslpImport — license and pacing come before anything is spent', () => {
    it('refuses a cached restricted file at once: no slot, no IMSLP request, no credit', async () => {
        const { calls, deps } = harness({
            cached: { downloadable: false, restriction: 'Non-PD US', licenseLabel: null, workTitle: WORK },
        });
        const res = await runImslpImport(request(), deps);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'non_pd', message: expect.stringContaining('Non-PD US') });
        expect(calls).toEqual(['cachedClearance']);
    });

    it('refuses a cache miss with no work page to check, without taking a slot', async () => {
        const { calls, deps } = harness();
        const res = await runImslpImport(request({ workTitle: '' }), deps);
        expect(res.body).toMatchObject({ code: 'license_unknown' });
        expect(calls).toEqual(['cachedClearance']);
    });

    it('refuses a new score that could never be created before asking IMSLP anything', async () => {
        const cap: FlowResponse = { status: 402, body: { code: 'limit_reached', metric: 'cloud_scores' } };
        const { calls, deps } = harness({ precheck: cap });
        expect(await runImslpImport(request(), deps)).toBe(cap);
        expect(calls).toEqual(['cachedClearance', 'precheckCreate']);
    });

    it('queues an uncached file BEFORE the live license parse, so a throttled IMSLP sees nothing', async () => {
        const { calls, deps } = harness({ pace: { ok: false, status: 429, body: QUEUED.body } });
        const res = await runImslpImport(request(), deps);
        expect(res).toEqual({ status: 429, body: QUEUED.body });
        expect(calls).toEqual(['cachedClearance', 'precheckCreate', 'pace']);
    });

    it('backs the deployment off when the license parse itself is throttled', async () => {
        const { calls, args, deps } = harness({ live: { kind: 'rate_limited', retryAfterSec: 120 } });
        const res = await runImslpImport(request(), deps);
        expect(res).toBe(QUEUED);
        expect(args['backOff']).toEqual([120]);
        expect(calls).toEqual(['cachedClearance', 'precheckCreate', 'pace', 'liveLicense', 'backOff']);
    });

    it('says the license could not be checked — not that it is unlicensed — when IMSLP is unreachable', async () => {
        const { calls, deps } = harness({ live: { kind: 'unavailable' } });
        const res = await runImslpImport(request(), deps);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'license_unknown', message: expect.stringMatching(/couldn't reach/i) });
        expect(calls).not.toContain('enforceQuota');
    });

    it('refuses a file the work page does not list, and one it lists as restricted', async () => {
        const missing = harness({ live: { kind: 'not_listed' } });
        expect((await runImslpImport(request(), missing.deps)).body).toMatchObject({
            code: 'license_unknown',
            message: expect.stringMatching(/didn't confirm/i),
        });
        const restricted = harness({
            live: { kind: 'found', downloadable: false, restriction: 'Non-PD EU', licenseLabel: 'Public Domain' },
        });
        expect((await runImslpImport(request(), restricted.deps)).body).toMatchObject({ code: 'non_pd' });
        expect(restricted.calls).not.toContain('enforceQuota');
    });

    it('takes no live license request when the cache already cleared the file', async () => {
        const { calls, args, deps } = harness({
            cached: { downloadable: true, restriction: null, licenseLabel: 'CC BY 4.0', workTitle: 'Cached (Work)' },
        });
        const res = await runImslpImport(request(), deps);
        expect(res.status).toBe(200);
        expect(calls).not.toContain('liveLicense');
        // Provenance names the page the clearance was verified on.
        expect(args['recordProvenance']).toEqual(['Cached (Work)', 'CC BY 4.0']);
    });
});

describe('runImslpImport — creating the score only once the PDF is in hand', () => {
    it('runs the whole import in order and reports the new score', async () => {
        const { calls, args, deps } = harness();
        const res = await runImslpImport(request(), deps);
        expect(res).toEqual({
            status: 200,
            body: {
                ok: true,
                documentId: '00000000-0000-4000-8000-000000000001',
                storagePath: '00000000-0000-4000-8000-000000000001/original.pdf',
                filename: 'a.pdf',
                byteLength: PDF.byteLength,
                created: true,
            },
        });
        expect(calls).toEqual([
            'cachedClearance',
            'precheckCreate',
            'pace',
            'liveLicense',
            'enforceQuota',
            'downloadPdf',
            'createDocument',
            'uploadPdf',
            'recordProvenance',
        ]);
        expect(args['createDocument']).toEqual(['Piano Sonata No.14']);
        expect(args['recordProvenance']).toEqual([WORK, 'Public Domain']);
    });

    it('imports into the row an older client created, without creating or prechecking one', async () => {
        const { calls, deps } = harness();
        const res = await runImslpImport(legacy(), deps);
        expect(res.body).toMatchObject({ ok: true, created: false });
        expect(calls).not.toContain('precheckCreate');
        expect(calls).not.toContain('createDocument');
    });

    it('creates nothing and charges nothing when the quota refuses', async () => {
        const refusal = { ok: false as const, status: 402, body: { code: 'limit_reached', metric: 'smart_imports' } };
        const { calls, deps } = harness({ quota: refusal });
        expect(await runImslpImport(request(), deps)).toEqual({ status: 402, body: refusal.body });
        expect(calls.at(-1)).toBe('enforceQuota');
    });

    it('refunds and backs off when IMSLP throttles the PDF fetch — and never creates the row', async () => {
        const { calls, args, deps } = harness({
            download: {
                ok: false,
                code: 'rate_limited',
                message: 'busy',
                openUrl: 'u',
                filename: 'a.pdf',
                retryAfterSec: 60,
            },
        });
        expect(await runImslpImport(request(), deps)).toBe(QUEUED);
        expect(args['backOff']).toEqual([60]);
        expect(calls).toContain('refundQuota');
        expect(calls).not.toContain('createDocument');
    });

    it('refunds and hands a refused fetch to the open-on-IMSLP fallback, with no row left behind', async () => {
        const { calls, deps } = harness({
            download: { ok: false, code: 'bot_check', message: 'verify', openUrl: 'u', filename: 'a.pdf' },
        });
        const res = await runImslpImport(request(), deps);
        expect(res).toEqual({
            status: 409,
            body: { ok: false, code: 'bot_check', message: 'verify', openUrl: 'u', filename: 'a.pdf' },
        });
        expect(calls).toContain('refundQuota');
        expect(calls).not.toContain('createDocument');
    });

    it('never refunds a credit the gate did not take (unlimited plans)', async () => {
        const { calls, deps } = harness({
            quota: { ok: true, consumed: false },
            download: { ok: false, code: 'upstream', message: 'x', openUrl: 'u', filename: 'a.pdf' },
        });
        await runImslpImport(request(), deps);
        expect(calls).not.toContain('refundQuota');
    });

    it('passes the score-cap refusal through and refunds when the row cannot be created', async () => {
        const cap: FlowResponse = { status: 402, body: { code: 'limit_reached', metric: 'cloud_scores' } };
        const { calls, deps } = harness({ create: cap });
        expect(await runImslpImport(request(), deps)).toBe(cap);
        expect(calls).toContain('refundQuota');
        expect(calls).not.toContain('uploadPdf');
        expect(calls).not.toContain('deleteDocument');
    });

    it('removes the new row (PDF first) and refunds when the upload fails', async () => {
        const { calls, deps } = harness({ upload: 'bucket full' });
        const res = await runImslpImport(request(), deps);
        expect(res).toEqual({ status: 502, body: { error: 'Storage upload failed: bucket full' } });
        expect(calls.slice(calls.indexOf('uploadPdf') + 1)).toEqual(['removePdf', 'deleteDocument', 'refundQuota']);
    });

    it('removes the PDF and the new row and refunds when provenance cannot be recorded', async () => {
        const { calls, deps } = harness({ provenance: 'permission denied' });
        const res = await runImslpImport(request(), deps);
        expect(res.status).toBe(502);
        expect(calls.slice(calls.indexOf('recordProvenance') + 1)).toEqual([
            'removePdf',
            'deleteDocument',
            'refundQuota',
        ]);
    });

    it("removes only the PDF for an older client's row (the client rolls its row back)", async () => {
        const { calls, deps } = harness({ provenance: 'permission denied' });
        await runImslpImport(legacy(), deps);
        expect(calls.slice(calls.indexOf('recordProvenance') + 1)).toEqual(['removePdf', 'refundQuota']);
    });

    it('cleans up and refunds when a step throws', async () => {
        const thrown = harness({ upload: new Error('socket closed') });
        const res = await runImslpImport(request(), thrown.deps);
        expect(res).toEqual({ status: 502, body: { error: 'socket closed' } });
        expect(thrown.calls.slice(thrown.calls.indexOf('uploadPdf') + 1)).toEqual([
            'removePdf',
            'deleteDocument',
            'refundQuota',
        ]);

        const early = harness({ download: new Error('boom') });
        await runImslpImport(request(), early.deps);
        expect(early.calls.slice(early.calls.indexOf('downloadPdf') + 1)).toEqual(['refundQuota']);
    });
});
