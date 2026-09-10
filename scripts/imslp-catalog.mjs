#!/usr/bin/env node
/**
 * IMSLP works-mirror catalog: the committed chip index and the SQL COPY
 * generated from it. Seed and db push both load this; only export-catalog
 * talks to MediaWiki.
 *
 * Format:
 *   scripts/data/imslp-works-catalog.jsonl.gz  — one work object per line (gzip)
 *   scripts/data/imslp-works-sync.json         — ok rows for every chip category
 *
 * Shared modules are TypeScript; Node loads this with --experimental-strip-types
 * when a caller imports searchFacetData.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
    ALL_TAXONOMY_CATEGORIES,
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_BY_ID,
    INSTRUMENT_FACETS,
    KEY_FACETS,
} from '../supabase/functions/_shared/searchFacetData.ts';
import { categoriesToSync } from '../supabase/functions/_shared/categorySync.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = resolve(ROOT, 'scripts/data');
export const CATALOG_JSONL_PATH = resolve(DATA_DIR, 'imslp-works-catalog.jsonl.gz');
export const SYNC_JSON_PATH = resolve(DATA_DIR, 'imslp-works-sync.json');
export const CATALOG_SQL_STAMP = 20260910160000;
export const CATALOG_SQL_STEM = 'imslp_works_catalog';
export const CATALOG_SQL_PATH = resolve(ROOT, `supabase/migrations/${CATALOG_SQL_STAMP}_${CATALOG_SQL_STEM}.sql`);
export const PROGRESS_PATH = resolve(DATA_DIR, '.imslp-export-progress.json');
export const APPLY_MIGRATIONS_PATH = resolve(ROOT, 'scripts/apply-migrations.sql');
export const MIGRATIONS_DIR = resolve(ROOT, 'supabase/migrations');

export const SQL_INSERT_CHUNK = 200;
/** Split generated catalog SQL so no single migration exceeds GitHub / editor limits. */
export const SQL_FILE_MAX_BYTES = 40 * 1024 * 1024;

export const catalogSqlFileName = (index) => `${String(CATALOG_SQL_STAMP + index)}_${CATALOG_SQL_STEM}.sql`;

const isCatalogSqlName = (name) => /^\d+_imslp_works_catalog\.sql$/.test(name);

export const listCatalogSqlNames = (migrationsDir = MIGRATIONS_DIR) =>
    (existsSync(migrationsDir) ? readdirSync(migrationsDir) : []).filter(isCatalogSqlName).sort();

const readTextMaybeGzip = (path) => {
    const buf = readFileSync(path);
    if (path.endsWith('.gz') || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
        return gunzipSync(buf).toString('utf8');
    }
    return buf.toString('utf8');
};

const writeTextMaybeGzip = (path, text) => {
    if (path.endsWith('.gz')) {
        writeFileSync(path, gzipSync(Buffer.from(text, 'utf8')));
        return;
    }
    writeFileSync(path, text);
};

export const taxonomyCategories = () =>
    categoriesToSync(
        COMPOSER_FACETS,
        INSTRUMENT_FACETS,
        FORM_FACETS,
        ERA_FACETS,
        KEY_FACETS,
        INSTRUMENT_BY_ID['piano']?.category,
    );

export const allTaxonomyCategorySet = () => new Set(ALL_TAXONOMY_CATEGORIES);

/** @typedef {{ page_id: number, page_title: string, composer: string | null, categories: string[], touched: string | null }} CatalogWork */
/** @typedef {{ category: string, pages_done: number }} CatalogSyncRow */
/** @typedef {{ generatedAt: string, categories: CatalogSyncRow[] }} CatalogSyncFile */

export const parseWorkLine = (line) => {
    const raw = JSON.parse(line);
    if (typeof raw.page_id !== 'number' || raw.page_id <= 0 || typeof raw.page_title !== 'string') {
        throw new Error('catalog work line needs page_id and page_title');
    }
    return {
        page_id: raw.page_id,
        page_title: raw.page_title,
        composer: typeof raw.composer === 'string' && raw.composer.length > 0 ? raw.composer : null,
        categories: Array.isArray(raw.categories) ? raw.categories.filter((c) => typeof c === 'string' && c.length > 0) : [],
        touched: typeof raw.touched === 'string' && raw.touched.length > 0 ? raw.touched : null,
    };
};

