import type { DocumentRow, LibraryTagRow } from '@/types/database';

export type LibrarySort = 'recent' | 'title';

/** IMSLP-style titles end with "(Last, First)" — that suffix is the composer. */
export const composerOf = (title: string): string | null => {
    const match = /\(([^()]+)\)\s*$/.exec(title.trim());
    const composer = match?.[1]?.trim();
    return composer ? composer : null;
};

/** Title without the trailing composer suffix (used when a group header carries it). */
export const displayTitleOf = (title: string): string => {
    const stripped = title.replace(/\s*\([^()]+\)\s*$/, '').trim();
    return stripped || title;
};

export const sortDocuments = (documents: DocumentRow[], sort: LibrarySort): DocumentRow[] => {
    const copy = [...documents];
    if (sort === 'title') {
        copy.sort((a, b) => a.title.localeCompare(b.title));
    } else {
        copy.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    }
    return copy;
};

export interface LibraryGroup {
    /** null = the ungrouped single section. */
    label: string | null;
    documents: DocumentRow[];
}

/** Group by composer parsed from titles; unparseable titles go last as "Other scores". */
export const groupByComposer = (documents: DocumentRow[]): LibraryGroup[] => {
    const byComposer = new Map<string, DocumentRow[]>();
    const other: DocumentRow[] = [];
    for (const doc of documents) {
        const composer = composerOf(doc.title);
        if (!composer) {
            other.push(doc);
            continue;
        }
        const list = byComposer.get(composer) ?? [];
        list.push(doc);
        byComposer.set(composer, list);
    }
    const groups: LibraryGroup[] = [...byComposer.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, docs]) => ({ label, documents: docs }));
    if (other.length > 0) {
        groups.push({ label: 'Other scores', documents: other });
    }
    return groups;
};

/** Keep documents that have the given tag assigned. */
export const filterByTag = (
    documents: DocumentRow[],
    tagId: string,
    assignments: Map<string, string[]>,
): DocumentRow[] => {
    return documents.filter((doc) => assignments.get(doc.id)?.includes(tagId) ?? false);
};

/**
 * Group by user tags. Multi-tagged docs appear under each matching tag.
 * Untagged docs go last as "Untagged". Empty tags (no docs in the filtered set) are omitted.
 */
export const groupByTag = (
    documents: DocumentRow[],
    tags: LibraryTagRow[],
    assignments: Map<string, string[]>,
): LibraryGroup[] => {
    const byTagId = new Map<string, DocumentRow[]>();
    const untagged: DocumentRow[] = [];

    for (const doc of documents) {
        const tagIds = assignments.get(doc.id) ?? [];
        if (tagIds.length === 0) {
            untagged.push(doc);
            continue;
        }
        for (const tagId of tagIds) {
            const list = byTagId.get(tagId) ?? [];
            list.push(doc);
            byTagId.set(tagId, list);
        }
    }

    const groups: LibraryGroup[] = [];
    for (const tag of tags) {
        const docs = byTagId.get(tag.id);
        if (docs && docs.length > 0) {
            groups.push({ label: tag.name, documents: docs });
        }
    }
    if (untagged.length > 0) {
        groups.push({ label: 'Untagged', documents: untagged });
    }
    return groups;
};

export interface LibraryFilters {
    /** Already trimmed and lower-cased. */
    query: string;
    favoritesOnly: boolean;
    favorites: Set<string>;
    tagId: string | null;
    assignments: Map<string, string[]>;
}

/** True when any filter narrows the list (sorting alone does not). */
export const isFiltering = (filters: Pick<LibraryFilters, 'query' | 'favoritesOnly' | 'tagId'>): boolean =>
    filters.query !== '' || filters.favoritesOnly || filters.tagId !== null;

/**
 * The filters the page applies in memory. Over the whole library when every
 * row is loaded; over server results too, where it keeps a score the teacher
 * just unfavorited or untagged from lingering under that filter until the
 * next search.
 */
export const applyLibraryFilters = (documents: DocumentRow[], filters: LibraryFilters): DocumentRow[] => {
    let list = documents
        .filter((doc) => !filters.query || doc.title.toLowerCase().includes(filters.query))
        .filter((doc) => !filters.favoritesOnly || filters.favorites.has(doc.id));
    if (filters.tagId) {
        list = filterByTag(list, filters.tagId, filters.assignments);
    }
    return list;
};

/**
 * Append a fetched page. Ids already held are skipped: a score touched
 * between two "load more" taps can legitimately come back on a later page,
 * and React keys (and the teacher) must never see it twice.
 */
export const appendPage = (current: DocumentRow[], page: DocumentRow[]): DocumentRow[] => {
    const seen = new Set(current.map((doc) => doc.id));
    return [...current, ...page.filter((doc) => !seen.has(doc.id))];
};
