/**
 * Catalog hit by IMSLP work title: seed `fetched` + sha in `pd_pdf_store`.
 * Exact `pd_pdf_store.work_title` is still accepted so a store-only row hits.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
    SERVABLE_LICENCE_TAGS,
    catalogTitlesFromSeedJoin,
    chunkValues,
    mergeStoreRowsBySha,
    uniquePdfShas,
    type PdPdfStoreRow,
} from './pdPdfCatalog.ts';

export const STORE_ROW_SELECT =
    'pdf_sha256, filename, work_title, origin, source_url, licence_tag, editor_credit, us_pd, byte_length, page_count';

const SHA_IN_CHUNK = 80;

const servableTags = (): string[] => [...SERVABLE_LICENCE_TAGS];

const storeRowsByShas = async (admin: SupabaseClient, shas: string[]): Promise<PdPdfStoreRow[]> => {
    if (shas.length === 0) {
        return [];
    }
    const rows: PdPdfStoreRow[] = [];
    for (const chunk of chunkValues(shas, SHA_IN_CHUNK)) {
        const { data, error } = await admin
            .from('pd_pdf_store')
            .select(STORE_ROW_SELECT)
            .in('pdf_sha256', chunk)
            .in('licence_tag', servableTags());
        if (error || !Array.isArray(data)) {
            continue;
        }
        rows.push(...(data as PdPdfStoreRow[]));
    }
    return rows;
};

export const loadStoreRowsForCatalogTitle = async (
    admin: SupabaseClient,
    title: string,
): Promise<PdPdfStoreRow[]> => {
    const workTitle = title.trim();
    if (!workTitle) {
        return [];
    }
    const [{ data: titled }, { data: seed }] = await Promise.all([
        admin
            .from('pd_pdf_store')
            .select(STORE_ROW_SELECT)
            .eq('work_title', workTitle)
            .in('licence_tag', servableTags()),
        admin
            .from('playalong_corpus_seed')
            .select('pdf_sha256')
            .eq('work_title', workTitle)
            .eq('status', 'fetched')
            .not('pdf_sha256', 'is', null),
    ]);
    const shas = uniquePdfShas((seed ?? []) as Array<{ pdf_sha256: string | null }>);
    const bySha = await storeRowsByShas(admin, shas);
    return mergeStoreRowsBySha([(titled ?? []) as PdPdfStoreRow[], bySha]);
};

export const catalogTitlesInStore = async (admin: SupabaseClient, titles: string[]): Promise<string[]> => {
    const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))].slice(0, 300);
    if (unique.length === 0) {
        return [];
    }
    const [{ data: storeTitles }, { data: seedRows }] = await Promise.all([
        admin.from('pd_pdf_store').select('work_title').in('work_title', unique).in('licence_tag', servableTags()),
        admin
            .from('playalong_corpus_seed')
            .select('work_title, pdf_sha256')
            .in('work_title', unique)
            .eq('status', 'fetched')
            .not('pdf_sha256', 'is', null),
    ]);
    const exact = [
        ...new Set(
            (storeTitles ?? [])
                .map((row) => (row as { work_title?: string }).work_title)
                .filter((t): t is string => Boolean(t)),
        ),
    ];
    const seed = (seedRows ?? []) as Array<{ work_title: string; pdf_sha256: string | null }>;
    const shas = uniquePdfShas(seed);
    if (shas.length === 0) {
        return exact;
    }
    const storeBySha = await storeRowsByShas(admin, shas);
    const joined = catalogTitlesFromSeedJoin(
        unique,
        seed,
        storeBySha.map((row) => row.pdf_sha256),
    );
    return [...new Set([...exact, ...joined])];
};
