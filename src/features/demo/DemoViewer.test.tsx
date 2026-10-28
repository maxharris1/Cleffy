import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_DOC_ID } from '@/features/demo/demoScore';
import { DEMO_KEEP_KEY, DEMO_SESSION_KEY } from '@/features/demo/demoSession';
import { DemoViewer } from '@/features/demo/DemoViewer';
import { useViewerStore } from '@/state/store';
import { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { resetInkRecoveryForTests } from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

/**
 * What the stubbed viewport and the purge saw, in order ('mount', 'unmount',
 * 'purge'), and every store a viewport made — each mount makes its own, as the
 * real PdfViewport does.
 */
const harness = vi.hoisted(() => ({
    events: [] as string[],
    stores: [] as AnnotationStore[],
    purge: null as unknown as ReturnType<typeof vi.fn<(docId: string, opts: unknown) => Promise<void>>>,
}));

// The real viewport is pdf.js and the ink stack. The stub keeps the part this
// suite is about: a store made on mount over the shared database, handed up
// through onStoreReady and hydrated, as PdfViewport does.
vi.mock('@/features/viewer/PdfViewport', async () => {
    const { useEffect, useState } = await import('react');
    const { AnnotationStore: Store } = await import('@/sync/annotationStore');
    const { getDb: db } = await import('@/sync/db');
    return {
        PdfViewport: ({ docId, onStoreReady }: { docId: string; onStoreReady?: (store: AnnotationStore) => void }) => {
            const [store] = useState(() => new Store(db(), docId));
            useEffect(() => {
                harness.events.push('mount');
                harness.stores.push(store);
                onStoreReady?.(store);
                void store.load();
                return () => {
                    harness.events.push('unmount');
                };
            }, [store, onStoreReady]);
            return <div data-testid="viewport" />;
        },
    };
});

vi.mock('@/features/viewer/pdf/PdfProvider', () => ({
    PdfProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/library/documentsService', async () => {
    harness.purge = vi.fn<(docId: string, opts: unknown) => Promise<void>>();
    const { isCloudDocId } = await import('@/sync/docIds');
    return {
        isCloudDocId,
        purgeLocalDocument: (docId: string, opts: unknown) => harness.purge(docId, opts),
    };
});

const stroke = (id: string): Annotation => ({
    id,
    docId: DEMO_DOC_ID,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

/** What purgeLocalDocument does to the rows that matter here. */
const deleteDemoRows = async () => {
    harness.events.push('purge');
    await getDb().annotations.where('docId').equals(DEMO_DOC_ID).delete();
    await getDb().ops.where('docId').equals(DEMO_DOC_ID).delete();
};

/** Ink a visitor left on this device in an earlier session. */
const seedInk = async () => {
    const store = new AnnotationStore(getDb(), DEMO_DOC_ID);
    await store.load();
    await store.create(stroke('old'));
};

const storedInk = () => getDb().annotations.where('docId').equals(DEMO_DOC_ID).count();

const renderDemo = () =>
    render(
        <MemoryRouter>
            <DemoViewer bytes={new ArrayBuffer(8)} />
        </MemoryRouter>,
    );

const HINT = 'Draw anywhere — Pencil, finger or mouse.';

beforeEach(async () => {
    harness.events.length = 0;
    harness.stores.length = 0;
    harness.purge.mockReset();
    harness.purge.mockImplementation(deleteDemoRows);
    window.sessionStorage.clear();
    window.localStorage.clear();
    await getDb().annotations.clear();
    await getDb().ops.clear();
    useViewerStore.getState().setFingerDraws(false);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetInkRecoveryForTests();
});

describe('DemoViewer: a new session', () => {
    it('keeps the viewport down until the wipe has finished, then mounts it once', async () => {
        let finish: () => void = () => undefined;
        harness.purge.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    harness.events.push('purge');
                    finish = resolve;
                }),
        );
        renderDemo();

        await waitFor(() => expect(harness.purge).toHaveBeenCalledWith(DEMO_DOC_ID, { heldInk: 'discard' }));
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(screen.getByText('Loading demo…')).toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();

        await act(async () => finish());

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(harness.events).toEqual(['purge', 'mount']);
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBe('1');
    });

    it('never opens on leftover ink when the wipe fails: says so, and Try again wipes and opens', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await seedInk();
        harness.purge.mockRejectedValueOnce(new DOMException('The transaction was aborted.', 'AbortError'));
        renderDemo();

        expect(
            await screen.findByText('Couldn’t clear the markings from an earlier visit, so the demo hasn’t opened.'),
        ).toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(harness.stores).toHaveLength(0);
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();
        expect(screen.getByRole('button', { name: 'Start over' })).toBeDisabled();

        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(await storedInk()).toBe(0);
        await act(async () => harness.stores[0]?.load());
        expect(harness.stores[0]?.annotatedPages()).toEqual([]);
    });

    it('opens blank when the wipe fails but no ink is left to show (a database it cannot use)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        harness.purge.mockRejectedValueOnce(new DOMException('IndexedDB is unavailable.', 'InvalidStateError'));
        renderDemo();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(screen.queryByText(/Couldn’t clear/)).not.toBeInTheDocument();
    });

    it('does not wipe on a refresh, and does not show the hint over kept ink', async () => {
        await seedInk();
        window.sessionStorage.setItem(DEMO_SESSION_KEY, '1');
        renderDemo();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await act(async () => harness.stores[0]?.load());
        expect(harness.purge).not.toHaveBeenCalled();
        expect(harness.stores[0]?.annotatedPages()).toEqual([0]);
        expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    });
});

