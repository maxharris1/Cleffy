/**
 * Shared PD PDF catalog (pd_pdf_store / pd-pdfs). Used by imslp-work,
 * imslp-search, and imslp-download so a cataloged work opens from Cleffy
 * storage instead of a live IMSLP PDF fetch.
 *
 * Licence filter matches the seed: PD / CC0 / CC-BY / CC-BY-SA only.
 */

export const SERVABLE_LICENCE_TAGS = ['PD', 'CC0', 'CC-BY', 'CC-BY-SA'] as const;
export type ServableLicenceTag = (typeof SERVABLE_LICENCE_TAGS)[number];

export const CATALOG_ORIGINS = ['mutopia', 'openscore', 'ia', 'commons', 'library', 'imslp'] as const;
export type CatalogOrigin = (typeof CATALOG_ORIGINS)[number];

export interface PdPdfStoreRow {
    pdf_sha256: string;
    filename: string;
    work_title: string;
    origin: string;
    source_url: string | null;
    licence_tag: string;
    editor_credit: string | null;
    us_pd: boolean;
    byte_length: number;
    page_count: number | null;
}

export type CatalogLicenseClass = 'pd' | 'cc';

export interface CatalogEdition {
    filename: string;
    size: number | null;
    mime: 'application/pdf';
    openUrl: string;
    license: CatalogLicenseClass;
    licenseLabel: string;
    restriction: null;
    downloadable: true;
    source: 'catalog';
    pdfSha256: string;
    origin: CatalogOrigin;
    editorCredit: string | null;
    sourceUrl: string | null;
    pageCount: number | null;
}

const SERVABLE = new Set<string>(SERVABLE_LICENCE_TAGS);

export const isServableLicence = (tag: string | null | undefined): tag is ServableLicenceTag =>
    typeof tag === 'string' && SERVABLE.has(tag);

export const licenseClassFromTag = (tag: ServableLicenceTag): CatalogLicenseClass =>
    tag === 'PD' || tag === 'CC0' ? 'pd' : 'cc';

export const licenseLabelFromTag = (tag: ServableLicenceTag): string => {
    switch (tag) {
        case 'PD':
            return 'Public domain';
        case 'CC0':
            return 'CC0';
        case 'CC-BY':
            return 'CC-BY';
        case 'CC-BY-SA':
            return 'CC-BY-SA';
        default: {
            const _exhaustive: never = tag;
            return _exhaustive;
        }
    }
};

export const originLabel = (origin: CatalogOrigin): string => {
    switch (origin) {
        case 'mutopia':
            return 'Mutopia';
        case 'openscore':
            return 'OpenScore';
        case 'ia':
            return 'Internet Archive';
        case 'commons':
            return 'Wikimedia Commons';
        case 'library':
            return 'Library';
        case 'imslp':
            return 'IMSLP scan';
        default: {
            const _exhaustive: never = origin;
            return _exhaustive;
        }
    }
};

export const asCatalogOrigin = (origin: string): CatalogOrigin | null => {
    switch (origin) {
        case 'mutopia':
        case 'openscore':
        case 'ia':
        case 'commons':
        case 'library':
        case 'imslp':
            return origin;
        default:
            return null;
    }
};

/**
 * Object key inside `pd-pdfs`. Must match `scripts/seed-playalong-corpus.mjs`
 * (`safeObjectName` + `{sha}/{name}`).
 */
export const safeObjectName = (filename: string): string =>
    filename
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9._()-]/g, '')
        .slice(0, 120) || 'score.pdf';

export const pdObjectPath = (sha: string, filename: string): string => `${sha}/${safeObjectName(filename)}`;

const ORIGIN_SCORE: Record<CatalogOrigin, number> = {
    mutopia: 40,
    openscore: 35,
    ia: 20,
    library: 15,
    commons: 10,
    imslp: 5,
};

const COMPLETE_RE = /(?:^|[-_])(all|complete|vollst)/i;

/** Prefer typeset complete scores, then smaller clean PDFs over huge scans. */
export const catalogRowScore = (row: PdPdfStoreRow, siblingCount: number): number => {
    const origin = asCatalogOrigin(row.origin);
    let score = origin ? ORIGIN_SCORE[origin] : 0;
    const name = row.filename.toLowerCase();
    if (COMPLETE_RE.test(name)) {
        score += 25;
    } else if (siblingCount === 1) {
        score += 10;
    }
    const size = row.byte_length;
    if (size >= 400_000 && size <= 8_000_000) {
        score += 15 - Math.abs(size - 2_000_000) / 1_000_000;
    } else if (size > 8_000_000) {
        score += 4;
    }
    if (/urtext|typeset|-let\.pdf$/i.test(name)) {
        score += 6;
    }
    return score;
};

export const sortCatalogRows = (rows: PdPdfStoreRow[]): PdPdfStoreRow[] => {
    const n = rows.length;
    return [...rows].sort((a, b) => {
        const delta = catalogRowScore(b, n) - catalogRowScore(a, n);
        if (delta !== 0) {
            return delta;
        }
        return a.filename.localeCompare(b.filename);
    });
};

