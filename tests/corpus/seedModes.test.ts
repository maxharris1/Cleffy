import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import pdfLib from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MUTOPIA_TREE_URL, OPENSCORE_REPOS } from '../../scripts/playalong-corpus.mjs';

/**
 * The two runnable modes against a fake Supabase (PostgREST + Storage) and a
 * fake Mutopia, both served by one in-process HTTP server. `--fetch-only`
 * must fill `pd-pdfs` / `pd_pdf_store` / the ledger and nothing else;
 * `--enqueue-fetched` must turn those rows into documents + jobs, idempotently;
 * the default pass must do both at once.
 */
const MOONLIGHT = 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)';
const OWNER = '15d4ac9c-bedf-4d0f-9c9a-abae346cc82d';

type Row = Record<string, unknown>;

interface FakeBackend {
    server: Server;
    url: string;
    tables: Record<string, Row[]>;
    storage: Map<string, Buffer>;
    requests: string[];
}

const KEYS: Record<string, string[]> = {
    playalong_corpus_seed: ['work_title', 'origin', 'filename'],
    pd_pdf_store: ['pdf_sha256'],
    documents: ['id'],
    score_analyses: ['document_id'],
    omr_jobs: ['id'],
    subscriptions: ['stripe_subscription_id'],
};

const rdfXml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:mp="http://www.mutopiaproject.org/piece-data/0.1/">
<rdf:Description rdf:about=".">
    <mp:title>Sonata No. 14 “Moonlight”</mp:title>
    <mp:composer>BeethovenLv</mp:composer>
    <mp:opus>Op. 27, No. 2</mp:opus>
    <mp:for>Piano</mp:for>
    <mp:date>1802</mp:date>
    <mp:source>Berners, 1908</mp:source>
    <mp:licence>Creative Commons Attribution-ShareAlike 2.5</mp:licence>
    <mp:midFile>moonlight.mid</mp:midFile>
    <mp:pdfFileLet>moonlight-let.pdf</mp:pdfFileLet>
    <mp:id>Mutopia-2007/02/11-276</mp:id>
    <mp:maintainer>Stewart Holmes</mp:maintainer>
