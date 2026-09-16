#!/usr/bin/env node
/**
 * Pre-populate the play-along corpus: rank the works Cleffy users are likely
 * to open, fetch a public-domain / CC PDF for each from a bulk-friendly mirror
 * (Mutopia → OpenScore → Internet Archive `imslp` collection), keep it in the
 * shared `pd-pdfs` store, mint a corpus-owner document, and queue a low-priority
 * OMR job so the existing worker fills `playalong_corpus`.
 *
 * IMSLP is metadata only (work identity, per-file licence tags via api.php,
 * crawl-delay 2s). This script never requests an IMSLP file URL — see
 * docs/imslp-access-options.md.
 *
 * Usage:
 *   npm run corpus:seed -- --dry-run
 *   npm run corpus:seed -- --fetch-only --limit 5000 --batch 40        # PDFs into pd-pdfs, no owner needed
 *   npm run corpus:seed -- --enqueue-fetched                           # fetched rows → documents + jobs
 *   npm run corpus:seed -- --limit 2000 --batch 40 --re-rank           # both in one pass
 *
 * Modes:
 *   --fetch-only         rank, resolve, licence-filter, download, pd-pdfs + pd_pdf_store, ledger `fetched`;
 *                        no documents / score_analyses / omr_jobs; CORPUS_OWNER_USER_ID not needed
 *   --enqueue-fetched    for ledger rows in `fetched`: corpus-owner document, copy to scores/{id}/original.pdf,
 *                        pending score_analyses + omr_jobs (priority -10), ledger `queued`; needs the owner
 *   --rank-only          print the ranked list (JSON lines, `corpus_rank`) and exit — eyeball before a long run
 *   (neither)            fetch and enqueue in one pass
 *
 * Flags:
 *   --limit N            hard cap on ranked works and floor on covered works (5000)
 *   --no-wiki            skip the Wikipedia pageviews demand proxy (cold-start order only)
 *   --no-editions        skip the IMSLP edition lookup (no per-work api.php call)
 *   --max-runtime M      stop cleanly after M minutes (finishes the current file)
 *   --batch N            works per batch before a progress line + pause check (40)
 *   --sleep S            seconds between works (2)
 *   --source X           mutopia|openscore|ia|all, comma list allowed (all)
 *   --retry-skipped      re-try ledger rows the licence / size filter skipped
 *   --re-rank            merge live demand (documents.title, playalong_corpus.use_count)
 *   --dry-run            resolve + plan only; no downloads, no writes
 *   --ensure-owner-plan  give the corpus owner an unlimited (academy) plan row
 *   --cache-dir P        metadata cache (scripts/data/.corpus-seed-cache)
 *   --musescore BIN      render OpenScore .mscz to PDF when a repo ships none
 *   --catalog P          IMSLP works catalog jsonl(.gz) (scripts/data/…)
 *   --eval-dir P         eval pins directory (services/omr-service/eval/corpus)
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both unset → local stack),
 *      CORPUS_OWNER_USER_ID (auth.users id; required unless --dry-run).
 */

/* global AbortSignal */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pdfLib from 'pdf-lib';

import { parseWorkPageLicenses } from '../supabase/functions/_shared/imslpLicense.ts';
import { POPULAR_WORKS } from '../supabase/functions/_shared/popularWorks.ts';
import { CATALOG_JSONL_PATH, SYNC_JSON_PATH, readCatalog } from './imslp-catalog.mjs';
import {
    IMSLP_CRAWL_DELAY_MS,
    WIKI_DELAY_MS,
    MAX_PAGES,
    MAX_PDF_BYTES,
    MUTOPIA_ORIGIN,
    MUTOPIA_TREE_URL,
    OPENSCORE_REPOS,
    ORIGINS,
    PARK_AFTER_FAILURES,
    SEED_JOB_PRIORITY,
    backoffDelayMs,
    coverageByOrigin,
    coveredWorkCount,
    composerArticleName,
    composerNameOf,
    composerSurnameOf,
    demandFromDocumentTitles,
    editionSignals,
    evalPinPieceDirs,
    expandZipResolution,
    iaExactQuery,
    iaFallbackQueries,
    iaResolution,
    iaSearchUrl,
    imslpEditions,
    imslpParseUrl,
    imslpRedirectAliases,
    imslpRedirectsUrl,
    mutopiaPieceCandidate,
    mutopiaPieceMatches,
    monthlyAverageViews,
    mutopiaPiecesFromTree,
    mutopiaResolution,
    openscoreResolution,
    openscoreWorkMatches,
    openscoreWorksFromTree,
    parseMutopiaRdf,
    parseSources,
    pickIaDoc,
    pickIaPdf,
    planWork,
    progressEvent,
    rankWorks,
    reconcileQueued,
    shouldProcess,
    sourceEnabled,
    titleForMutopiaPiece,
    wikiArticleFor,
    wikiPageviewsUrl,
    wikiSearchQuery,
    wikiSearchUrl,
    workEvent,
    zipEntries,
    zipExtract,
} from './playalong-corpus.mjs';

const { PDFDocument } = pdfLib;
const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_CORPUS_DIR = resolve(ROOT, 'services/omr-service/eval/corpus');
const DEFAULT_CACHE_DIR = resolve(ROOT, 'scripts/data/.corpus-seed-cache');
const LOCAL_SERVICE_ROLE_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const USER_AGENT = 'Cleffy corpus seed (+https://cleffy.app; metadata + public-domain mirrors only)';
const HTTP_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 1000;
const PD_BUCKET = 'pd-pdfs';
const SCORES_BUCKET = 'scores';
const MAX_MUTOPIA_CANDIDATES = 80;

const die = (message) => {
    console.error(`seed-playalong-corpus: ${message}`);
    process.exit(2);
};

