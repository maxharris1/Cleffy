import { describe, expect, it } from 'vitest';

import {
    appendPage,
    applyLibraryFilters,
    composerOf,
    displayTitleOf,
    filterByTag,
    groupByComposer,
    groupByTag,
    isFiltering,
    sortDocuments,
} from '@/features/library/libraryView';
import type { DocumentRow, LibraryTagRow } from '@/types/database';

const doc = (id: string, title: string, updated_at: string): DocumentRow => ({
    id,
    owner_id: 'u1',
    title,
    storage_path: `${id}/original.pdf`,
    page_count: null,
    content_rev: 0,
    thumb_rev: null,
    created_at: updated_at,
    updated_at,
    archived_at: null,
});

const tag = (id: string, name: string): LibraryTagRow => ({
    id,
    user_id: 'u1',
    name,
    created_at: '2026-08-01T00:00:00Z',
});

describe('libraryView', () => {
    it('parses IMSLP-style composer suffixes', () => {
        expect(composerOf('15 Inventions, BWV 772-786 (Bach, Johann Sebastian)')).toBe('Bach, Johann Sebastian');
        expect(composerOf('An Chloe, K.524 (Mozart, Wolfgang Amadeus)')).toBe('Mozart, Wolfgang Amadeus');
        expect(composerOf('my-scanned-part')).toBeNull();
        expect(composerOf('Sonata (Fantasy) in G (Ives, Charles)')).toBe('Ives, Charles');
    });

    it('strips the composer suffix for grouped display', () => {
        expect(displayTitleOf('An Chloe, K.524 (Mozart, Wolfgang Amadeus)')).toBe('An Chloe, K.524');
        expect(displayTitleOf('my-scanned-part')).toBe('my-scanned-part');
    });

    it('sorts by title or recency', () => {
        const docs = [doc('a', 'Zart (B)', '2026-08-01T00:00:00Z'), doc('b', 'Aria (A)', '2026-08-02T00:00:00Z')];
        expect(sortDocuments(docs, 'title').map((d) => d.id)).toEqual(['b', 'a']);
        expect(sortDocuments(docs, 'recent').map((d) => d.id)).toEqual(['b', 'a']);
        expect(sortDocuments([docs[1] as DocumentRow, docs[0] as DocumentRow], 'recent').map((d) => d.id)).toEqual([
            'b',
            'a',
        ]);
    });

    it('groups by composer with unparseable titles last', () => {
        const groups = groupByComposer([
            doc('1', 'Prelude (Bach, Johann Sebastian)', '2026-08-01T00:00:00Z'),
            doc('2', 'scan.pdf upload', '2026-08-01T00:00:00Z'),
            doc('3', 'An Chloe (Mozart, Wolfgang Amadeus)', '2026-08-01T00:00:00Z'),
            doc('4', 'Invention (Bach, Johann Sebastian)', '2026-08-01T00:00:00Z'),
        ]);
        expect(groups.map((g) => g.label)).toEqual([
            'Bach, Johann Sebastian',
            'Mozart, Wolfgang Amadeus',
            'Other scores',
        ]);
        expect(groups[0]?.documents.map((d) => d.id)).toEqual(['1', '4']);
        expect(groups[2]?.documents.map((d) => d.id)).toEqual(['2']);
    });

    it('filters by tag assignment', () => {
        const docs = [
            doc('1', 'A', '2026-08-01T00:00:00Z'),
            doc('2', 'B', '2026-08-01T00:00:00Z'),
            doc('3', 'C', '2026-08-01T00:00:00Z'),
        ];
        const assignments = new Map([
            ['1', ['t-concert']],
            ['3', ['t-lesson', 't-concert']],
        ]);
        expect(filterByTag(docs, 't-concert', assignments).map((d) => d.id)).toEqual(['1', '3']);
        expect(filterByTag(docs, 't-lesson', assignments).map((d) => d.id)).toEqual(['3']);
        expect(filterByTag(docs, 'missing', assignments)).toEqual([]);
    });

    it('groups by tag with multi-tag docs in each section and untagged last', () => {
        const docs = [
            doc('1', 'Concert piece', '2026-08-01T00:00:00Z'),
            doc('2', 'Untagged scan', '2026-08-01T00:00:00Z'),
            doc('3', 'Lesson and concert', '2026-08-01T00:00:00Z'),
        ];
        const tags = [tag('t-concert', 'Concert'), tag('t-lesson', 'Lesson'), tag('t-empty', 'Empty')];
        const assignments = new Map([
            ['1', ['t-concert']],
            ['3', ['t-lesson', 't-concert']],
        ]);
        const groups = groupByTag(docs, tags, assignments);
        expect(groups.map((g) => g.label)).toEqual(['Concert', 'Lesson', 'Untagged']);
        expect(groups[0]?.documents.map((d) => d.id)).toEqual(['1', '3']);
        expect(groups[1]?.documents.map((d) => d.id)).toEqual(['3']);
        expect(groups[2]?.documents.map((d) => d.id)).toEqual(['2']);
    });
});

describe('applyLibraryFilters', () => {
    const docs = [
        doc('a', 'Prelude in C', '2026-08-02T00:00:00Z'),
        doc('b', 'Gymnopédie', '2026-08-01T00:00:00Z'),
        doc('c', 'Prelude in D', '2026-08-03T00:00:00Z'),
    ];
    const none = {
        query: '',
        favoritesOnly: false,
        favorites: new Set<string>(),
        tagId: null,
        assignments: new Map<string, string[]>(),
    };

    it('narrows by title, favorites and tag together', () => {
        const filtered = applyLibraryFilters(docs, {
            ...none,
            query: 'prelude',
            favoritesOnly: true,
            favorites: new Set(['a', 'c']),
            tagId: 't1',
            assignments: new Map([['c', ['t1']]]),
        });
        expect(filtered.map((d) => d.id)).toEqual(['c']);
    });

    it('keeps the given order (server results are already ordered)', () => {
        expect(applyLibraryFilters(docs, none).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });

    it('treats only real filters as filtering', () => {
        expect(isFiltering(none)).toBe(false);
        expect(isFiltering({ ...none, query: 'x' })).toBe(true);
        expect(isFiltering({ ...none, tagId: 't' })).toBe(true);
        expect(isFiltering({ ...none, favoritesOnly: true })).toBe(true);
    });
});

describe('appendPage', () => {
    it('appends in order and skips ids already held', () => {
        const a = doc('a', 'A', '2026-08-03T00:00:00Z');
        const b = doc('b', 'B', '2026-08-02T00:00:00Z');
        const c = doc('c', 'C', '2026-08-01T00:00:00Z');
        expect(appendPage([a, b], [b, c]).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });
});
