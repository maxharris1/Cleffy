import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_KEEP_KEY, DEMO_SESSION_KEY } from '@/features/demo/demoSession';
import type * as DocumentsServiceModule from '@/features/library/documentsService';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type * as DbModule from '@/sync/db';
import { resetInkRecoveryForTests } from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

/**
 * The demo's session behaviour lives in DemoViewer's effects: when the
 * viewport may mount, what Start over unmounts and remounts, and what a wipe
 * that fails shows. The viewport is a stub that records its mounts and hands
 * DemoViewer a real AnnotationStore on a test database; purgeLocalDocument is
 * the real one, held behind a gate each test opens (or makes fail).
 */
const h = vi.hoisted(() => ({
    db: null as ScribblerDb | null,
    events: [] as string[],
    stores: [] as AnnotationStore[],
    /** What the next purge does once called: wait on this, then really purge (or throw). */
    gate: null as Promise<void> | null,
}));

vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof DbModule>()),
    getDb: () => h.db,
}));

vi.mock('@/features/library/documentsService', async () => {
    const actual = await vi.importActual<typeof DocumentsServiceModule>('@/features/library/documentsService');
    return {
        ...actual,
        purgeLocalDocument: vi.fn(async (...args: Parameters<typeof actual.purgeLocalDocument>) => {
            h.events.push('purge');
            await h.gate;
            await actual.purgeLocalDocument(...args);
            h.events.push('purged');
        }),
    };
});