export const readCatalog = (jsonlPath = CATALOG_JSONL_PATH, syncPath = SYNC_JSON_PATH) => {
    if (!existsSync(jsonlPath) || !existsSync(syncPath)) {
        throw new Error(`catalog files missing — run npm run imslp:export-catalog (${jsonlPath})`);
    }
    const works = [];
    const jsonl = readTextMaybeGzip(jsonlPath);
    for (const line of jsonl.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        works.push(parseWorkLine(trimmed));
    }
    const sync = JSON.parse(readFileSync(syncPath, 'utf8'));
    if (!sync || !Array.isArray(sync.categories)) {
        throw new Error('imslp-works-sync.json needs a categories array');
    }
    return {
        works,
        generatedAt: typeof sync.generatedAt === 'string' ? sync.generatedAt : new Date().toISOString(),
        categories: sync.categories.map((row) => ({
            category: String(row.category),
            pages_done: Number(row.pages_done) || 0,
        })),
    };
};

export const writeCatalog = ({ works, categories, generatedAt }, { jsonlPath = CATALOG_JSONL_PATH, syncPath = SYNC_JSON_PATH } = {}) => {
    mkdirSync(dirname(jsonlPath), { recursive: true });
    const sorted = [...works].sort((a, b) => a.page_id - b.page_id);
    const lines = sorted.map((work) =>
        JSON.stringify({
            page_id: work.page_id,
            page_title: work.page_title,
            composer: work.composer,
            categories: work.categories,
            touched: work.touched,
        }),
    );
    writeTextMaybeGzip(jsonlPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    const syncFile = {
        generatedAt: generatedAt ?? new Date().toISOString(),
        categories: [...categories].sort((a, b) => a.category.localeCompare(b.category)),
    };
    writeFileSync(syncPath, `${JSON.stringify(syncFile, null, 2)}\n`);
};

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const sqlTimestamp = (value) => (value ? `${sqlString(value)}::timestamptz` : 'null');

const sqlTextArray = (values) => {
    if (values.length === 0) {
        return `'{}'::text[]`;
    }
    return `ARRAY[${values.map(sqlString).join(', ')}]::text[]`;
};

const workValueTuple = (work, seenAt) =>
    `(${work.page_id}, ${sqlString(work.page_title)}, ${work.composer ? sqlString(work.composer) : 'null'}, ${sqlTextArray(work.categories)}, ${sqlTimestamp(work.touched)}, ${sqlTimestamp(seenAt)})`;

const sqlFileHeader = (continued) =>
    continued
        ? [
              '-- IMSLP works-mirror catalog (continued) — generated by scripts/imslp-export-catalog.mjs.',
              '-- Do not edit by hand. Regenerate with: npm run imslp:export-catalog',
              '',
          ].join('\n')
        : [
              '-- IMSLP works-mirror catalog — generated by scripts/imslp-export-catalog.mjs.',
              '-- Do not edit by hand. Regenerate with: npm run imslp:export-catalog',
              '--',
              '-- Loads the committed chip index (instruments, eras, forms, keys, composers)',
              '-- then drops the old per-category members table. COPY is avoided so hosted',
              '-- db push / SQL editor can apply this without the COPY protocol.',
              '',
              'truncate public.imslp_works;',
              '',
          ].join('\n');

const insertChunkSql = (works, seenAt) =>
    'insert into public.imslp_works (page_id, page_title, composer, categories, touched, seen_at) values\n' +
    works.map((work) => `    ${workValueTuple(work, seenAt)}`).join(',\n') +
    ';\n\n';

const catalogFooterSql = (categories, seenAt) => {
    const lines = ['delete from public.imslp_category_sync;'];
    if (categories.length > 0) {
        lines.push(
            'insert into public.imslp_category_sync (category, state, active_generation, building_generation, cmcontinue, pages_done, last_error, completed_at, updated_at, building_started_at) values',
        );
        const tuples = categories.map(
            (row) =>
                `    (${sqlString(row.category)}, 'ok', 1, 1, null, ${Number(row.pages_done) || 0}, null, ${sqlTimestamp(seenAt)}, ${sqlTimestamp(seenAt)}, null)`,
        );
        lines.push(tuples.join(',\n') + ';');
        lines.push('');
    }
    lines.push('drop table if exists public.imslp_category_members;');
    lines.push('');
    return `${lines.join('\n')}`;
};

const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Split catalog SQL so each file stays under maxBytes. TRUNCATE is only on
 * the first file; sync replace + DROP members only on the last. If a later
 * file fails to apply, imslp_category_members remains.
 */
export const catalogSqlParts = ({ works, categories, generatedAt }, maxBytes = SQL_FILE_MAX_BYTES) => {
    const seenAt = generatedAt ?? new Date().toISOString();
    const chunks = [];
    if (works.length === 0) {
        chunks.push('-- catalog is empty\n\n');
    } else {
        for (let i = 0; i < works.length; i += SQL_INSERT_CHUNK) {
            chunks.push(insertChunkSql(works.slice(i, i + SQL_INSERT_CHUNK), seenAt));
        }
    }
    const footer = catalogFooterSql(categories, seenAt);
    const firstHeader = sqlFileHeader(false);
    const continuedHeader = sqlFileHeader(true);
    const isBareHeader = (text) => text === firstHeader || text === continuedHeader;

    const parts = [];
    let buf = firstHeader;
    const flushIfNeeded = (next) => {
        if (utf8Bytes(buf + next) > maxBytes && !isBareHeader(buf)) {
            parts.push(buf);
            buf = continuedHeader;
        }
    };
    for (const chunk of chunks) {
        flushIfNeeded(chunk);
        buf += chunk;
    }
    flushIfNeeded(footer);
    buf += footer;
    parts.push(buf);
    return parts;
};

export const catalogToSql = (catalog, maxBytes = SQL_FILE_MAX_BYTES) => catalogSqlParts(catalog, maxBytes).join('');

export const writeCatalogSql = (catalog, { migrationsDir = MIGRATIONS_DIR, maxBytes = SQL_FILE_MAX_BYTES } = {}) => {
    mkdirSync(migrationsDir, { recursive: true });
    for (const name of listCatalogSqlNames(migrationsDir)) {
        unlinkSync(resolve(migrationsDir, name));
    }
    const names = catalogSqlParts(catalog, maxBytes).map((sql, index) => {
        const name = catalogSqlFileName(index);
        const body = sql.endsWith('\n') ? sql : `${sql}\n`;
        writeFileSync(resolve(migrationsDir, name), body);
        return name;
    });
    return names;
};

export const rebuildApplyMigrations = () => {
    const files = existsSync(MIGRATIONS_DIR)
        ? [...readdirSync(MIGRATIONS_DIR)]
              .filter((name) => name.endsWith('.sql') && !isCatalogSqlName(name))
              .sort()
        : [];
    const parts = [
        '-- Combined migrations for the Supabase SQL editor (generated from supabase/migrations/*.sql)',
        '',
        '-- Paste and run this whole file once in: Dashboard → SQL Editor → New query',
        '-- Catalog inserts (*_imslp_works_catalog.sql) are omitted: they exceed the SQL editor',
        '-- paste limit. Apply those with `npx supabase db push` or `psql -f`.',
        '',
    ];
    for (const name of files) {
        const body = readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8').replace(/\s+$/, '');
        parts.push(`-- ===== supabase/migrations/${name} =====`);
        parts.push(body);
        parts.push('');
    }
    writeFileSync(APPLY_MIGRATIONS_PATH, `${parts.join('\n').replace(/\s+$/, '')}\n`);
};

export const catalogCoversTaxonomy = (catalog) => {
    const named = new Set(catalog.categories.map((row) => row.category));
    const missing = taxonomyCategories().filter((category) => !named.has(category));
    return { missing };
};

export const catalogWorkRows = (works, seenAt) =>
    works.map((work) => ({
        page_id: work.page_id,
        page_title: work.page_title,
        composer: work.composer,
        categories: work.categories,
        touched: work.touched,
        seen_at: seenAt,
    }));

export const catalogSyncRows = (categories, seenAt) => {
    const wanted = new Set(taxonomyCategories());
    return categories
        .filter((row) => wanted.has(row.category))
        .map((row) => ({
            category: row.category,
            state: 'ok',
            active_generation: 1,
            building_generation: 1,
            cmcontinue: null,
            pages_done: row.pages_done,
            last_error: null,
            completed_at: seenAt,
            updated_at: seenAt,
            building_started_at: null,
        }));
};