export const storeRowToEdition = (row: PdPdfStoreRow, imslpUrl: string): CatalogEdition | null => {
    if (!isServableLicence(row.licence_tag)) {
        return null;
    }
    const origin = asCatalogOrigin(row.origin);
    if (!origin) {
        return null;
    }
    return {
        filename: row.filename,
        size: row.byte_length,
        mime: 'application/pdf',
        openUrl: imslpUrl,
        license: licenseClassFromTag(row.licence_tag),
        licenseLabel: licenseLabelFromTag(row.licence_tag),
        restriction: null,
        downloadable: true,
        source: 'catalog',
        pdfSha256: row.pdf_sha256,
        origin,
        editorCredit: row.editor_credit,
        sourceUrl: row.source_url,
        pageCount: row.page_count,
    };
};

export const catalogEditionsFromRows = (rows: PdPdfStoreRow[], imslpUrl: string): CatalogEdition[] => {
    const editions: CatalogEdition[] = [];
    for (const row of sortCatalogRows(rows)) {
        const edition = storeRowToEdition(row, imslpUrl);
        if (edition) {
            editions.push(edition);
        }
    }
    return editions;
};

/** Distinct `pdf_sha256` values, preserving first-seen order. */
export const uniquePdfShas = (rows: Array<{ pdf_sha256?: string | null }>): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const sha = row.pdf_sha256?.trim();
        if (!sha || seen.has(sha)) {
            continue;
        }
        seen.add(sha);
        out.push(sha);
    }
    return out;
};

export const mergeStoreRowsBySha = (groups: PdPdfStoreRow[][]): PdPdfStoreRow[] => {
    const map = new Map<string, PdPdfStoreRow>();
    for (const group of groups) {
        for (const row of group) {
            if (row.pdf_sha256) {
                map.set(row.pdf_sha256, row);
            }
        }
    }
    return [...map.values()];
};

/**
 * A work title is in the catalog when `playalong_corpus_seed` is `fetched`
 * for that title and that row’s `pdf_sha256` exists in `pd_pdf_store`.
 * Store `work_title` may differ (first-insert collisions / nicknames).
 */
export const catalogTitlesFromSeedJoin = (
    requestedTitles: string[],
    fetchedSeed: Array<{ work_title: string; pdf_sha256: string | null }>,
    storeShas: Iterable<string>,
): string[] => {
    const wanted = new Set(requestedTitles.map((title) => title.trim()).filter(Boolean));
    const have = new Set(storeShas);
    const present = new Set<string>();
    for (const row of fetchedSeed) {
        const title = row.work_title?.trim();
        const sha = row.pdf_sha256?.trim();
        if (!title || !sha || !wanted.has(title) || !have.has(sha)) {
            continue;
        }
        present.add(title);
    }
    return [...present];
};

export const chunkValues = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
};

/**
 * Pick the store row the download should copy. Prefer an explicit sha, then
 * work+filename, then a unique filename. Never a non-servable licence.
 */
export const matchStoreRow = (
    rows: PdPdfStoreRow[],
    query: { pdfSha256?: string; filename?: string; workTitle?: string },
): PdPdfStoreRow | null => {
    const servable = rows.filter((row) => isServableLicence(row.licence_tag));
    if (servable.length === 0) {
        return null;
    }
    if (query.pdfSha256) {
        return servable.find((row) => row.pdf_sha256 === query.pdfSha256) ?? null;
    }
    const filename = query.filename?.trim();
    const workTitle = query.workTitle?.trim();
    if (filename && workTitle) {
        const both = servable.filter((row) => row.filename === filename && row.work_title === workTitle);
        if (both.length === 1) {
            return both[0] ?? null;
        }
        if (both.length > 1) {
            return sortCatalogRows(both)[0] ?? null;
        }
    }
    if (filename) {
        const byName = servable.filter((row) => row.filename === filename);
        if (byName.length === 1) {
            return byName[0] ?? null;
        }
        if (workTitle) {
            const underWork = byName.filter((row) => row.work_title === workTitle);
            if (underWork.length >= 1) {
                return sortCatalogRows(underWork)[0] ?? null;
            }
        }
        if (byName.length > 1) {
            return sortCatalogRows(byName)[0] ?? null;
        }
    }
    if (workTitle) {
        const underWork = servable.filter((row) => row.work_title === workTitle);
        if (underWork.length >= 1) {
            return sortCatalogRows(underWork)[0] ?? null;
        }
    }
    return null;
};

/** Courtesy line for CC-BY / CC-BY-SA; PD and CC0 stay silent. */
export const catalogAttribution = (edition: {
    license?: string;
    licenseLabel?: string | null;
    editorCredit?: string | null;
    origin?: string | null;
}): string | null => {
    if (edition.license !== 'cc') {
        return null;
    }
    const licence = edition.licenseLabel?.trim() || 'CC';
    const editor = edition.editorCredit?.trim() || 'Unnamed editor';
    const origin = edition.origin ? asCatalogOrigin(edition.origin) : null;
    const source = origin ? originLabel(origin) : null;
    return source ? `Edition by ${editor} (${source}) · ${licence}` : `Edition by ${editor} · ${licence}`;
};
