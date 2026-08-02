import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { runJob, type JobRequest } from './job.js';
import { JobQueue } from './queue.js';
import { supabaseWriteback } from './writeback.js';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const SECRET = process.env.OMR_SERVICE_SECRET ?? '';
const MAX_QUEUE_DEPTH = 4;
const MAX_BODY_BYTES = 64 * 1024;

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const secretMatches = (header: string | undefined): boolean => {
    if (!SECRET || !header) {
        return false;
    }
    const expected = Buffer.from(SECRET);
    const received = Buffer.from(header);
    return expected.length === received.length && timingSafeEqual(expected, received);
};

/**
 * Validate an incoming job request body. SSRF guard: when SUPABASE_URL is
 * configured, the PDF URL must be one of our own storage signed URLs — this
 * service fetches nothing else.
 */
export const validateJobRequest = (raw: unknown, supabaseUrl: string | undefined): JobRequest | null => {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const body = raw as Record<string, unknown>;
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    const pdfSignedUrl = typeof body.pdfSignedUrl === 'string' ? body.pdfSignedUrl : '';
    const pageCount =
        typeof body.pageCount === 'number' && Number.isFinite(body.pageCount) ? Math.floor(body.pageCount) : null;
    if (!uuidRe.test(documentId)) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(pdfSignedUrl);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return null;
    }
    if (supabaseUrl && !pdfSignedUrl.startsWith(`${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/sign/`)) {
        return null;
    }
    return { documentId, pdfSignedUrl, pageCount };
};

const queue = new JobQueue<JobRequest>(MAX_QUEUE_DEPTH, (job) => runJob(job, supabaseWriteback));

const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

export const server = createServer((req, res) => {
    void (async () => {
        if (req.method === 'GET' && req.url === '/healthz') {
            json(res, 200, { ok: true, depth: queue.depth });
            return;
        }
        if (req.method !== 'POST' || req.url !== '/jobs') {
            json(res, 404, { error: 'Not found' });
            return;
        }
        if (!secretMatches(req.headers['x-omr-secret'] as string | undefined)) {
            json(res, 401, { error: 'Unauthorized' });
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readBody(req));
        } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
        }
        const job = validateJobRequest(parsed, process.env.SUPABASE_URL);
        if (!job) {
            json(res, 400, { error: 'Invalid job request' });
            return;
        }
        if (!queue.enqueue(job)) {
            json(res, 429, { error: 'Queue full' });
            return;
        }
        json(res, 202, { ok: true, queued: true, depth: queue.depth });
    })().catch((err) => {
        console.error('[server]', err);
        json(res, 500, { error: 'Internal error' });
    });
});

// Started directly (node dist/server.js) — not when imported by tests.
if (process.argv[1]?.endsWith('server.js')) {
    if (!SECRET) {
        console.error('OMR_SERVICE_SECRET is required');
        process.exit(1);
    }
    server.listen(PORT, () => console.log(`omr-service listening on :${PORT}`));
}
