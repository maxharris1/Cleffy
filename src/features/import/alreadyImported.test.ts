import { describe, expect, it } from 'vitest';

import { dropAlreadyImported } from '@/features/import/alreadyImported';
import { buildProposals } from '@/features/import/proposals';
import { segmentPage } from '@/features/import/segmentation';
import type { ImportProposal, PageProposal, ProposedItem } from '@/features/import/importTypes';
import { INK_BLUE, INK_RED, makeRaster, paintRect } from '@/test/rasterFixtures';
import type { Annotation } from '@/types/models';

const DOC = 'doc-1';

/** A real scan of one page: three blue digits and a red mark, strokes only. */
const scanPage = (pageIndex = 0): PageProposal => {
    const raster = makeRaster(512, 256);
    paintRect(raster, 100, 30, 10, 14, INK_BLUE);
    paintRect(raster, 118, 30, 10, 14, INK_BLUE);
    paintRect(raster, 136, 30, 10, 14, INK_BLUE);
    paintRect(raster, 60, 120, 4, 40, INK_RED);
    const segmentation = segmentPage(raster, pageIndex);
    return {
        pageIndex,
        rasterWidth: segmentation.width,
        rasterHeight: segmentation.height,
        items: buildProposals(DOC, segmentation, null),
        segmentation,
        stripSubtypes: [],
    };
};

const proposalOf = (pages: PageProposal[]): ImportProposal => ({
    docId: DOC,
    pages,
    aiDegraded: false,
    unreadablePages: [],
    tooColorfulPages: [],
});

/** What applyProposals leaves in the store: the proposed annotations, now saved. */
const imported = (items: ProposedItem[]): Annotation[] =>
    items.flatMap((item) => item.annotations.map((a) => ({ ...a, id: `saved-${a.id}`, seq: 7 })));

const textItem = (id: string, x: number, y: number, text: string): ProposedItem => ({
    id,
    pageIndex: 0,
    clusterIds: [id],
    annotations: [
        {
            id: `a-${id}`,
            docId: DOC,
            page: 0,
            kind: 'text',
            color: '#2563eb',
            payload: { x, y, text, size: 0.02, src: 1 },
            createdBy: null,
            createdAt: '2026-10-10T00:00:00Z',
            updatedAt: '2026-10-10T00:00:00Z',
            deletedAt: null,
            seq: 0,
        },
    ],
    label: `“${text}”`,
    isText: true,
    confidence: 'high',
});

describe('dropAlreadyImported', () => {
    it('leaves out every mark when the same page is scanned a second time', () => {
        const first = scanPage();
        expect(first.items.length).toBe(4);
        const existing = imported(first.items);

        // A second run: same ink, fresh proposal ids.
        const second = proposalOf([scanPage()]);
        const { proposal, skipped } = dropAlreadyImported(second, existing);

        expect(skipped).toHaveLength(4);
        expect(proposal.pages).toHaveLength(0);
    });

    it('keeps what is new and drops only what was imported', () => {
        const first = scanPage();
        // Only the red mark was imported last time.
        const red = first.items.filter((item) => item.annotations[0]?.color === '#dc2626');
        expect(red).toHaveLength(1);

        const { proposal, skipped } = dropAlreadyImported(proposalOf([scanPage()]), imported(red));

        expect(skipped).toHaveLength(1);
        expect(proposal.pages[0]?.items).toHaveLength(3);
        expect(proposal.pages[0]?.items.every((item) => item.annotations[0]?.color === '#2563eb')).toBe(true);
    });

    it('offers a mark again once its imported copy was erased', () => {
        const first = scanPage();
        const existing = imported(first.items).map((a, i) =>
            i === 0 ? { ...a, deletedAt: '2026-10-10T01:00:00Z' } : a,
        );

        const { proposal, skipped } = dropAlreadyImported(proposalOf([scanPage()]), existing);

        expect(skipped).toHaveLength(3);
        expect(proposal.pages[0]?.items).toHaveLength(1);
    });

    it('still recognises an imported mark the teacher recoloured or reworded', () => {
        const before = textItem('t1', 0.3, 0.2, '3');
        const existing = imported([before]).map((a) => ({
            ...a,
            color: '#1f2937',
            payload: { ...a.payload, text: '8' },
        }));

        const { skipped } = dropAlreadyImported(
            proposalOf([{ ...scanPage(), items: [textItem('t2', 0.3, 0.2, '3')] }]),
            existing,
        );

        expect(skipped).toHaveLength(1);
    });

    it('ignores marks drawn in Cleffy, marks on other pages, and other scores', () => {
        const first = scanPage();
        const drawnHere = imported(first.items).map((a) => {
            const { src: _src, ...payload } = a.payload as { src?: 1 };
            return { ...a, payload: payload as Annotation['payload'] };
        });
        const otherPage = imported(first.items).map((a) => ({ ...a, page: 3 }));
        const otherScore = imported(first.items).map((a) => ({ ...a, docId: 'doc-2' }));

        const scan = proposalOf([scanPage()]);
        const { proposal, skipped } = dropAlreadyImported(scan, [...drawnHere, ...otherPage, ...otherScore]);

        expect(skipped).toHaveLength(0);
        expect(proposal).toBe(scan);
    });

    it('lets one imported mark answer for one proposed mark only', () => {
        // The same note written twice in the same place is two marks.
        const existing = imported([textItem('t1', 0.5, 0.5, 'p')]);
        const scan = proposalOf([
            { ...scanPage(), items: [textItem('t2', 0.5, 0.5, 'p'), textItem('t3', 0.5, 0.5, 'p')] },
        ]);

        const { proposal, skipped } = dropAlreadyImported(scan, existing);

        expect(skipped).toHaveLength(1);
        expect(proposal.pages[0]?.items.map((item) => item.id)).toEqual(['t3']);
    });
});
