import { describe, expect, it } from 'vitest';

import { composerOf, displayTitleOf, groupByComposer, sortDocuments } from '@/features/library/libraryView';
import type { DocumentRow } from '@/types/database';

const doc = (id: string, title: string, updated_at: string): DocumentRow => ({
    id,
    owner_id: 'u1',
    title,
    storage_path: `${id}/original.pdf`,
    page_count: null,
    created_at: updated_at,
    updated_at,
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
});
