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

    it('shows the nothing-found explanation', async () => {
        vi.mocked(scanDocument).mockResolvedValue(proposalOf([]));
        renderPanel();
        await screen.findByText(/No importable marks found/);
        expect(store.isHistoryMode).toBe(false);
    });

    it('surfaces scan failures with a retry', async () => {
        vi.mocked(scanDocument).mockRejectedValue(new Error('render exploded'));
        renderPanel();
        await screen.findByText('render exploded');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
});
