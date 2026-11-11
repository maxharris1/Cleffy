export type CatalogWork = {
    page_id: number;
    page_title: string;
    composer: string | null;
    categories: string[];
    touched: string | null;
};

export type CatalogSyncRow = {
    category: string;
    pages_done: number;
};

export const CATALOG_JSONL_PATH: string;
export const SYNC_JSON_PATH: string;

export function taxonomyCategories(): string[];
export function parseWorkLine(line: string): CatalogWork;
export function readCatalog(
    jsonlPath?: string,
    syncPath?: string,
): { works: CatalogWork[]; generatedAt: string; categories: CatalogSyncRow[] };
export function writeCatalog(
    catalog: { works: CatalogWork[]; categories: CatalogSyncRow[]; generatedAt?: string },
    opts?: { jsonlPath?: string; syncPath?: string },
): void;
export function catalogSqlParts(
    catalog: { works: CatalogWork[]; categories: CatalogSyncRow[]; generatedAt?: string },
    maxBytes?: number,
): string[];
export function catalogToSql(
    catalog: { works: CatalogWork[]; categories: CatalogSyncRow[]; generatedAt?: string },
    maxBytes?: number,
): string;
export function writeCatalogSql(
    catalog: { works: CatalogWork[]; categories: CatalogSyncRow[]; generatedAt?: string },
    opts?: { migrationsDir?: string; maxBytes?: number },
): string[];
export function catalogCoversTaxonomy(catalog: { categories: CatalogSyncRow[] }): { missing: string[] };
export function catalogWorkRows(works: CatalogWork[], seenAt: string): Array<CatalogWork & { seen_at: string }>;
export function catalogSyncRows(
    categories: CatalogSyncRow[],
    seenAt: string,
): Array<{
    category: string;
    state: 'ok';
    active_generation: number;
    building_generation: number;
    cmcontinue: null;
    pages_done: number;
    last_error: null;
    completed_at: string;
    updated_at: string;
    building_started_at: null;
}>;
