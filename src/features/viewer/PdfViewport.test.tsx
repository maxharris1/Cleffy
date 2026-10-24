import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { ConfirmDialog } from '@/ui/ConfirmDialog';

const PAGE_SIZES = [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 },
];

// Pages are laid out, never drawn: the viewer's geometry is what is under test.
vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: PAGE_SIZES, status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

/** jsdom lays nothing out: the viewport reports this size, and the notice stack these heights. */
let viewport = { width: 800, height: 600 };
/** Rendered heights (px) of one notice card and the gap between cards, phone size. */
const NOTICE_PX = 52;
const NOTICE_GAP_PX = 6;
/** The region's top on phones (top-14). */
const REGION_TOP_PX = 56;

const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            private readonly callback: () => void;
            constructor(callback: () => void) {
                this.callback = callback;
                resizeCallbacks.add(callback);
            }
            observe() {}
            unobserve() {}
            disconnect() {
                resizeCallbacks.delete(this.callback);
            }
        },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => viewport.width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewport.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-viewer-notices')) {
            const cards = this.children.length;
            const height = cards === 0 ? 0 : cards * NOTICE_PX + (cards - 1) * NOTICE_GAP_PX;
            return DOMRect.fromRect({ x: 0, y: REGION_TOP_PX, width: viewport.width, height });
        }
        return DOMRect.fromRect({ x: 0, y: 0, width: viewport.width, height: viewport.height });
    });
    useViewerStore.getState().resetView({ scale: 1, scrollX: 0, scrollY: 0 });
});

afterEach(() => {
    cleanup();
    resizeCallbacks.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useViewerStore.getState().resetPlayback();
    viewport = { width: 800, height: 600 };
});

describe('PdfViewport keyboard shortcuts under a confirmation', () => {
    /** The viewer, with a ConfirmDialog (an alertdialog) the test can open over it. */
    const ViewerWithConfirm = ({ onStore }: { onStore: (store: AnnotationStore) => void }) => {
        const [confirming, setConfirming] = useState(false);
        return (
            <>
                <button type="button" onClick={() => setConfirming(true)}>
                    Ask
                </button>
                <PdfViewport docId="doc-keys" onStoreReady={onStore} />
                {confirming ? (
                    <ConfirmDialog
                        title="Delete this page?"
                        body="It cannot be undone."
                        confirmLabel="Delete"
                        onConfirm={() => setConfirming(false)}
                        onCancel={() => setConfirming(false)}
                    />
                ) : null}
            </>
        );
    };

    const renderViewer = async () => {
        let store: AnnotationStore | null = null;
        render(<ViewerWithConfirm onStore={(s) => (store = s)} />);
        await waitFor(() => expect(store).not.toBeNull());
        const undoLast = vi.spyOn(store as unknown as AnnotationStore, 'undoLast');
        const redoLast = vi.spyOn(store as unknown as AnnotationStore, 'redoLast');
        return { undoLast, redoLast };
    };

    const scrollY = () => useViewerStore.getState().view.scrollY;

    it('turns pages and undoes with no dialog open (the control case)', async () => {
        const { undoLast } = await renderViewer();
        const start = scrollY();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        const afterArrow = scrollY();
        expect(afterArrow).toBeGreaterThan(start);
        fireEvent.keyDown(document.body, { key: ' ' });
        expect(scrollY()).toBeGreaterThan(afterArrow);
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(undoLast).toHaveBeenCalledTimes(1);
    });

    it('ignores ArrowRight, Space and Ctrl+Z while an alertdialog is open, wherever the key lands', async () => {
        const { undoLast, redoLast } = await renderViewer();
        fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
        const confirm = await screen.findByRole('alertdialog', { name: 'Delete this page?' });
        const start = scrollY();

        // In the confirm (where its focus trap keeps the keyboard) and outside
        // it (a key Base UI's trap did not catch, a pedal's synthetic event).
        for (const target of [confirm, document.body]) {
            fireEvent.keyDown(target, { key: 'ArrowRight' });
            fireEvent.keyDown(target, { key: ' ' });
            fireEvent.keyDown(target, { key: 'PageDown' });
            fireEvent.keyDown(target, { key: 'z', ctrlKey: true });
            fireEvent.keyDown(target, { key: 'z', metaKey: true });
            fireEvent.keyDown(target, { key: 'z', ctrlKey: true, shiftKey: true });
        }
        expect(scrollY()).toBe(start);
        expect(undoLast).not.toHaveBeenCalled();
        expect(redoLast).not.toHaveBeenCalled();

        // Answered, the viewer's keys work again.
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(scrollY()).toBeGreaterThan(start);
    });
});
