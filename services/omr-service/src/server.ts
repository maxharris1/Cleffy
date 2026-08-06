import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { runClaimedJob, runJob, type JobRequest } from './job.js';
import { claimJob, hasQueuedWork, newWorkerId, reapExpiredLeases } from './jobStore.js';
import { JobQueue } from './queue.js';
import { supabaseWriteback } from './writeback.js';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const SECRET = process.env.OMR_SERVICE_SECRET ?? '';
const MAX_QUEUE_DEPTH = 4;
const MAX_BODY_BYTES = 64 * 1024;
/** Local-only self-claim interval. NEVER set in production (background work). */
const DEV_POLL_MS = Number.parseInt(process.env.DEV_POLL_MS ?? '0', 10);
const SELF_URL = (process.env.SELF_URL ?? '').replace(/\/$/, '');
const POKE_SEND_RACE_MS = 250;

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
 * Validate an incoming job request body. SSRF guard: SUPABASE_URL is required;
 * the PDF URL must share that origin, live under the scores signed-object path,
 * and include this job's documentId folder. Fail closed when misconfigured.
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
    if (!supabaseUrl) {
        return null;
    }
    let allowedOrigin: string;
    try {
        allowedOrigin = new URL(supabaseUrl).origin;
    } catch {
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
    if (url.origin !== allowedOrigin) {
        return null;
    }
    const expectedPath = `/storage/v1/object/sign/scores/${documentId}/`;
    if (!url.pathname.startsWith(expectedPath)) {
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

/** Fire-and-forget self-poke: await only a short send-race, never the response. */
const pokeSelf = async (): Promise<void> => {
    if (!SELF_URL || !SECRET) {
        return;
    }
    const more = await hasQueuedWork();
    if (!more) {
        return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), POKE_SEND_RACE_MS);
    try {
        await fetch(`${SELF_URL}/poke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-omr-secret': SECRET },
            body: '{}',
            signal: ac.signal,
        });
    } catch {
        // Abort after headers / network error — expected for send-race.
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Request-anchored worker body: claim ≤1 job and run it to completion.
 * Returns whether a job was claimed.
 */
const processOneClaim = async (): Promise<boolean> => {
    await reapExpiredLeases();

    const workerId = newWorkerId();
    const job = await claimJob(workerId);
    if (!job) {
        return false;
    }

    try {
        await runClaimedJob(job, workerId, supabaseWriteback);
    } catch (err) {
        console.error('[poke] unexpected', err);
    }
    return true;
};

/**
 * Request-anchored worker: claim ≤1 job, hold the HTTP request for the full
 * run, self-poke before responding so --concurrency 1 fans out to another
 * instance.
 */
const handlePoke = async (res: ServerResponse): Promise<void> => {
    const claimed = await processOneClaim();
    if (!claimed) {
        res.writeHead(204);
        res.end();
        return;
    }

    // Fan-out: poke before respond so this instance (still busy) is ineligible.
    await pokeSelf();
    json(res, 200, { ok: true, claimed: true });
};

export const server = createServer((req, res) => {
    void (async () => {
        if (req.method === 'GET' && req.url === '/healthz') {
            json(res, 200, { ok: true });
            return;
        }

        if (req.method === 'POST' && req.url === '/poke') {
            if (!secretMatches(req.headers['x-omr-secret'] as string | undefined)) {
                json(res, 401, { error: 'Unauthorized' });
                return;
            }
            await handlePoke(res);
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

    if (DEV_POLL_MS > 0) {
        console.warn(
            `[dev] DEV_POLL_MS=${DEV_POLL_MS} — local self-claim loop; NEVER set in production`,
        );
        setInterval(() => {
            void processOneClaim()
                .then((claimed) => (claimed ? pokeSelf() : undefined))
                .catch((err) => console.warn('[dev-poll]', err));
        }, DEV_POLL_MS);
    }
}