describe('DemoViewer: the first-run hint', () => {
    it('shows over a blank score and goes with the first committed stroke', async () => {
        renderDemo();
        expect(await screen.findByText(HINT)).toBeInTheDocument();

        await act(async () => {
            await harness.stores[0]?.create(stroke('first'));
        });

        expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    });
});

describe('DemoViewer: Start over', () => {
    it('unmounts the viewport before the wipe, then remounts once on a fresh store with nothing to undo', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        const first = harness.stores[0]!;
        await act(async () => {
            await first.create(stroke('mine'));
        });
        expect(first.canUndo).toBe(true);
        harness.events.length = 0;

        await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
        expect(screen.getByText('Clear all your markings?')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

        await waitFor(() => expect(harness.stores).toHaveLength(2));
        expect(harness.events).toEqual(['unmount', 'purge', 'mount']);
        const second = harness.stores[1]!;
        await act(async () => second.load());
        expect(second).not.toBe(first);
        expect(second.canUndo).toBe(false);
        expect(second.annotatedPages()).toEqual([]);
        expect(screen.queryByText('Clear all your markings?')).not.toBeInTheDocument();
    });

    it('a failed clear remounts on what is left and keeps the strip up, saying so', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        renderDemo();
        await screen.findByTestId('viewport');
        await act(async () => {
            await harness.stores[0]!.create(stroke('mine'));
        });
        harness.purge.mockRejectedValueOnce(new DOMException('The transaction was aborted.', 'AbortError'));

        await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
        await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

        expect(await screen.findByText('Couldn’t clear your markings. Try again?')).toBeInTheDocument();
        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(harness.stores).toHaveLength(2);
        expect(await storedInk()).toBe(1);

        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByText(/Couldn’t clear your markings/)).not.toBeInTheDocument();
    });

    it('Escape cancels the confirm without the event reaching the viewer', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        const reached = vi.fn();
        window.addEventListener('keydown', reached);
        await userEvent.click(screen.getByRole('button', { name: 'Start over' }));

        await userEvent.keyboard('{Escape}');

        expect(screen.queryByText('Clear all your markings?')).not.toBeInTheDocument();
        expect(reached).not.toHaveBeenCalled();
        expect(harness.purge).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', reached);
    });
});

describe('DemoViewer: finger drawing', () => {
    it.each([false, true])('is on while the demo is up, and back to %s after', async (previous) => {
        useViewerStore.getState().setFingerDraws(previous);
        const { unmount } = renderDemo();
        expect(useViewerStore.getState().fingerDraws).toBe(true);
        await screen.findByTestId('viewport');

        unmount();

        expect(useViewerStore.getState().fingerDraws).toBe(previous);
    });
});

describe('DemoViewer: keep my markings', () => {
    it('turns on when the browser keeps the choice', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        const toggle = screen.getByRole('button', { name: 'Keep my markings' });

        await userEvent.click(toggle);

        expect(toggle).toHaveAttribute('aria-pressed', 'true');
        expect(window.localStorage.getItem(DEMO_KEEP_KEY)).toBe('1');
    });

    it('stays off and says why when the browser refuses to store the choice', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        });
        const toggle = screen.getByRole('button', { name: 'Keep my markings' });

        await userEvent.click(toggle);

        expect(toggle).toHaveAttribute('aria-pressed', 'false');
        expect(
            screen.getByText('This browser isn’t keeping site data, so your markings clear when you close it.'),
        ).toBeInTheDocument();
        await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
        expect(screen.queryByText(/isn’t keeping site data/)).not.toBeInTheDocument();
    });
});