vi.mock('@/features/viewer/pdf/PdfProvider', () => ({
    PdfProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/viewer/PdfViewport', async () => {
    const { useEffect, useState } = await import('react');
    const { AnnotationStore: Store } = await import('@/sync/annotationStore');
    return {
        PdfViewport: ({ docId, onStoreReady }: { docId: string; onStoreReady: (store: AnnotationStore) => void }) => {
            // As the real viewport does: a store per mount, hydrating from the mirror.
            const [store] = useState(() => new Store(h.db!, docId));
            useEffect(() => {
                h.events.push('mount');
                h.stores.push(store);
                onStoreReady(store);
                return () => {
                    h.events.push('unmount');
                };
            }, [store, onStoreReady]);
            return <div data-testid="viewport" />;
        },
    };
});

const { DemoViewer } = await import('@/features/demo/DemoViewer');

const DEMO = 'local-demo-v1';

const stroke = (id: string): Annotation => ({
    id,
    docId: DEMO,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

/** Ink an earlier visit left in the mirror. */
const seedInk = () => h.db!.annotations.put({ ...stroke('earlier'), pending: 0 });

const deferred = () => {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    // Rejected before anyone awaits it: not an unhandled rejection.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
};

/** Every delete refuses; reads still work (a database half-closed under the page). */
const refuseDeletes = () => {
    const gate = deferred();
    gate.reject(new DOMException('The transaction was aborted.', 'AbortError'));
    h.gate = gate.promise;
};

const renderDemo = () =>
    render(
        <MemoryRouter>
            <DemoViewer bytes={new ArrayBuffer(8)} />
        </MemoryRouter>,
    );

const latestStore = () => h.stores[h.stores.length - 1]!;

const hint = () => screen.queryByText('Draw anywhere — Pencil, finger or mouse.');

beforeEach(() => {
    h.db = new ScribblerDb(`demo-viewer-${crypto.randomUUID()}`);
    h.events = [];
    h.stores = [];
    h.gate = null;
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetInkRecoveryForTests();
    useViewerStore.getState().setFingerDraws(false);
});

describe('DemoViewer, opening a session', () => {
    it('mounts no viewport until the wipe has finished, then opens on a blank score', async () => {
        await seedInk();
        const gate = deferred();
        h.gate = gate.promise;

        renderDemo();

        await waitFor(() => expect(h.events).toEqual(['purge']));
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(screen.getByText('Loading demo…')).toBeInTheDocument();

        gate.resolve();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(h.events).toEqual(['purge', 'purged', 'mount']);
        await latestStore().load();
        expect(latestStore().annotatedPages()).toEqual([]);
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBe('1');
    });

    it('a failed wipe with old ink still stored shows Try again, never the old ink', async () => {
        await seedInk();
        refuseDeletes();

        renderDemo();

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(h.events).not.toContain('mount');
        // Not marked started, so a reload tries the wipe again too.
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();

        h.gate = null;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await latestStore().load();
        expect(latestStore().annotatedPages()).toEqual([]);
    });

    it('a failed wipe with nothing stored to show still opens the demo (a browser that keeps no site data)', async () => {
        refuseDeletes();

        renderDemo();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(screen.queryByText('Couldn’t clear your markings')).not.toBeInTheDocument();
    });

    it('opens on kept ink without wiping, and the hint stays hidden for it', async () => {
        await seedInk();
        window.localStorage.setItem(DEMO_KEEP_KEY, '1');

        renderDemo();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(h.events).not.toContain('purge');
        await act(() => latestStore().load());
        expect(latestStore().annotatedPages()).toEqual([0]);
        expect(hint()).not.toBeInTheDocument();
    });
});

describe('DemoViewer, the first-run hint', () => {
    it('shows on a blank score and goes with the first committed stroke', async () => {
        renderDemo();

        expect(await screen.findByText('Draw anywhere — Pencil, finger or mouse.')).toBeInTheDocument();

        await act(() => latestStore().create(stroke('first')));

        await waitFor(() => expect(hint()).not.toBeInTheDocument());
    });
});

describe('DemoViewer, Start over', () => {
    /** Draws a stroke, then Start over → Clear, with `beforeClear` setting up the purge Clear will meet. */
    const drawThenStartOver = async (beforeClear: () => void) => {
        renderDemo();
        await screen.findByTestId('viewport');
        const first = latestStore();
        await act(() => first.create(stroke('mine')));
        expect(first.canUndo).toBe(true);
        expect(await h.db!.annotations.where('docId').equals(DEMO).count()).toBe(1);

        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        h.events = [];
        beforeClear();
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        return first;
    };

    it('unmounts the viewport before the purge, then remounts a fresh store: blank, nothing to undo', async () => {
        const gate = deferred();
        const first = await drawThenStartOver(() => {
            h.gate = gate.promise;
        });

        await waitFor(() => expect(h.events).toEqual(['unmount', 'purge']));
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(screen.getByText('Clearing your markings…')).toBeInTheDocument();

        gate.resolve();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(h.events).toEqual(['unmount', 'purge', 'purged', 'mount']);
        const fresh = latestStore();
        expect(fresh).not.toBe(first);
        await fresh.load();
        expect(fresh.annotatedPages()).toEqual([]);
        expect(fresh.canUndo).toBe(false);
        expect(await h.db!.annotations.where('docId').equals(DEMO).count()).toBe(0);
    });

    it('a failed Clear keeps the viewport unmounted and says so, rather than bringing the ink back', async () => {
        await drawThenStartOver(refuseDeletes);

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(h.events).toEqual(['unmount', 'purge']);
        expect(screen.getByRole('button', { name: 'Start over' })).toBeDisabled();

        h.gate = null;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await latestStore().load();
        expect(latestStore().annotatedPages()).toEqual([]);
        expect(latestStore().canUndo).toBe(false);
    });

    it('Cancel keeps the ink and the viewport', async () => {
        renderDemo();
        await screen.findByTestId('viewport');

        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByText('Clear all your markings?')).not.toBeInTheDocument();
        expect(h.events.filter((e) => e === 'purge')).toHaveLength(1);
        expect(screen.getByTestId('viewport')).toBeInTheDocument();
    });
});

describe('DemoViewer, finger drawing', () => {
    it.each([false, true])('is on while the demo is up, and back to %s after', async (previous) => {
        useViewerStore.getState().setFingerDraws(previous);

        const { unmount } = renderDemo();
        await screen.findByTestId('viewport');
        expect(useViewerStore.getState().fingerDraws).toBe(true);

        unmount();
        expect(useViewerStore.getState().fingerDraws).toBe(previous);
    });
});

describe('DemoViewer, keep my markings', () => {
    const keepToggle = () => screen.getByRole('button', { name: 'Keep my markings' });

    it('turns on and stays on when the choice is stored', async () => {
        renderDemo();
        await screen.findByTestId('viewport');

        fireEvent.click(keepToggle());

        expect(keepToggle()).toHaveAttribute('aria-pressed', 'true');
        expect(window.localStorage.getItem(DEMO_KEEP_KEY)).toBe('1');
    });

    it('stays off and says why when storage refuses the choice (storage full)', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        });

        fireEvent.click(keepToggle());

        expect(keepToggle()).toHaveAttribute('aria-pressed', 'false');
        const refused = 'This browser isn’t keeping site data, so your markings clear when you close it.';
        // The notice (for phones too, whose menu closes on the press) and the toggle's own help.
        expect(screen.getByText(refused, { selector: 'p' })).toBeInTheDocument();
        expect(keepToggle()).toHaveAttribute('title', refused);

        const notice = screen.getByText(refused, { selector: 'p' }).parentElement!;
        fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText(refused, { selector: 'p' })).not.toBeInTheDocument();
    });

    it('says a reload will clear the ink when the session itself cannot be remembered', async () => {
        vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        });

        renderDemo();
        await screen.findByTestId('viewport');

        expect(keepToggle()).toHaveAttribute(
            'title',
            'This browser isn’t keeping site data, so your markings clear if you reload or leave.',
        );
    });
});

describe('DemoViewer, touch targets', () => {
    /** The codebase's invisible 44px hit areas (index.css hit-44, or a ::before ring). */
    const COARSE_HIT_AREA = /pointer-coarse:(hit-44|before:-inset-|min-h-11)/;

    it('gives every control the demo adds a 44px hit area on a coarse pointer', async () => {
        renderDemo();
        // The hint hides while Start over asks, so its ✕ is taken first.
        const hintText = await screen.findByText('Draw anywhere — Pencil, finger or mouse.');
        const hintDismiss = within(hintText.parentElement!).getByRole('button', { name: 'Dismiss' });
        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));

        const nav = screen.getByRole('navigation', { name: 'Score' });
        const confirm = screen.getByText('Clear all your markings?').parentElement!;
        const controls = [
            ...within(nav).getAllByRole('button'),
            ...within(nav).getAllByRole('link'),
            ...within(confirm).getAllByRole('button'),
            hintDismiss,
        ];

        // Start over, Keep, the phone menu, Start free, Clear, Cancel, the hint's ✕.
        expect(controls).toHaveLength(7);
        for (const control of controls) {
            expect(control.className, control.textContent || control.getAttribute('aria-label') || '').toMatch(
                COARSE_HIT_AREA,
            );
        }
    });
});
