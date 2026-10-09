import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CATALOG_JSONL_PATH,
    SYNC_JSON_PATH,
    catalogCoversTaxonomy,
    catalogSqlParts,
    catalogSyncRows,
    catalogToSql,
    catalogWorkRows,
    parseWorkLine,
    readCatalog,
    taxonomyCategories,
    writeCatalog,
    writeCatalogSql,
} from '../../scripts/imslp-catalog.mjs';
import { ALL_TAXONOMY_CATEGORIES, KEY_FACETS } from '../../supabase/functions/_shared/searchFacetData';

const goldberg = {
    page_id: 1,
    page_title: 'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
    composer: 'Bach, Johann Sebastian',
    categories: ['For piano', 'Baroque', 'G major', 'Bach, Johann Sebastian'],
    touched: '2010-01-01T00:00:00Z',
};

const fixtureCatalog = () => ({
    generatedAt: '2026-09-10T00:00:00.000Z',
    works: [goldberg],
    categories: taxonomyCategories().map((category) => ({
        category,
        pages_done: category === 'For piano' ? 12 : 1,
    })),
});

describe('imslp catalog file', () => {
    it('parses a work line', () => {
        expect(parseWorkLine(JSON.stringify(goldberg))).toEqual(goldberg);
    });

    it('round-trips jsonl + sync and SQL-inserts every chip including keys', () => {
        const dir = mkdtempSync(join(tmpdir(), 'imslp-catalog-'));
        const jsonlPath = join(dir, 'imslp-works-catalog.jsonl');
        const syncPath = join(dir, 'imslp-works-sync.json');
        const catalog = fixtureCatalog();
        writeCatalog(catalog, { jsonlPath, syncPath });
        const loaded = readCatalog(jsonlPath, syncPath);
        expect(loaded.works).toEqual(catalog.works);
        expect(catalogCoversTaxonomy(loaded).missing).toEqual([]);
        for (const key of KEY_FACETS) {
            expect(loaded.categories.map((row) => row.category)).toContain(key.category);
        }
        for (const category of ALL_TAXONOMY_CATEGORIES) {
            expect(taxonomyCategories()).toContain(category);
        }

        const sql = catalogToSql(catalog);
        expect(sql).toMatch(/insert into public\.imslp_works/i);
        expect(sql).toMatch(/Goldberg Variations/);
        expect(sql).toMatch(/ARRAY\[.*For piano/);
        expect(sql).toMatch(/'G major'/);
        expect(sql).toMatch(/'C-sharp minor'/);
        expect(sql.indexOf('insert into public.imslp_works')).toBeLessThan(
            sql.indexOf('drop table if exists public.imslp_category_members'),
        );
        expect(sql).toMatch(/delete from public\.imslp_category_sync/);
        const syncRows = catalogSyncRows(catalog.categories, catalog.generatedAt);
        expect(syncRows).toHaveLength(taxonomyCategories().length);
        expect(catalogWorkRows(catalog.works, catalog.generatedAt)[0]?.seen_at).toBe(catalog.generatedAt);
    });

    it('round-trips gzip jsonl', () => {
        const dir = mkdtempSync(join(tmpdir(), 'imslp-catalog-gz-'));
        const jsonlPath = join(dir, 'imslp-works-catalog.jsonl.gz');
        const syncPath = join(dir, 'imslp-works-sync.json');
        const catalog = fixtureCatalog();
        writeCatalog(catalog, { jsonlPath, syncPath });
        expect(readCatalog(jsonlPath, syncPath).works).toEqual(catalog.works);
    });

    it('splits catalog SQL under the byte cap and drops members only on the last file', () => {
        const catalog = {
            generatedAt: '2026-09-10T00:00:00.000Z',
            works: Array.from({ length: 30 }, (_, i) => ({
                ...goldberg,
                page_id: i + 1,
                page_title: `${goldberg.page_title} ${i}`,
            })),
            categories: [{ category: 'For piano', pages_done: 30 }],
        };
        const parts = catalogSqlParts(catalog, 2500);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts[0]).toMatch(/truncate public\.imslp_works/);
        expect(parts.slice(1).join('')).not.toMatch(/truncate public\.imslp_works/);
        expect(parts.slice(0, -1).join('')).not.toMatch(/drop table if exists public\.imslp_category_members/);
        expect(parts.at(-1)).toMatch(/drop table if exists public\.imslp_category_members/);
        expect(parts.at(-1)).toMatch(/delete from public\.imslp_category_sync/);

        const dir = mkdtempSync(join(tmpdir(), 'imslp-catalog-sql-'));
        const names = writeCatalogSql(catalog, { migrationsDir: dir, maxBytes: 2500 });
        expect(names.length).toBe(parts.length);
        const first = names[0];
        expect(first).toBe('20260910160000_imslp_works_catalog.sql');
        expect(first && existsSync(join(dir, first))).toBe(true);
    });
});

describe('committed catalog', () => {
    it('lists every KEY_FACETS and ALL_TAXONOMY name in the sync sidecar', () => {
        expect(existsSync(SYNC_JSON_PATH)).toBe(true);
        expect(existsSync(CATALOG_JSONL_PATH)).toBe(true);
        expect(statSync(CATALOG_JSONL_PATH).size).toBeGreaterThan(100_000);

        const sync = JSON.parse(readFileSync(SYNC_JSON_PATH, 'utf8')) as {
            categories: Array<{ category: string; pages_done: number }>;
        };
        expect(catalogCoversTaxonomy(sync).missing).toEqual([]);
        const names = sync.categories.map((row) => row.category);
        for (const key of KEY_FACETS) {
            expect(names).toContain(key.category);
        }
        for (const category of ALL_TAXONOMY_CATEGORIES) {
            expect(names).toContain(category);
        }
        const piano = sync.categories.find((row) => row.category === 'For piano');
        expect(piano?.pages_done ?? 0).toBeGreaterThan(100);
    });
});
