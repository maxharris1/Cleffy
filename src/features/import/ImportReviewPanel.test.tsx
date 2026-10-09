import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImportReviewPanel } from '@/features/import/ImportReviewPanel';
import type { ImportProposal, ProposedItem } from '@/features/import/importTypes';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

vi.mock('@/features/import/importPipeline', () => ({
    scanDocument: vi.fn(),
}));

import { scanDocument } from '@/features/import/importPipeline';

const DOC = 'local-paneldoc';

const makeAnnotation = (id: string): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'text',
    color: '#2563eb',
    payload: { x: 0.1, y: 0.1, text: '3', size: 0.018 },
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    seq: 0,
});

const makeItem = (id: string, label: string): ProposedItem => ({
    id,
    pageIndex: 0,
    clusterIds: [id],
    annotations: [makeAnnotation(`a-${id}`)],
    label,
    isText: true,
    confidence: 'high',
});

const proposalOf = (items: ProposedItem[]): ImportProposal => ({
    docId: DOC,
    pages:
        items.length > 0
            ? [
                  {
                      pageIndex: 0,
                      rasterWidth: 2048,
                      rasterHeight: 2650,
                      items,
                      segmentation: {
                          pageIndex: 0,
                          width: 2048,
                          height: 2650,
                          clusters: [],
                          flags: { tooColorful: false, largeColorRegion: false, dense: false },
                      },
                      stripSubtypes: [],
                  },
              ]
            : [],
    aiDegraded: false,
    unreadablePages: [],
    tooColorfulPages: [],
});

let store: AnnotationStore;

beforeEach(async () => {
    vi.mocked(scanDocument).mockReset();
    store = new AnnotationStore(new ScribblerDb(`test-${crypto.randomUUID()}`), DOC);
    await store.load();
});

// RTL auto-cleanup needs vitest globals; this suite renders per-test panels, so clean explicitly.
afterEach(() => cleanup());

const renderPanel = () =>
    render(
        <ImportReviewPanel
            store={store}
            docId={DOC}
            bytes={new ArrayBuffer(8)}
            classify={null}
            includeBornDigital={false}
            clean={null}
            onClose={() => undefined}
        />,
    );

describe('ImportReviewPanel', () => {
    it('scans, previews via the history overlay, and imports checked marks', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([makeItem('c1', '“3”'), makeItem('c2', '“4”')]));
        renderPanel();

        await screen.findByText(/Found/);
        // Review preview holds the doc read-only through the overlay.
        await waitFor(() => expect(store.isHistoryMode).toBe(true));

        await userEvent.click(screen.getByRole('button', { name: /Import 2 marks/ }));
        await screen.findByText(/Imported 2 marks/);
        expect(store.isHistoryMode).toBe(false);
        expect(store.liveAnnotations()).toHaveLength(2);
    });

    it('imports only checked items', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([makeItem('c1', '“3”'), makeItem('c2', '“4”')]));
        renderPanel();

        await screen.findByText(/Found/);
        const checkboxes = screen.getAllByRole('checkbox');
        // First checkbox is the preview toggle; item boxes follow.
        const itemBox = checkboxes.find((el) => el.closest('li') !== null);
        expect(itemBox).toBeDefined();
        if (itemBox) {
            await userEvent.click(itemBox);
        }
        await userEvent.click(screen.getByRole('button', { name: /Import 1 marks/ }));
        await screen.findByText(/Imported 1 marks/);
        expect(store.liveAnnotations()).toHaveLength(1);
    });

    it('warns local docs that original ink stays on the page', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([makeItem('c1', '“3”')]));
        renderPanel();
        await screen.findByText(/Found/);
        expect(screen.getByText(/original handwriting stays/)).toBeInTheDocument();
    });

    it('offers the clean checkbox instead when cleaning is available', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([makeItem('c1', '“3”')]));
        render(
            <ImportReviewPanel
                store={store}
                docId={DOC}
                bytes={new ArrayBuffer(8)}
                classify={null}
                includeBornDigital={false}
                clean={async () => undefined}
                onClose={() => undefined}
            />,
        );
        await screen.findByText(/Found/);
        expect(screen.getByText(/lift the original ink off the page/)).toBeInTheDocument();
        expect(screen.queryByText(/original handwriting stays/)).toBeNull();
    });

    it('shows the nothing-found explanation', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([]));
        renderPanel();
        await screen.findByText(/No importable marks found/);
        expect(store.isHistoryMode).toBe(false);
    });

    it('offers recognition again when the AI was only unavailable', async () => {
        vi.mocked(scanDocument).mockResolvedValue({ ...proposalOf([makeItem('c1', 'ink mark')]), aiDegraded: true });
        renderPanel();
        await screen.findByText(/Text recognition is unavailable right now/);
        expect(screen.getByRole('button', { name: 'Try recognition again' })).toBeInTheDocument();
    });

    it('says the AI page reads are spent instead of inviting a retry that would be refused', async () => {
        const { LimitReachedError } = await import('@/features/billing/limitErrors');
        vi.mocked(scanDocument).mockResolvedValue({
            ...proposalOf([makeItem('c1', 'ink mark')]),
            aiDegraded: true,
            aiLimit: new LimitReachedError({ code: 'limit_reached', metric: 'vision_reads', limit: 5, tier: 'free' }),
        });
        renderPanel();

        expect(await screen.findByText('You have used your 5 free AI page reads this month')).toBeInTheDocument();
        expect(screen.getByText(/import as ink you can erase/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Try recognition again' })).not.toBeInTheDocument();
        expect(screen.queryByText(/unavailable right now/)).not.toBeInTheDocument();
        // The marks can still be imported, as ink.
        expect(screen.getByRole('button', { name: /Import 1 mark/ })).toBeInTheDocument();
    });

    it('surfaces scan failures with a retry', async () => {
        vi.mocked(scanDocument).mockRejectedValue(new Error('render exploded'));
        renderPanel();
        await screen.findByText('render exploded');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
});