</rdf:Description>
</rdf:RDF>
`;

const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolveBody) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolveBody(Buffer.concat(chunks)));
    });

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === null ? '' : JSON.stringify(body));
};

const filterRows = (rows: Row[], params: URLSearchParams): Row[] => {
    let out = rows;
    for (const [key, value] of params) {
        if (['select', 'order', 'limit', 'on_conflict'].includes(key)) {
            continue;
        }
        const eq = /^eq\.(.*)$/.exec(value);
        const inList = /^in\.\((.*)\)$/.exec(value);
        if (eq) {
            out = out.filter((r) => String(r[key]) === eq[1]);
        } else if (inList) {
            const wanted = new Set(inList[1]!.split(','));
            out = out.filter((r) => wanted.has(String(r[key])));
        }
    }
    return out;
};

const startBackend = async (pdf: Buffer): Promise<FakeBackend> => {
    const backend: FakeBackend = {
        server: createServer(),
        url: '',
        tables: {
            playalong_corpus_seed: [],
            playalong_corpus_control: [{ paused: false }],
            pd_pdf_store: [],
            documents: [],
            score_analyses: [],
            omr_jobs: [],
            subscriptions: [],
        },
        storage: new Map(),
        requests: [],
    };
    let nextJobId = 1;
    backend.server.on('request', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        backend.requests.push(`${req.method} ${url.pathname}`);
        const body = await readBody(req);

        // Fake Mutopia FTP tree.
        if (url.pathname.startsWith('/ftp/') && url.pathname.endsWith('/moonlight.rdf')) {
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            return res.end(rdfXml);
        }
        if (url.pathname.startsWith('/ftp/') && url.pathname.endsWith('/moonlight-let.pdf')) {
            res.writeHead(200, { 'Content-Type': 'application/pdf' });
            return res.end(pdf);
        }

        // Storage.
        const storageObject = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
        if (url.pathname === '/storage/v1/object/copy' && req.method === 'POST') {
            const { bucketId, sourceKey, destinationBucket, destinationKey } = JSON.parse(body.toString()) as Record<
                string,
                string
            >;
            const bytes = backend.storage.get(`${bucketId}/${sourceKey}`);
            if (!bytes) {
                return json(res, 404, { error: 'not found' });
            }
            backend.storage.set(`${destinationBucket}/${destinationKey}`, bytes);
            return json(res, 200, { Key: `${destinationBucket}/${destinationKey}` });
        }
        if (storageObject && req.method === 'POST') {
            backend.storage.set(`${storageObject[1]}/${decodeURIComponent(storageObject[2]!)}`, body);
            return json(res, 200, { Key: url.pathname });
        }
        if (storageObject && req.method === 'GET') {
            const bytes = backend.storage.get(`${storageObject[1]}/${decodeURIComponent(storageObject[2]!)}`);
            if (!bytes) {
                return json(res, 404, { error: 'not found' });
            }
            res.writeHead(200, { 'Content-Type': 'application/pdf' });
            return res.end(bytes);
        }

        // PostgREST.
        if (url.pathname === '/rest/v1/rpc/get_entitlements') {
            return json(res, 200, { tier: 'academy', limits: { cloud_scores: -1 } });
        }
        const table = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)?.[1];
        if (!table || !(table in backend.tables)) {
            return json(res, 404, { message: `no such table ${url.pathname}` });
        }
        const rows = backend.tables[table]!;
        if (req.method === 'GET') {
            return json(res, 200, filterRows(rows, url.searchParams));
        }
        if (req.method === 'POST') {
            const incoming = JSON.parse(body.toString()) as Row[];
            const merge = (req.headers.prefer ?? '').includes('merge-duplicates');
            const keys = KEYS[table] ?? [];
            for (const row of incoming) {
                if (table === 'omr_jobs') {
                    if (
                        rows.some(
                            (r) =>
                                r.document_id === row.document_id && ['queued', 'running'].includes(String(r.status)),
                        )
                    ) {
                        return json(res, 409, { code: '23505', message: 'omr_jobs_one_active_per_doc' });
                    }
                    rows.push({ ...row, id: nextJobId++ });
                    continue;
                }
                const idx = rows.findIndex((r) => keys.every((k) => r[k] === row[k]));
                if (idx >= 0) {
                    if (!merge) {
                        return json(res, 409, { code: '23505', message: 'duplicate key' });
                    }
                    rows[idx] = { ...rows[idx], ...row };
                } else {
                    rows.push({ ...row });
                }
            }
            return json(res, 201, null);
        }
        if (req.method === 'PATCH') {
            const patch = JSON.parse(body.toString()) as Row;
            for (const row of filterRows(rows, url.searchParams)) {
                Object.assign(row, patch);
            }
            return json(res, 204, null);
        }
        return json(res, 405, {});
    });
    await new Promise<void>((r) => backend.server.listen(0, '127.0.0.1', r));
    backend.url = `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`;
    return backend;
};

const seedCache = (dir: string, entries: Record<string, string>): void => {
    mkdirSync(dir, { recursive: true });
    for (const [url, body] of Object.entries(entries)) {
        writeFileSync(join(dir, `${createHash('sha1').update(url).digest('hex')}.txt`), body);
    }
};

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Async spawn: the fake backend lives in this process, so the loop must keep turning. */
const runSeed = (args: string[], env: Record<string, string | undefined>): Promise<RunResult> =>
    new Promise((resolveRun, reject) => {
        const child = spawn(
            process.execPath,
            [
                '--experimental-strip-types',
                '--disable-warning=ExperimentalWarning',
                resolve(process.cwd(), 'scripts/seed-playalong-corpus.mjs'),
                ...args,
            ],
            { env: { ...process.env, CORPUS_OWNER_USER_ID: undefined, ...env } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
        child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        child.on('error', reject);
        child.on('close', (status) => {
            clearTimeout(timer);
            resolveRun({ status, stdout, stderr });
        });
    });

const events = (stdout: string): Array<Record<string, unknown>> =>
    stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('seed modes against a fake backend', () => {
    let backend: FakeBackend;
    let root: string;
    let commonArgs: string[];
    let env: Record<string, string>;
    let pdfSha: string;

    beforeEach(async () => {
        const doc = await pdfLib.PDFDocument.create();
        doc.addPage([200, 200]);
        doc.addPage([200, 200]);
        const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
        pdfSha = createHash('sha256').update(pdf).digest('hex');
        backend = await startBackend(pdf);
        root = mkdtempSync(join(tmpdir(), 'corpus-modes-'));
        const cache = join(root, 'cache');
        const evalDir = join(root, 'eval');
        mkdirSync(evalDir);
        seedCache(cache, {
            [MUTOPIA_TREE_URL]: JSON.stringify({
                truncated: false,
                tree: [{ type: 'blob', path: 'ftp/BeethovenLv/O27/moonlight/moonlight-lys/moonlight1-let.ly' }],
            }),
            ...Object.fromEntries(
                OPENSCORE_REPOS.map((repo) => [repo.treeUrl, JSON.stringify({ truncated: false, tree: [] })]),
            ),
        });
        commonArgs = [
            '--limit',
            '1',
            '--sleep',
            '0',
            '--source',
            'mutopia',
            '--cache-dir',
            cache,
            '--eval-dir',
            evalDir,
            '--catalog',
            join(root, 'missing.jsonl'),
        ];
        env = { SUPABASE_URL: backend.url, SUPABASE_SERVICE_ROLE_KEY: 'test-key', CORPUS_MUTOPIA_ORIGIN: backend.url };
    });

    afterEach(async () => {
        await new Promise<void>((r) => backend.server.close(() => r()));
    });

    it('--fetch-only fills pd-pdfs, pd_pdf_store and the ledger without an owner, then --enqueue-fetched mints documents + jobs idempotently', async () => {
        const fetched = await runSeed(['--fetch-only', ...commonArgs], env);
        expect(fetched.status, fetched.stderr).toBe(0);
        expect(fetched.stderr).toMatch(/mode fetch/);

        const ledger = backend.tables.playalong_corpus_seed!;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({
            work_title: MOONLIGHT,
            origin: 'mutopia',
            filename: 'moonlight-let.pdf',
            status: 'fetched',
            pdf_sha256: pdfSha,
            page_count: 2,
            licence_tag: 'CC-BY-SA',
            us_pd: true,
            tier: 0,
            attempts: 1,
        });
        expect(ledger[0]!.document_id).toBeUndefined();
        expect(backend.tables.pd_pdf_store).toEqual([
            expect.objectContaining({
                pdf_sha256: pdfSha,
                filename: 'moonlight-let.pdf',
                work_title: MOONLIGHT,
                origin: 'mutopia',
                licence_tag: 'CC-BY-SA',
                page_count: 2,
            }),
        ]);
        expect([...backend.storage.keys()]).toEqual([`pd-pdfs/${pdfSha}/moonlight-let.pdf`]);
        expect(backend.tables.documents).toEqual([]);
        expect(backend.tables.score_analyses).toEqual([]);
        expect(backend.tables.omr_jobs).toEqual([]);
        expect(backend.requests).not.toContain('POST /rest/v1/rpc/get_entitlements');
        const fetchEvents = events(fetched.stdout);
        expect(fetchEvents.find((e) => e.status === 'fetched')).toMatchObject({
            workTitle: MOONLIGHT,
            pdfSha256: pdfSha,
        });
        expect(fetchEvents.at(-1)).toMatchObject({
            event: 'corpus_seed',
            mode: 'fetch',
            fetched: 1,
            queued: 0,
            covered: 1,
            target: 1,
            attempted: 1,
        });
        expect(typeof fetchEvents.at(-1)!.eta_s).toBe('number');

        // A second fetch pass is a no-op: the row is covered.
        const again = await runSeed(['--fetch-only', ...commonArgs], env);
        expect(again.status, again.stderr).toBe(0);
        expect(events(again.stdout).at(-1)).toMatchObject({ fetched: 1, attempted: 0 });
        expect(backend.tables.pd_pdf_store).toHaveLength(1);

        // Enqueue needs the owner.
        const noOwner = await runSeed(['--enqueue-fetched', '--sleep', '0'], env);
        expect(noOwner.status).toBe(2);
        expect(noOwner.stderr).toMatch(/CORPUS_OWNER_USER_ID is required/);

        const enqueued = await runSeed(['--enqueue-fetched', '--sleep', '0'], { ...env, CORPUS_OWNER_USER_ID: OWNER });
        expect(enqueued.status, enqueued.stderr).toBe(0);
        expect(enqueued.stderr).toMatch(/enqueue: 1 fetched ledger rows/);
        expect(backend.requests).toContain('POST /rest/v1/rpc/get_entitlements');
        const doc = backend.tables.documents![0]!;
        expect(doc).toMatchObject({
            owner_id: OWNER,
            title: MOONLIGHT,
            page_count: 2,
            storage_path: `${doc.id}/original.pdf`,
        });
        expect(ledger[0]).toMatchObject({ status: 'queued', document_id: doc.id, pdf_sha256: pdfSha });
        expect(backend.tables.score_analyses).toEqual([
            expect.objectContaining({ document_id: doc.id, created_by: OWNER, status: 'pending' }),
        ]);
        expect(backend.tables.omr_jobs).toEqual([
            expect.objectContaining({
                document_id: doc.id,
                status: 'queued',
                priority: -10,
                page_count: 2,
                created_by: OWNER,
                storage_path: `${doc.id}/original.pdf`,
            }),
        ]);
        expect(backend.storage.get(`scores/${doc.id}/original.pdf`)).toEqual(
            backend.storage.get(`pd-pdfs/${pdfSha}/moonlight-let.pdf`),
        );
        expect(backend.requests).toContain('POST /storage/v1/object/copy');
        expect(events(enqueued.stdout).at(-1)).toMatchObject({ mode: 'enqueue', queued: 1, fetched: 0, target: 1 });

        // Idempotent: nothing new on a rerun.
        const rerun = await runSeed(['--enqueue-fetched', '--sleep', '0'], { ...env, CORPUS_OWNER_USER_ID: OWNER });
        expect(rerun.status, rerun.stderr).toBe(0);
        expect(rerun.stderr).toMatch(/enqueue: 0 fetched ledger rows/);
        expect(backend.tables.documents).toHaveLength(1);
        expect(backend.tables.omr_jobs).toHaveLength(1);
        expect(backend.tables.score_analyses).toHaveLength(1);
    });

    it('the default pass fetches and enqueues in one go', async () => {
        const result = await runSeed(commonArgs, { ...env, CORPUS_OWNER_USER_ID: OWNER });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/mode seed/);
        const doc = backend.tables.documents![0]!;
        expect(backend.tables.playalong_corpus_seed![0]).toMatchObject({
            status: 'queued',
            document_id: doc.id,
            pdf_sha256: pdfSha,
        });
        expect(backend.tables.omr_jobs).toEqual([expect.objectContaining({ document_id: doc.id, priority: -10 })]);
        expect([...backend.storage.keys()].sort()).toEqual([
            `pd-pdfs/${pdfSha}/moonlight-let.pdf`,
            `scores/${doc.id}/original.pdf`,
        ]);
        // The bytes were still in hand: no Storage copy round-trip.
        expect(backend.requests).not.toContain('POST /storage/v1/object/copy');
        const statuses = events(result.stdout).map((e) => e.status);
        expect(statuses).toContain('fetched');
        expect(statuses).toContain('queued');
    });

    it('--max-runtime stops cleanly before the first work when already expired', async () => {
        const result = await runSeed(['--fetch-only', '--max-runtime', '0.0001', ...commonArgs], env);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/stopped \(max_runtime\)/);
        expect(backend.tables.playalong_corpus_seed).toEqual([]);
        expect((await runSeed(['--fetch-only', '--max-runtime', 'soon'], env)).stderr).toMatch(
            /--max-runtime needs minutes/,
        );
    });
});
