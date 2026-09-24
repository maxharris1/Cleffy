#!/usr/bin/env node
/**
 * Refresh tests/imslp/fixtures/popular-titles.json: for every POPULAR_WORKS
 * title, whether IMSLP has a work page under exactly that title today, and
 * where it redirects if not. `tests/imslp/popularTitles.test.ts` reads the
 * fixture so a renamed IMSLP page fails the build instead of silently breaking
 * `imslp-work`, the corpus seed's licence lookup, and the demand prior.
 *
 * Metadata only: a handful of batched `action=query&redirects=1` calls on
 * api.php, spaced by the robots.txt crawl delay.
 *
 * Usage: node --experimental-strip-types scripts/imslp-popular-titles-fixture.mjs
 */

/* global AbortSignal */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POPULAR_WORKS } from '../supabase/functions/_shared/popularWorks.ts';
import { IMSLP_API, IMSLP_CRAWL_DELAY_MS } from './playalong-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_PATH = resolve(ROOT, 'tests/imslp/fixtures/popular-titles.json');
const USER_AGENT = 'Cleffy corpus seed (+https://cleffy.app; metadata only)';
const BATCH = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const queryTitles = async (titles) => {
    const url = new URL(IMSLP_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('redirects', '1');
    url.searchParams.set('format', 'json');
    url.searchParams.set('titles', titles.join('|'));
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (err) {
            if (attempt >= 4) {
                throw err;
            }
            await sleep(3000 * attempt);
        }
    }
};

/** One fixture entry per title from a batched query response. */
export const fixtureEntries = (titles, response) => {
    const redirects = new Map((response.query?.redirects ?? []).map((r) => [r.from, r.to]));
    const normalized = new Map((response.query?.normalized ?? []).map((r) => [r.from, r.to]));
    const pages = Object.values(response.query?.pages ?? {});
    const out = {};
    for (const title of titles) {
        const current = redirects.get(normalized.get(title) ?? title) ?? normalized.get(title) ?? title;
        const page = pages.find((p) => p.title === current);
        const exists = Boolean(page) && !('missing' in page);
        out[title] = { exists, resolvedTo: exists ? current : null };
    }
    return out;
};

const main = async () => {
    const titles = [...new Set(POPULAR_WORKS.map((w) => w.title))];
    const entries = {};
    for (let i = 0; i < titles.length; i += BATCH) {
        const chunk = titles.slice(i, i + BATCH);
        Object.assign(entries, fixtureEntries(chunk, await queryTitles(chunk)));
        if (i + BATCH < titles.length) {
            await sleep(IMSLP_CRAWL_DELAY_MS);
        }
    }
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(
        FIXTURE_PATH,
        `${JSON.stringify({ checkedAt: new Date().toISOString(), titles: entries }, null, 4)}\n`,
    );
    const stale = Object.entries(entries).filter(([title, e]) => !e.exists || e.resolvedTo !== title);
    console.log(`[popular-titles] ${titles.length} titles checked, ${stale.length} stale → ${FIXTURE_PATH}`);
    for (const [title, e] of stale) {
        console.log(`  ${title} → ${e.exists ? e.resolvedTo : 'missing'}`);
    }
    process.exit(stale.length > 0 ? 1 : 0);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error(`imslp-popular-titles-fixture: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
    });
}