const info = (message) => {
    console.error(`[corpus-seed] ${message}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Args / target
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
    const out = {
        limit: null,
        batch: 40,
        sleepMs: 2000,
        sources: [...ORIGINS],
        retrySkipped: false,
        reRank: false,
        dryRun: false,
        fetchOnly: false,
        enqueueFetched: false,
        rankOnly: false,
        noWiki: false,
        noEditions: false,
        maxRuntimeMs: null,
        ensureOwnerPlan: false,
        cacheDir: DEFAULT_CACHE_DIR,
        musescore: null,
        catalog: CATALOG_JSONL_PATH,
        sync: SYNC_JSON_PATH,
        evalDir: EVAL_CORPUS_DIR,
    };
    const intArg = (name, i) => {
        const value = Number(argv[i]);
        if (!Number.isInteger(value) || value < 0) {
            die(`${name} needs a non-negative integer`);
        }
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--limit':
                out.limit = intArg(arg, ++i);
                break;
            case '--batch':
                out.batch = Math.max(1, intArg(arg, ++i));
                break;
            case '--sleep':
                out.sleepMs = Math.round(Number(argv[++i]) * 1000);
                if (!Number.isFinite(out.sleepMs) || out.sleepMs < 0) {
                    die('--sleep needs seconds');
                }
                break;
            case '--source':
                try {
                    out.sources = parseSources(argv[++i]);
                } catch (err) {
                    die(err instanceof Error ? err.message : String(err));
                }
                break;
            case '--retry-skipped':
                out.retrySkipped = true;
                break;
            case '--fetch-only':
                out.fetchOnly = true;
                break;
            case '--rank-only':
                out.rankOnly = true;
                break;
            case '--no-wiki':
                out.noWiki = true;
                break;
            case '--no-editions':
                out.noEditions = true;
                break;
            case '--enqueue-fetched':
                out.enqueueFetched = true;
                break;
            case '--max-runtime': {
                const minutes = Number(argv[++i]);
                if (!Number.isFinite(minutes) || minutes <= 0) {
                    die('--max-runtime needs minutes');
                }
                out.maxRuntimeMs = Math.round(minutes * 60_000);
                break;
            }
            case '--re-rank':
                out.reRank = true;
                break;
            case '--dry-run':
                out.dryRun = true;
                break;
            case '--ensure-owner-plan':
                out.ensureOwnerPlan = true;
                break;
            case '--cache-dir':
                out.cacheDir = resolve(argv[++i] ?? die('--cache-dir needs a path'));
                break;
            case '--musescore':
                out.musescore = argv[++i] ?? die('--musescore needs a binary path');
                break;
            case '--eval-dir':
                out.evalDir = resolve(argv[++i] ?? die('--eval-dir needs a path'));
                break;
            case '--catalog': {
                const value = argv[++i];
                if (!value) {
                    die('--catalog needs a path');
                }
                out.catalog = resolve(value);
                const sibling = out.catalog
                    .replace(/-catalog\.jsonl\.gz$/, '-sync.json')
                    .replace(/-catalog\.jsonl$/, '-sync.json');
                if (sibling !== out.catalog) {
                    out.sync = sibling;
                }
                break;
            }
            default:
                die(`unknown flag: ${arg}`);
        }
    }
    return out;
};

const localApiPort = () => {
    const toml = readFileSync(resolve(ROOT, 'supabase/config.toml'), 'utf8');
    const section = toml.split(/^\[api\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
    const port = section.match(/^\s*port\s*=\s*(\d+)/m)?.[1];
    if (!port) {
        die('could not read [api] port from supabase/config.toml');
    }
    return port;
};

const resolveTarget = () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
        return { url: url.replace(/\/+$/, ''), key, label: url };
    }
    if (url || key) {
        die('set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither for the local stack');
    }
    const local = `http://127.0.0.1:${localApiPort()}`;
    return { url: local, key: LOCAL_SERVICE_ROLE_KEY, label: `${local} (local stack)` };
};

// ---------------------------------------------------------------------------
// HTTP + disk cache
// ---------------------------------------------------------------------------

const makeCache = (dir) => {
    mkdirSync(dir, { recursive: true });
    const pathFor = (key) => join(dir, `${createHash('sha1').update(key).digest('hex')}.txt`);
    return {
        get: (key) => {
            const path = pathFor(key);
            return existsSync(path) ? readFileSync(path, 'utf8') : null;
        },
        set: (key, text) => {
            writeFileSync(pathFor(key), text);
        },
        delete: (key) => {
            rmSync(pathFor(key), { force: true });
        },
    };
};

class HttpError extends Error {
    constructor(status, url) {
        super(`HTTP ${status} ${url}`);
        this.status = status;
    }
}

const fetchText = async (url, { headers = {} } = {}) => {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new HttpError(res.status, url);
    }
    return res.text();
};

/** Cached text fetch; cache misses hit the network once per key. */
const cachedText = async (cache, url, headers) => {
    const hit = cache.get(url);
    if (hit !== null) {
        return hit;
    }
    const text = await fetchText(url, { headers });
    cache.set(url, text);
    return text;
};

const fetchBytes = async (url, maxBytes = MAX_PDF_BYTES) => {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
        redirect: 'follow',
    });
    if (!res.ok) {
        throw new HttpError(res.status, url);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
        throw new Error('too_large');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
        throw new Error('too_large');
    }
    return buf;
};

const isTransient = (err) =>
    err instanceof HttpError
        ? err.status === 429 || err.status >= 500
        : /timeout|ECONN|EAI_AGAIN|fetch failed/i.test(String(err?.message));

// ---------------------------------------------------------------------------
// PostgREST + Storage (service role)
// ---------------------------------------------------------------------------

