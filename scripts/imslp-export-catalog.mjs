#!/usr/bin/env node
/* global AbortSignal */
/**
 * Walk IMSLP once and write the committed works-mirror catalog.
 *
 * This is the only script that talks to api.php. npm run imslp:seed loads the
 * files this writes. Interrupt and rerun: progress is checkpointed after each
 * category (and after each generator batch of the category in flight).
 *
 * Usage:
 *   npm run imslp:export-catalog
 *   npm run imslp:export-catalog -- --delay 1000
 *   npm run imslp:export-catalog -- --category "C major"
 *
 * Behind an egress proxy set NODE_USE_ENV_PROXY=1.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
    applyPageResult,
    toWorkRow,
    unionCategories,
    walkCategoryBatch,
} from '../supabase/functions/_shared/categorySync.ts';
import { ALL_TAXONOMY_CATEGORIES } from '../supabase/functions/_shared/searchFacetData.ts';
import {
    CATALOG_JSONL_PATH,
    PROGRESS_PATH,
    readCatalog,
    rebuildApplyMigrations,
    taxonomyCategories,
    writeCatalog,
    writeCatalogSql,
} from './imslp-catalog.mjs';

const IMSLP_API = 'https://imslp.org/api.php';
const USER_AGENT =
    'Mozilla/5.0 (compatible; Cleffy/1.0; +https://cleffy.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MW_RETRIES = 3;

const die = (message) => {
    console.error(`imslp-export-catalog: ${message}`);
    process.exit(2);
};

const parseArgs = (argv) => {
    const out = { categories: [], delayMs: 1000, sqlOnly: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--delay') {
            const value = Number(argv[++i]);
            if (!Number.isFinite(value) || value < 0) die('--delay needs a non-negative number of ms');
            out.delayMs = value;
        } else if (arg === '--sql-only') {
            out.sqlOnly = true;
        } else if (arg === '--category') {
            const value = argv[++i];
            if (!value) die('--category needs a value');
            out.categories.push(value);
        } else {
            die(`unknown flag: ${arg}`);
        }
    }
    return out;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mwFetch = async (params) => {
    const url = new URL(IMSLP_API);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    url.searchParams.set('format', 'json');
    let lastError;
    for (let attempt = 1; attempt <= MW_RETRIES; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) {
                if (res.status === 429 && attempt < MW_RETRIES) {
                    const retryAfter = Number(res.headers.get('Retry-After'));
                    const waitMs =
                        Number.isFinite(retryAfter) && retryAfter >= 0
                            ? Math.min(Math.max(retryAfter * 1000, 500), 30_000)
                            : 2000 * attempt;
                    await sleep(waitMs);
                    continue;
                }
                throw new Error(`IMSLP API HTTP ${res.status}`);
            }
            const payload = await res.json();
            if (payload && typeof payload === 'object' && payload.error) {
                throw new Error(payload.error.info ?? 'IMSLP API error');
            }
            return payload;
        } catch (err) {
            lastError = err;
            if (attempt < MW_RETRIES) {
                await sleep(2000 * attempt);
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('IMSLP request failed');
};

const emptyProgress = () => ({
    works: {},
    sync: {},
    inProgress: null,
});

const loadProgress = () => {
    if (!existsSync(PROGRESS_PATH)) {
        return emptyProgress();
    }
    try {
        const raw = JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
        return {
            works: raw.works && typeof raw.works === 'object' ? raw.works : {},
            sync: raw.sync && typeof raw.sync === 'object' ? raw.sync : {},
            inProgress: raw.inProgress ?? null,
        };
    } catch {
        return emptyProgress();
    }
};

const saveProgress = (progress) => {
    mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
    writeFileSync(PROGRESS_PATH, `${JSON.stringify(progress)}\n`);
};

const mergeMember = (works, category, member, seenAt) => {
    const row = toWorkRow(category, member, seenAt);
    const key = String(row.page_id);
    const existing = works[key];
    if (!existing) {
        works[key] = {
            page_id: row.page_id,
            page_title: row.page_title,
            composer: row.composer,
            categories: [...row.categories],
            touched: row.touched,
        };
        return;
    }
    existing.page_title = row.page_title;
    existing.composer = row.composer ?? existing.composer;
    existing.categories = unionCategories(existing.categories, row.categories);
    existing.touched = row.touched ?? existing.touched;
};

const walkCategory = async (category, progress, delayMs) => {
    const resume =
        progress.inProgress && progress.inProgress.category === category
            ? progress.inProgress
            : { category, cursor: null, pagesDone: 0, requests: 0 };
    const plan = {
        category,
        generation: 1,
        cmcontinue: resume.cursor,
        pagesDone: resume.pagesDone,
    };
    let cursor = plan.cmcontinue;
    let pagesDone = plan.pagesDone;
    let requests = resume.requests ?? 0;
    const seenAt = new Date().toISOString();
    for (;;) {
        if (requests > 0) {
            await sleep(delayMs);
        }
        const batch = await walkCategoryBatch(mwFetch, {
            category,
            clcategories: ALL_TAXONOMY_CATEGORIES,
            gcmcontinue: cursor,
            delayMs,
        });
        requests += batch.requests;
        for (const member of batch.members) {
            mergeMember(progress.works, category, member, seenAt);
        }
        const decision = applyPageResult(
            { ...plan, pagesDone, cmcontinue: cursor },
            undefined,
            batch.members,
            batch.gcmcontinue,
            null,
        );
        pagesDone = decision.pagesDone;
        cursor = batch.gcmcontinue;
        process.stderr.write(`\r[imslp-export-catalog] ${category}: ${pagesDone} pages, ${requests} requests`);
        if (decision.kind === 'complete') {
            progress.sync[category] = { pages_done: pagesDone };
            progress.inProgress = null;
            saveProgress(progress);
            process.stderr.write('\n');
            console.log(`[imslp-export-catalog] ${category}: ok, ${pagesDone} pages, ${requests} requests`);
            return;
        }
        progress.inProgress = { category, cursor, pagesDone, requests };
        saveProgress(progress);
    }
};

const publish = (progress) => {
    const generatedAt = new Date().toISOString();
    const works = Object.values(progress.works);
    const categories = Object.entries(progress.sync).map(([category, row]) => ({
        category,
        pages_done: row.pages_done ?? 0,
    }));
    writeCatalog({ works, categories, generatedAt });
    writeCatalogSql({ works, categories, generatedAt });
    rebuildApplyMigrations();
    console.log(
        `[imslp-export-catalog] wrote ${works.length} works, ${categories.length} sync rows → ${CATALOG_JSONL_PATH}`,
    );
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.sqlOnly) {
        const catalog = readCatalog();
        writeCatalogSql(catalog);
        rebuildApplyMigrations();
        console.log(`[imslp-export-catalog] regenerated SQL from ${CATALOG_JSONL_PATH}`);
        return;
    }
    const all = taxonomyCategories();
    const unknown = args.categories.filter((c) => !all.includes(c));
    if (unknown.length > 0) {
        die(`not taxonomy categories: ${unknown.join(', ')}`);
    }
    const wanted = args.categories.length > 0 ? args.categories : all;
    const progress = loadProgress();
    console.log(`[imslp-export-catalog] ${wanted.length} categor${wanted.length === 1 ? 'y' : 'ies'} → ${CATALOG_JSONL_PATH}`);

    let failed = 0;
    for (const category of wanted) {
        if (progress.sync[category] && !(progress.inProgress && progress.inProgress.category === category)) {
            console.log(`[imslp-export-catalog] ${category}: already in checkpoint (${progress.sync[category].pages_done} pages)`);
            continue;
        }
        try {
            await walkCategory(category, progress, args.delayMs);
        } catch (err) {
            failed += 1;
            console.error(
                `[imslp-export-catalog] ${category}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    publish(progress);
    if (failed > 0) {
        console.error(`[imslp-export-catalog] ${failed} categor${failed === 1 ? 'y' : 'ies'} failed; run again to resume`);
        process.exit(1);
    }
    const missing = taxonomyCategories().filter((category) => !progress.sync[category]);
    if (args.categories.length === 0 && missing.length > 0) {
        die(`catalog missing chip categories: ${missing.join(', ')}`);
    }
};

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