const makeDb = ({ url, key }) => {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const request = async (path, init = {}) => {
        const res = await fetch(`${url}/rest/v1${path}`, {
            ...init,
            headers: { ...headers, ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            const err = new Error(`PostgREST ${init.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 300)}`);
            err.status = res.status;
            err.body = body;
            throw err;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    };
    const selectAll = async (path) => {
        const rows = [];
        for (let from = 0; ; from += PAGE_SIZE) {
            const page = await request(path, {
                headers: { Range: `${from}-${from + PAGE_SIZE - 1}`, 'Range-Unit': 'items' },
            });
            rows.push(...(page ?? []));
            if (!page || page.length < PAGE_SIZE) {
                return rows;
            }
        }
    };
    return {
        request,
        selectAll,
        insert: (table, rows, { onConflict = null, merge = false, returning = false } = {}) =>
            request(`/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, {
                method: 'POST',
                headers: {
                    Prefer: [
                        merge ? 'resolution=merge-duplicates' : null,
                        returning ? 'return=representation' : 'return=minimal',
                    ]
                        .filter(Boolean)
                        .join(','),
                },
                body: JSON.stringify(rows),
            }),
        update: (table, query, patch) =>
            request(`/${table}?${query}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(patch),
            }),
        rpc: (name, args) => request(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) }),
        upload: async (bucket, path, bytes) => {
            const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
                method: 'POST',
                headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/pdf',
                    'x-upsert': 'true',
                },
                body: bytes,
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Storage upload ${bucket}/${path} → ${res.status} ${body.slice(0, 300)}`);
            }
        },
        /** Server-side copy between buckets; false when this Storage build cannot. */
        copy: async (fromBucket, fromPath, toBucket, toPath) => {
            const res = await fetch(`${url}/storage/v1/object/copy`, {
                method: 'POST',
                headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bucketId: fromBucket,
                    sourceKey: fromPath,
                    destinationBucket: toBucket,
                    destinationKey: toPath,
                }),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
            if (res.ok) {
                return true;
            }
            // 400 = destination exists / copy unsupported; caller falls back to download + upload.
            await res.text().catch(() => '');
            return false;
        },
        download: async (bucket, path) => {
            const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
                headers: { apikey: key, Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS * 3),
            });
            if (!res.ok) {
                throw new Error(`Storage download ${bucket}/${path} → ${res.status}`);
            }
            return Buffer.from(await res.arrayBuffer());
        },
    };
};

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const ledgerKey = (row) => `${row.work_title}\u0000${row.origin}\u0000${row.filename}`;

const loadLedger = async (db) => {
    const rows = await db.selectAll(
        '/playalong_corpus_seed?select=work_title,origin,filename,document_id,tier,status,last_error,pdf_sha256,page_count,batch_id,attempts,source_url&order=work_title,origin,filename',
    );
    return new Map(rows.map((row) => [ledgerKey(row), row]));
};

const upsertLedger = async (db, ledger, row) => {
    await db.insert('playalong_corpus_seed', [{ ...row, updated_at: new Date().toISOString() }], {
        onConflict: 'work_title,origin,filename',
        merge: true,
    });
    const key = ledgerKey(row);
    ledger.set(key, { ...(ledger.get(key) ?? {}), ...row });
};

/** Move `queued` rows to `ready` / `failed` / `needs_review` from the worker's outcome. */
const reconcileLedger = async (db, ledger) => {
    const queued = [...ledger.values()].filter((row) => row.status === 'queued' && row.document_id);
    let changed = 0;
    for (let i = 0; i < queued.length; i += 100) {
        const chunk = queued.slice(i, i + 100);
        const ids = chunk.map((r) => r.document_id).join(',');
        const jobs = await db.request(
            `/omr_jobs?select=document_id,status,last_error,id&document_id=in.(${ids})&order=id.desc`,
        );
        // `timings` carries the worker's corpus-promotion verdict.
        const analyses = await db.request(
            `/score_analyses?select=document_id,status,error,timings&document_id=in.(${ids})`,
        );
        const latestJob = new Map();
        for (const job of jobs ?? []) {
            if (!latestJob.has(job.document_id)) {
                latestJob.set(job.document_id, job);
            }
        }
        const analysisBy = new Map((analyses ?? []).map((a) => [a.document_id, a]));
        for (const row of chunk) {
            const next = reconcileQueued(latestJob.get(row.document_id), analysisBy.get(row.document_id));
            if (!next) {
                continue;
            }
            await upsertLedger(db, ledger, {
                work_title: row.work_title,
                origin: row.origin,
                filename: row.filename,
                status: next.status,
                last_error: next.error,
            });
            changed += 1;
        }
    }
    return changed;
};

/**
 * Files the corpus-promotion gate held back, newest batch first. These played
 * fine for whoever asked for them but are probably not the work they are filed
 * under, so they are worth a human glance before anyone widens the filters.
 */
const reportNeedsReview = (ledger) => {
    const rows = [...ledger.values()].filter(
        (row) => row.status === 'skipped' && String(row.last_error ?? '').startsWith('needs_review'),
    );
    if (rows.length === 0) {
        return;
    }
    console.log(
        JSON.stringify({
            event: 'corpus_seed_needs_review',
            count: rows.length,
            files: rows
                .sort((a, b) => Number(b.batch_id ?? 0) - Number(a.batch_id ?? 0))
                .map((row) => ({
                    workTitle: row.work_title,
                    origin: row.origin,
                    filename: row.filename,
                    reason: row.last_error,
                    pageCount: row.page_count ?? null,
                    sourceUrl: row.source_url ?? null,
                })),
        }),
    );
};

const ledgerCounts = (ledger) => {
    const counts = { ready: 0, queued: 0, fetched: 0, skipped: 0, failed: 0 };
    for (const row of ledger.values()) {
        if (row.status in counts) {
            counts[row.status] += 1;
        }
    }
    return counts;
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const GITHUB_HEADERS = { Accept: 'application/vnd.github+json' };

const treePaths = async (cache, url) => {
    const json = JSON.parse(await cachedText(cache, url, GITHUB_HEADERS));
    if (json.truncated) {
        info(`warning: ${url} tree truncated`);
    }
    return (json.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
};

const loadMutopiaIndex = async (cache) => mutopiaPiecesFromTree(await treePaths(cache, MUTOPIA_TREE_URL));

const loadOpenscoreIndex = async (cache) => {
    const out = [];
    for (const repo of OPENSCORE_REPOS) {
        try {
            for (const entry of openscoreWorksFromTree(await treePaths(cache, repo.treeUrl))) {
                out.push({ repo, entry });
            }
        } catch (err) {
            info(`openscore ${repo.id} index unavailable: ${err instanceof Error ? err.message : err}`);
        }
    }
    return out;
};

const mutopiaRdf = async (cache, piece) => {
    const url = `${MUTOPIA_ORIGIN}/${piece.dir}/${piece.piece}.rdf`;
    return parseMutopiaRdf(await cachedText(cache, url));
};

const resolveMutopia = async (ctx, work) => {
    const candidates = ctx.mutopia
        .filter((piece) => mutopiaPieceCandidate(work, piece))
        .slice(0, MAX_MUTOPIA_CANDIDATES);
    const out = [];
    for (const piece of candidates) {
        let rdf;
        try {
            rdf = await mutopiaRdf(ctx.cache, piece);
        } catch (err) {
            if (isTransient(err)) {
                throw err;
            }
            continue;
        }
        if (!mutopiaPieceMatches(work, piece, rdf)) {
            continue;
        }
        const res = mutopiaResolution(work, piece, rdf);
        if (res.ok && res.zipUrl) {
            // Multi-movement piece: one ledger row per PDF inside the zip.
            out.push(
                ...expandZipResolution(
                    res,
                    zipEntries(await zipBytes(ctx, res.zipUrl)).map((e) => e.name),
                ),
            );
            continue;
        }
        out.push(res);
    }
    return out;
};

/** Download a Mutopia zip once per run; several resolutions share it. */
const zipBytes = async (ctx, url) => {
    if (!ctx.zips.has(url)) {
        ctx.zips.set(url, await fetchBytes(url));
    }
    return ctx.zips.get(url);
};

const pdfBytesFor = async (ctx, res) => {
    if (res.zipUrl && res.zipEntry) {
        const buf = await zipBytes(ctx, res.zipUrl);
        const entry = zipEntries(buf).find((e) => e.name === res.zipEntry);
        if (!entry) {
            throw new Error(`zip entry missing: ${res.zipEntry}`);
        }
        return zipExtract(buf, entry);
    }
    if (res.pdfUrl) {
        return fetchBytes(res.pdfUrl);
    }
    return renderWithMusescore(ctx, res.renderFrom);
};

const resolveOpenscore = (ctx, work) =>
    ctx.openscore
        .filter(({ entry }) => openscoreWorkMatches(work, entry))
        .map(({ repo, entry }) => openscoreResolution(work, entry, repo, { renderer: ctx.musescore !== null }));

let lastImslpCallAt = 0;

/** Cached api.php JSON; uncached calls are spaced by the robots.txt crawl delay. */
const imslpJson = async (ctx, url) => {
    if (ctx.cache.get(url) === null) {
        const wait = lastImslpCallAt + IMSLP_CRAWL_DELAY_MS - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        lastImslpCallAt = Date.now();
    }
    return JSON.parse(await cachedText(ctx.cache, url, { Accept: 'application/json' }));
};

/** Per-file IMSLP licence tags for a work page (metadata only). */
const EMPTY_PAGE = Object.freeze({ licences: new Map(), editions: [] });

/**
 * One `action=parse&prop=text|wikitext` call per work: per-file licence tags
 * (rendered page) and edition signals (wikitext blocks + rendered stats).
 * Memoised per run; the disk cache makes reruns free.
 */
const imslpWorkPage = async (ctx, title) => {
    if (ctx.noEditions) {
        return EMPTY_PAGE;
    }
    if (ctx.pages.has(title)) {
        return ctx.pages.get(title);
    }
    const url = imslpParseUrl(title);
    let page = EMPTY_PAGE;
    try {
        const json = await imslpJson(ctx, url);
        const html = json?.parse?.text?.['*'];
        if (typeof html !== 'string') {
            // Missing page / API error: do not pin that answer in the cache.
            ctx.cache.delete(url);
        } else {
            page = {
                licences: parseWorkPageLicenses(html),
                editions: imslpEditions(json?.parse?.wikitext?.['*'] ?? '', html),
            };
        }
    } catch (err) {
        info(`imslp page lookup failed for ${title}: ${err instanceof Error ? err.message : err}`);
    }
    ctx.pages.set(title, page);
    return page;
};

/** Former IMSLP titles of a work (redirects into it), for IA record-id lookups. */
const imslpAliases = async (ctx, title) => {
    try {
        return imslpRedirectAliases(title, await imslpJson(ctx, imslpRedirectsUrl(title)));
    } catch (err) {
        info(`imslp redirect lookup failed for ${title}: ${err instanceof Error ? err.message : err}`);
        return [];
    }
};

const MAX_IA_ALIASES = 8;

const resolveIa = async (ctx, work) => {
    const search = async (query) => JSON.parse(await cachedText(ctx.cache, iaSearchUrl(query))).response?.docs ?? [];
    // The record id encodes the exact IMSLP page title, so its hit is the work —
    // under the current title or any former title IMSLP still redirects from.
    let doc = (await search(iaExactQuery(work.title)))[0] ?? null;
    if (!doc) {
        for (const alias of (await imslpAliases(ctx, work.title)).slice(0, MAX_IA_ALIASES)) {
            doc = (await search(iaExactQuery(alias)))[0] ?? null;
            if (doc) {
                break;
            }
        }
    }
    for (const query of iaFallbackQueries(work.title)) {
        if (doc) {
            break;
        }
        doc = pickIaDoc(work.title, await search(query));
    }
    if (!doc) {
        return [];
    }
    const item = JSON.parse(
        await cachedText(ctx.cache, `https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`),
    );
    if (!item?.metadata?.identifier) {
        return [];
    }
    const page = await imslpWorkPage(ctx, work.title);
    const file = pickIaPdf(item.files, page.editions);
    if (!file) {
        const anyPdf = (item.files ?? []).some((f) => /\.pdf$/i.test(f.name ?? ''));
        return [
            {
                ok: false,
                reason: anyPdf ? 'arrangement_only' : 'no_source',
                origin: 'ia',
                filename: `${doc.identifier}.pdf`,
            },
        ];
    }
    return [iaResolution(work, item, file, page.licences)];
};

const RESOLVERS = { mutopia: resolveMutopia, openscore: resolveOpenscore, ia: resolveIa };

/**
 * Resolve one work across the enabled origins, stopping at the first origin
 * that yields an accepted file. Upstream failures back the origin off and
 * park it after PARK_AFTER_FAILURES in a row.
 */
const resolveWork = async (ctx, work) => {
    const resolutions = [];
    for (const origin of ORIGINS) {
        if (!sourceEnabled(origin, { sources: ctx.sources, parked: ctx.parked })) {
            continue;
        }
        const state = ctx.sourceState[origin];
        try {
            const found = await RESOLVERS[origin](ctx, work);
            state.failures = 0;
            resolutions.push(...found);
            if (found.some((r) => r.ok)) {
                break;
            }
        } catch (err) {
            state.failures += 1;
            const message = err instanceof Error ? err.message : String(err);
            info(`${origin} failed for ${work.title} (${state.failures}): ${message}`);
            if (state.failures >= PARK_AFTER_FAILURES) {
                ctx.parked.add(origin);
                info(`${origin} parked for this run after ${state.failures} consecutive failures`);
            } else if (isTransient(err)) {
                await sleep(backoffDelayMs(state.failures));
            }
        }
    }
    const plan = planWork(resolutions, { sources: ctx.sources });
    // Edition signals for every chosen file (and for the work itself when
    // nothing was chosen, so the best IMSLP edition is on record for --from-dir).
    const { editions } = await imslpWorkPage(ctx, work.title);
    for (const res of plan.queue) {
        res.edition = editionSignals(res, editions);
    }
    plan.edition = plan.queue.length === 0 ? editionSignals(null, editions) : plan.queue[0].edition;
    return plan;
};

// ---------------------------------------------------------------------------
// Ingest one file
// ---------------------------------------------------------------------------

const safeObjectName = (filename) =>
    filename
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9._()-]/g, '')
        .slice(0, 120) || 'score.pdf';

const pageCountOf = async (bytes) => {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
};

const renderWithMusescore = async (ctx, url) => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-seed-'));
    const input = join(dir, 'score.mscz');
    const output = join(dir, 'score.pdf');
    writeFileSync(input, await fetchBytes(url));
    await execFileAsync(ctx.musescore, ['-o', output, input], { timeout: 120_000 });
    return readFileSync(output);
};

const pdObjectPath = (sha, filename) => `${sha}/${safeObjectName(filename)}`;

/**
 * Fetch one resolved file into the shared PD store: download, hash, page
 * count, `pd-pdfs/{sha}/{filename}` + `pd_pdf_store`, ledger `fetched`. No
 * documents, analyses or jobs — that is `enqueueRow`, which needs the owner.
 */
const fetchFile = async (ctx, work, res, batchId) => {
    const { db, ledger } = ctx;
    const key = { work_title: res.workTitle, origin: res.origin, filename: res.filename };
    const existing = ledger.get(ledgerKey(key));
    const attempts = Number(existing?.attempts ?? 0) + 1;

    await upsertLedger(db, ledger, {
        ...key,
        status: 'pending',
        tier: work.tier,
        batch_id: batchId,
        attempts,
        source_url: res.sourceUrl,
        licence_tag: res.licenceTag,
        editor_credit: res.editorCredit,
        us_pd: res.usPd,
        candidate_url: res.candidateUrl,
        edition: res.edition ?? null,
        last_error: null,
    });

    try {
        const bytes = await pdfBytesFor(ctx, res);
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
            throw new Error('not_pdf');
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        const pageCount = await pageCountOf(bytes);
        if (pageCount > MAX_PAGES) {
            await upsertLedger(db, ledger, {
                ...key,
                status: 'skipped',
                last_error: 'too_large',
                pdf_sha256: sha,
                page_count: pageCount,
            });
            console.log(
                workEvent({
                    workTitle: res.workTitle,
                    status: 'skipped',
                    origin: res.origin,
                    filename: res.filename,
                    pdfSha256: sha,
                    reason: 'too_large',
                }),
            );
            return { status: 'skipped' };
        }

        await db.upload(PD_BUCKET, pdObjectPath(sha, res.filename), bytes);
        await db.insert(
            'pd_pdf_store',
            [
                {
                    pdf_sha256: sha,
                    filename: res.filename,
                    work_title: res.workTitle,
                    origin: res.origin,
                    source_url: res.sourceUrl,
                    licence_tag: res.licenceTag,
                    editor_credit: res.editorCredit,
                    us_pd: res.usPd,
                    byte_length: bytes.length,
                    page_count: pageCount,
                    edition: res.edition ?? null,
                },
            ],
            { onConflict: 'pdf_sha256', merge: true },
        );
        await upsertLedger(db, ledger, {
            ...key,
            status: 'fetched',
            pdf_sha256: sha,
            page_count: pageCount,
            last_error: null,
        });
        console.log(
            workEvent({
                workTitle: res.workTitle,
                status: 'fetched',
                origin: res.origin,
                filename: res.filename,
                pdfSha256: sha,
            }),
        );
        return { status: 'fetched', bytes };
    } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const status = message === 'too_large' || message === 'not_pdf' ? 'skipped' : 'failed';
        await upsertLedger(db, ledger, { ...key, status, last_error: message });
        console.log(
            workEvent({
                workTitle: res.workTitle,
                status,
                origin: res.origin,
                filename: res.filename,
                reason: message,
            }),
        );
        return { status };
    }
};

/**
 * Turn a `fetched` ledger row into work for the OMR worker: corpus-owner
 * document, PDF copied from `pd-pdfs` to `scores/{docId}/original.pdf`,
 * pending `score_analyses`, `omr_jobs` at seed priority, ledger `queued`.
 * Idempotent: reuses `document_id`, tolerates an existing document / job.
 * `bytes` skips the Storage copy when the caller still holds the PDF.
 */
const enqueueRow = async (ctx, row, bytes = null) => {
    const { db, ledger, owner } = ctx;
    const key = { work_title: row.work_title, origin: row.origin, filename: row.filename };
    if (!row.pdf_sha256 || !row.page_count) {
        await upsertLedger(db, ledger, { ...key, status: 'failed', last_error: 'fetched_row_incomplete' });
        return 'failed';
    }
    const docId = row.document_id ?? randomUUID();
    const storagePath = `${docId}/original.pdf`;
    try {
        await upsertLedger(db, ledger, { ...key, document_id: docId });
        const existingDoc = await db.request(`/documents?select=id&id=eq.${docId}`);
        if (!existingDoc || existingDoc.length === 0) {
            await db.insert('documents', [
                {
                    id: docId,
                    owner_id: owner,
                    title: row.work_title,
                    storage_path: storagePath,
                    page_count: row.page_count,
                },
            ]);
        }

        const source = pdObjectPath(row.pdf_sha256, row.filename);
        if (bytes) {
            await db.upload(SCORES_BUCKET, storagePath, bytes);
        } else if (!(await db.copy(PD_BUCKET, source, SCORES_BUCKET, storagePath))) {
            await db.upload(SCORES_BUCKET, storagePath, await db.download(PD_BUCKET, source));
        }

        await db.insert(
            'score_analyses',
            [{ document_id: docId, created_by: owner, status: 'pending', progress: null, error: null, score: null }],
            { onConflict: 'document_id', merge: true },
        );
        try {
            await db.insert('omr_jobs', [
                {
                    document_id: docId,
                    status: 'queued',
                    storage_path: storagePath,
                    page_count: row.page_count,
                    created_by: owner,
                    priority: SEED_JOB_PRIORITY,
                },
            ]);
        } catch (err) {
            // omr_jobs_one_active_per_doc: a job for this document is already queued or running.
            if (err.status !== 409) {
                throw err;
            }
        }

        await upsertLedger(db, ledger, { ...key, status: 'queued', last_error: null });
        console.log(
            workEvent({
                workTitle: row.work_title,
                status: 'queued',
                origin: row.origin,
                filename: row.filename,
                pdfSha256: row.pdf_sha256,
            }),
        );
        return 'queued';
    } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        // The PDF is in the store; only the enqueue failed. Stay `fetched` so a rerun retries it.
        await upsertLedger(db, ledger, { ...key, status: 'fetched', last_error: message });
        console.log(
            workEvent({
                workTitle: row.work_title,
                status: 'fetched',
                origin: row.origin,
                filename: row.filename,
                reason: message,
            }),
        );
        return 'failed';
    }
};

/** Default mode: fetch, then enqueue in the same pass. */
const ingestFile = async (ctx, work, res, batchId) => {
    const fetched = await fetchFile(ctx, work, res, batchId);
    if (fetched.status !== 'fetched') {
        return fetched.status;
    }
    const row = ctx.ledger.get(ledgerKey({ work_title: res.workTitle, origin: res.origin, filename: res.filename }));
    return enqueueRow(ctx, row, fetched.bytes);
};

const recordSkip = async (ctx, work, skip, batchId, edition = null) => {
    const key = { work_title: work.title, origin: skip.origin, filename: skip.filename };
    const existing = ctx.ledger.get(ledgerKey(key));
    if (existing && !['pending', 'skipped', 'failed', 'paused'].includes(existing.status)) {
        return;
    }
    await upsertLedger(ctx.db, ctx.ledger, {
        ...key,
        status: 'skipped',
        tier: work.tier,
        batch_id: batchId,
        last_error: skip.reason,
        attempts: Number(existing?.attempts ?? 0) + 1,
        edition,
    });
    console.log(
        workEvent({
            workTitle: work.title,
            status: 'skipped',
            origin: skip.origin,
            filename: skip.filename,
            reason: skip.reason,
        }),
    );
};

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const isPaused = async (db) => {
    const rows = await db.request('/playalong_corpus_control?select=paused&limit=1');
    return Boolean(rows?.[0]?.paused);
};

/**
 * `documents_enforce_score_cap` counts the corpus owner like any account; the
 * seed needs an unlimited plan. Refuse to run against a capped owner unless
 * `--ensure-owner-plan` writes the (non-Stripe) academy row.
 */
const ensureOwnerPlan = async (db, owner, { ensure }) => {
    const ent = await db.rpc('get_entitlements', { p_user: owner });
    const limit = Number(ent?.limits?.cloud_scores);
    if (limit === -1) {
        return;
    }
    if (!ensure) {
        die(
            `corpus owner ${owner} is on tier '${ent?.tier}' with cloud_scores=${limit}; ` +
                `re-run with --ensure-owner-plan (inserts an academy subscriptions row 'corpus-owner:${owner}')`,
        );
    }
    await db.insert(
        'subscriptions',
        [
            {
                stripe_subscription_id: `corpus-owner:${owner}`,
                user_id: owner,
                tier: 'academy',
                status: 'active',
                price_id: null,
                current_period_end: null,
                cancel_at_period_end: false,
                mode: 'live',
            },
        ],
        { onConflict: 'stripe_subscription_id', merge: true },
    );
    const after = await db.rpc('get_entitlements', { p_user: owner });
    if (Number(after?.limits?.cloud_scores) !== -1) {
        die(`owner plan row written but cloud_scores is still ${after?.limits?.cloud_scores}`);
    }
    info(`corpus owner ${owner} now on tier '${after.tier}'`);
};

// ---------------------------------------------------------------------------
// Ranking inputs
// ---------------------------------------------------------------------------

const loadEvalPins = (dir) => {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
};

/** Eval-pinned Mutopia pieces → the IMSLP work title each one is an edition of. */
const pinWorks = async (ctx, pins, catalogWorks) => {
    const dirs = evalPinPieceDirs(pins);
    const byDir = new Map(ctx.mutopia.map((piece) => [piece.dir, piece]));
    const works = [];
    for (const dir of dirs) {
        const piece = byDir.get(dir) ?? {
            dir,
            piece: dir.split('/').pop(),
            composerId: dir.split('/')[1],
            catalogDir: dir.split('/').length >= 4 ? dir.split('/')[2] : null,
        };
        let rdf;
        try {
            rdf = await mutopiaRdf(ctx.cache, piece);
        } catch (err) {
            info(`eval pin ${dir}: RDF unavailable (${err instanceof Error ? err.message : err})`);
            continue;
        }
        const title = titleForMutopiaPiece(piece, rdf, POPULAR_WORKS, catalogWorks);
        if (!title) {
            info(`eval pin ${dir}: no IMSLP title resolved (${rdf.title})`);
            continue;
        }
        works.push({ title, pieceDir: dir });
    }
    info(`eval pins: ${works.length} Mutopia pieces → ${new Set(works.map((w) => w.title)).size} IMSLP titles`);
    return works;
};

let lastWikiCallAt = 0;
let wikiDelayMs = WIKI_DELAY_MS;

/**
 * Cached Wikipedia / Wikimedia JSON. Uncached calls are spaced by an adaptive
 * delay: a 429 doubles it (capped) and is retried after Retry-After / backoff;
 * a clean streak eases it back toward WIKI_DELAY_MS.
 */
const wikiJson = async (ctx, url) => {
    const hit = ctx.cache.get(url);
    if (hit !== null) {
        return JSON.parse(hit);
    }
    for (let attempt = 1; ; attempt++) {
        const wait = lastWikiCallAt + wikiDelayMs - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }
        lastWikiCallAt = Date.now();
        try {
            const json = JSON.parse(await cachedText(ctx.cache, url, { Accept: 'application/json' }));
            wikiDelayMs = Math.max(WIKI_DELAY_MS, Math.round(wikiDelayMs * 0.9));
            return json;
        } catch (err) {
            const throttled = err instanceof HttpError && err.status === 429;
            if (!(throttled || isTransient(err)) || attempt >= 5) {
                throw err;
            }
            wikiDelayMs = Math.min(5000, wikiDelayMs * 2);
            await sleep(backoffDelayMs(attempt, { baseMs: 2000, maxMs: 30_000 }));
        }
    }
};

/** Monthly average views of one article; 0 when the article or its stats are missing. */
const articleViews = async (ctx, article) => {
    if (!article) {
        return 0;
    }
    try {
        return monthlyAverageViews(await wikiJson(ctx, wikiPageviewsUrl(article)));
    } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
            ctx.cache.set(wikiPageviewsUrl(article), JSON.stringify({ items: [] }));
            return 0;
        }
        throw err;
    }
};

/**
 * Wikipedia demand proxy for every ranked title: the work article (found by
 * search, accepted only when it names the composer / catalogue / a title
 * word) and the composer article. Everything is cached, so a rerun is free.
 * `titles` is `[imslpTitle, englishLabel | null]` pairs.
 * @returns {Map<string, { workViews: number, composerViews: number, article: string | null }>}
 */
const loadPopularity = async (ctx, titles) => {
    const out = new Map();
    const composerViews = new Map();
    let done = 0;
    for (const [title, label] of titles) {
        if (stopReason) {
            break;
        }
        let article = null;
        let workViews = 0;
        try {
            // The curated English label ("Blue Danube", "Clair de lune") is what
            // Wikipedia titles the piece; the IMSLP title is often German/French.
            if (label) {
                const surname = composerSurnameOf(title) ?? '';
                const probe = `${label} (${composerNameOf(title) ?? surname})`;
                for (const query of [label, `${label} ${surname}`.trim()]) {
                    article ??= wikiArticleFor(probe, await wikiJson(ctx, wikiSearchUrl(query)));
                }
            }
            article ??= wikiArticleFor(title, await wikiJson(ctx, wikiSearchUrl(wikiSearchQuery(title))));
            workViews = await articleViews(ctx, article);
        } catch (err) {
            info(`wikipedia lookup failed for ${title}: ${err instanceof Error ? err.message : err}`);
        }
        const composer = composerArticleName(title);
        if (composer && !composerViews.has(composer)) {
            try {
                composerViews.set(composer, await articleViews(ctx, composer));
            } catch (err) {
                info(`wikipedia lookup failed for ${composer}: ${err instanceof Error ? err.message : err}`);
                composerViews.set(composer, 0);
            }
        }
        out.set(title, { workViews, composerViews: composer ? (composerViews.get(composer) ?? 0) : 0, article });
        done += 1;
        if (done % 250 === 0) {
            info(`wikipedia: ${done}/${titles.length} titles`);
        }
    }
    return out;
};

const loadDemand = async (db, owner) => {
    const docs = await db.selectAll(`/documents?select=title&owner_id=neq.${owner}`);
    const demand = demandFromDocumentTitles(docs.map((d) => d.title));
    const corpus = await db.selectAll(
        '/playalong_corpus?select=imslp_page_title,use_count&imslp_page_title=not.is.null',
    );
    const corpusUse = new Map();
    for (const row of corpus) {
        corpusUse.set(row.imslp_page_title, (corpusUse.get(row.imslp_page_title) ?? 0) + Number(row.use_count ?? 0));
    }
    return { demand, corpusUse };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 5000;

/** Set by SIGINT / --max-runtime; the loops finish the current file, then stop. */
let stopReason = null;

const installSignalHandlers = () => {
    process.on('SIGINT', () => {
        if (stopReason) {
            info('second SIGINT — exiting now');
            process.exit(130);
        }
        stopReason = 'sigint';
        info('SIGINT — finishing the current file, then stopping (press again to abort)');
    });
    process.on('SIGTERM', () => {
        stopReason = stopReason ?? 'sigterm';
    });
};

const shouldStop = (deadlineMs) => {
    if (!stopReason && deadlineMs && Date.now() >= deadlineMs) {
        stopReason = 'max_runtime';
    }
    return stopReason;
};

/** Heartbeat: ledger counts plus this run's pace and an ETA to the floor. */
const heartbeat = (ledger, { target, batchId, mode, attempted, startedAt }) => {
    const counts = ledgerCounts(ledger);
    const covered = coveredWorkCount(ledger.values());
    const elapsed = (Date.now() - startedAt) / 1000;
    const remaining = Math.max(0, target - covered);
    const perWork = attempted > 0 ? elapsed / attempted : null;
    return progressEvent({
        ...counts,
        target,
        batchId,
        mode,
        covered,
        attempted,
        elapsed_s: Math.round(elapsed),
        eta_s: perWork === null ? null : Math.round(remaining * perWork),
    });
};

/** `--enqueue-fetched`: every `fetched` ledger row → document + job. */
const enqueueFetched = async (ctx, args, startedAt, deadlineMs) => {
    const rows = [...ctx.ledger.values()].filter((row) => row.status === 'fetched');
    info(`enqueue: ${rows.length} fetched ledger rows`);
    let batchId = Math.max(0, ...[...ctx.ledger.values()].map((r) => Number(r.batch_id ?? 0))) + 1;
    let done = 0;
    for (const row of rows) {
        if (shouldStop(deadlineMs)) {
            break;
        }
        if (done > 0 && done % args.batch === 0) {
            console.log(
                heartbeat(ctx.ledger, { target: rows.length, batchId, mode: 'enqueue', attempted: done, startedAt }),
            );
            batchId += 1;
            if (await isPaused(ctx.db)) {
                info('paused between batches — stopping');
                break;
            }
        }
        await enqueueRow(ctx, row);
        done += 1;
    }
    console.log(heartbeat(ctx.ledger, { target: rows.length, batchId, mode: 'enqueue', attempted: done, startedAt }));
    reportNeedsReview(ctx.ledger);
    if (stopReason) {
        info(`stopped (${stopReason}) after ${done}/${rows.length} rows; rerun to continue`);
    }
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.rankOnly
        ? 'rank'
        : args.enqueueFetched
          ? 'enqueue'
          : args.fetchOnly
            ? 'fetch'
            : args.dryRun
              ? 'dry-run'
              : 'seed';
    const needsOwner = mode === 'enqueue' || mode === 'seed';
    const owner = process.env.CORPUS_OWNER_USER_ID ?? null;
    if (needsOwner && !owner) {
        die('CORPUS_OWNER_USER_ID is required (auth.users id of the corpus owner) — or use --fetch-only');
    }

    const startedAt = Date.now();
    const deadlineMs = args.maxRuntimeMs ? startedAt + args.maxRuntimeMs : null;
    installSignalHandlers();

    const supabase = resolveTarget();
    const db = makeDb(supabase);
    const cache = makeCache(args.cacheDir);
    info(`mode ${mode}; target ${supabase.label}; sources ${args.sources.join(',')}`);

    let ledger = new Map();
    let dbReachable = true;
    try {
        ledger = await loadLedger(db);
    } catch (err) {
        if (mode !== 'dry-run' && mode !== 'rank') {
            throw err;
        }
        dbReachable = false;
        info(`ledger unavailable (${err instanceof Error ? err.message : err}); planning against an empty ledger`);
    }

    if (dbReachable) {
        if (await isPaused(db)) {
            info('playalong_corpus_control.paused is true — nothing to do');
            console.log(progressEvent({ ...ledgerCounts(ledger), target: args.limit ?? DEFAULT_LIMIT, mode }));
            return;
        }
        const reconciled = await reconcileLedger(db, ledger);
        if (reconciled > 0) {
            info(`reconciled ${reconciled} queued ledger rows`);
        }
        if (needsOwner) {
            await ensureOwnerPlan(db, owner, { ensure: args.ensureOwnerPlan });
        }
    }

    const ctx = {
        db,
        cache,
        ledger,
        owner,
        sources: args.sources,
        parked: new Set(),
        sourceState: Object.fromEntries(ORIGINS.map((o) => [o, { failures: 0 }])),
        musescore: args.musescore,
        mutopia: [],
        openscore: [],
        zips: new Map(),
        pages: new Map(),
        noEditions: args.noEditions,
        noWiki: args.noWiki,
    };

    if (mode === 'enqueue') {
        await enqueueFetched(ctx, args, startedAt, deadlineMs);
        return;
    }

    if (ctx.sources.includes('mutopia')) {
        ctx.mutopia = await loadMutopiaIndex(cache);
        info(`mutopia index: ${ctx.mutopia.length} pieces`);
    }
    if (ctx.sources.includes('openscore')) {
        ctx.openscore = await loadOpenscoreIndex(cache);
        info(`openscore index: ${ctx.openscore.length} works`);
    }

    // The committed catalog names the tier-1 fill and resolves eval pins that
    // are not popular titles; a missing file only narrows the ranking.
    let catalogWorks = [];
    try {
        catalogWorks = readCatalog(args.catalog, args.sync).works;
        info(`catalog: ${catalogWorks.length} IMSLP works`);
    } catch (err) {
        info(`catalog unavailable (${err instanceof Error ? err.message : err}); ranking popular works only`);
    }

    if (catalogWorks.length > 0) {
        // A popular title IMSLP no longer has under that name cannot be licence-checked
        // (and imslp-work will not resolve it either) — surface it for the curated list.
        const known = new Set(catalogWorks.map((w) => w.page_title));
        const stale = [...new Set(POPULAR_WORKS.map((w) => w.title))].filter((t) => !known.has(t));
        if (stale.length > 0) {
            info(`${stale.length} POPULAR_WORKS titles are not IMSLP page titles in the catalog: ${stale.join(' | ')}`);
        }
    }

    const pins = ctx.mutopia.length > 0 ? await pinWorks(ctx, loadEvalPins(args.evalDir), catalogWorks) : [];
    let demand = new Map();
    let corpusUse = new Map();
    if (args.reRank && dbReachable && owner) {
        ({ demand, corpusUse } = await loadDemand(db, owner));
        info(`demand: ${demand.size} imported titles, ${corpusUse.size} corpus titles`);
    }
    // Hard cap: the ranking is cut at --limit (default 5000); nothing past it is looked at.
    const target = args.limit ?? DEFAULT_LIMIT;
    const candidates = rankWorks({ popular: POPULAR_WORKS, pins, catalog: catalogWorks, demand, corpusUse });
    let popularity = new Map();
    if (!args.noWiki) {
        info(`wikipedia: scoring ${candidates.length} titles (cached after the first run)`);
        const labels = new Map(POPULAR_WORKS.map((w) => [w.title, w.label]));
        popularity = await loadPopularity(
            ctx,
            candidates.map((w) => [w.title, labels.get(w.title) ?? null]),
        );
    }
    const rankedAll = rankWorks({ popular: POPULAR_WORKS, pins, catalog: catalogWorks, demand, corpusUse, popularity });
    const ranked = rankedAll.slice(0, target);
    info(
        `ranked ${rankedAll.length} works (${rankedAll.filter((w) => w.tier === 0).length} tier 0); ` +
            `cap ${target}; ${coveredWorkCount(ledger.values())} already covered`,
    );
    if (mode === 'rank') {
        ranked.forEach((w, index) => {
            console.log(
                JSON.stringify({
                    event: 'corpus_rank',
                    rank: index + 1,
                    title: w.title,
                    tier: w.tier,
                    score: w.score,
                    workViews: w.workViews,
                    composerViews: w.composerViews,
                    downloads: w.downloads,
                    useCount: w.useCount,
                    prior: w.prior,
                    article: popularity.get(w.title)?.article ?? null,
                }),
            );
        });
        return;
    }

    const rowsFor = (title) => [...ledger.values()].filter((row) => row.work_title === title);
    // In fetch mode a `fetched` row is finished; only the default pass takes it further.
    const rowIsOpen = (row) =>
        shouldProcess(row, { retrySkipped: args.retrySkipped }).process &&
        !(mode === 'fetch' && row.status === 'fetched');
    const plans = new Map();
    const maxBatch = Math.max(0, ...[...ledger.values()].map((r) => Number(r.batch_id ?? 0)));
    let batchId = maxBatch + 1;
    let processedInBatch = 0;
    let attempted = 0;

    for (const work of ranked) {
        if (shouldStop(deadlineMs)) {
            break;
        }
        // Dry runs write nothing, so the floor is "works planned" instead.
        if (mode === 'dry-run' ? attempted >= target : coveredWorkCount(ledger.values()) >= target) {
            break;
        }
        const rows = rowsFor(work.title);
        const covered = rows.some((row) => ['queued', 'ready', 'fetched'].includes(row.status));
        const retryable = rows.filter(rowIsOpen);
        if (covered && retryable.length === 0) {
            continue;
        }
        if (rows.length > 0 && retryable.length === 0 && !covered) {
            // Every row skipped / exhausted and no retry requested.
            continue;
        }

        if (processedInBatch >= args.batch) {
            console.log(heartbeat(ledger, { target, batchId, mode, attempted, startedAt }));
            batchId += 1;
            processedInBatch = 0;
            if (dbReachable && (await isPaused(db))) {
                info('paused between batches — stopping');
                return;
            }
        }
        processedInBatch += 1;
        attempted += 1;

        const plan = await resolveWork(ctx, work);
        plans.set(work.title, plan);

        if (mode === 'dry-run') {
            for (const res of plan.queue) {
                console.log(
                    workEvent({
                        workTitle: work.title,
                        status: 'plan',
                        origin: res.origin,
                        filename: res.filename,
                        reason: res.licenceTag,
                    }),
                );
            }
            if (plan.queue.length === 0) {
                const reason = plan.skips.map((s) => `${s.origin}:${s.reason}`).join(',') || 'no_source';
                console.log(workEvent({ workTitle: work.title, status: 'plan_skip', reason }));
            }
        } else {
            for (const skip of plan.skips) {
                await recordSkip(ctx, work, skip, batchId, plan.queue.length === 0 ? plan.edition : null);
            }
            if (plan.queue.length === 0 && plan.skips.length === 0) {
                await recordSkip(
                    ctx,
                    work,
                    { origin: 'none', filename: '-', reason: 'no_source' },
                    batchId,
                    plan.edition,
                );
            }
            for (const res of plan.queue) {
                if (shouldStop(deadlineMs)) {
                    break;
                }
                const existing = ledger.get(
                    ledgerKey({ work_title: res.workTitle, origin: res.origin, filename: res.filename }),
                );
                if (existing && !rowIsOpen(existing)) {
                    continue;
                }
                if (mode === 'fetch') {
                    await fetchFile(ctx, work, res, batchId);
                } else if (existing?.status === 'fetched') {
                    // Already in the store from a --fetch-only pass: no second download.
                    await enqueueRow(ctx, existing);
                } else {
                    await ingestFile(ctx, work, res, batchId);
                }
            }
        }
        if (args.sleepMs > 0 && !stopReason) {
            await sleep(args.sleepMs);
        }
    }

    console.log(heartbeat(ledger, { target, batchId, mode, attempted, startedAt }));
    reportNeedsReview(ledger);
    if (stopReason) {
        info(`stopped (${stopReason}) after ${attempted} works this run; ledger is consistent — rerun to resume`);
    }
    if (mode === 'dry-run') {
        const popularTitles = [...new Set(POPULAR_WORKS.map((w) => w.title))];
        const pinTitles = [...new Set(pins.map((p) => p.title))];
        console.log(
            JSON.stringify({
                event: 'corpus_seed_coverage',
                attempted,
                popular: coverageByOrigin(
                    plans,
                    popularTitles.filter((t) => plans.has(t)),
                ),
                pins: coverageByOrigin(
                    plans,
                    pinTitles.filter((t) => plans.has(t)),
                ),
                parked: [...ctx.parked],
            }),
        );
    }
};

main().catch((err) => die(err instanceof Error ? (err.stack ?? err.message) : String(err)));
