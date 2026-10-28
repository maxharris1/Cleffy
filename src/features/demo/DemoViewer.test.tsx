import { readFileSync } from 'node:fs';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dexie from 'dexie';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VALUE_CARD_AFTER_MARKS, VALUE_CARD_FALLBACK_MS } from '@/features/demo/DemoValueCard';
import { DEMO_KEEP_KEY, DEMO_SESSION_KEY, DEMO_VALUE_CARD_KEY } from '@/features/demo/demoSession';
import type * as DocumentsServiceModule from '@/features/library/documentsService';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type * as DbModule from '@/sync/db';
import { resetInkRecoveryForTests } from '@/sync/inkRecovery';
import { stubAnimate } from '@/test/animate';
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
    const { useEffect, useLayoutEffect, useState } = await import('react');
    const { AnnotationStore: Store } = await import('@/sync/annotationStore');
    return {
        PdfViewport: ({ docId, onStoreReady }: { docId: string; onStoreReady: (store: AnnotationStore) => void }) => {
            // As the real viewport does: a store per mount, hydrating from the mirror.
            // Registered once committed, in a layout effect: before the viewport is
            // in the DOM for a test to find, and never a store StrictMode made and
            // threw away (its second call of the initializer).
            const [store] = useState(() => new Store(h.db!, docId));
            useLayoutEffect(() => {
                if (!h.stores.includes(store)) {
                    h.stores.push(store);
                }
            }, [store]);
            useEffect(() => {
                h.events.push('mount');
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

const DEMO = 'local-demo-v2';

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

/** The failed-wipe body that claims old ink is still there: only a check that found some may show it. */
const stillSaved = () => screen.queryByText(/still saved/);

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
    vi.useRealTimers();
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
        expect(stillSaved()).toBeInTheDocument();
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

    it('a failed wipe whose check cannot read either shows Try again, never the old ink', async () => {
        await seedInk();
        refuseDeletes();
        // Reads fail too: a failed read has not shown that nothing is left.
        h.db!.close({ disableAutoOpen: true });

        renderDemo();

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        // Nothing was read, so nothing may be claimed saved.
        expect(stillSaved()).not.toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(h.events).not.toContain('mount');
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();

        await h.db!.open();
        h.gate = null;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await latestStore().load();
        expect(latestStore().annotatedPages()).toEqual([]);
    });

    it('a failed wipe whose check reads no ink left still opens the demo', async () => {
        refuseDeletes();

        renderDemo();

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        expect(screen.queryByText('Couldn’t clear your markings')).not.toBeInTheDocument();
    });

    it('a browser refusing IndexedDB outright is told storage is refused, not that markings are still saved', async () => {
        // A first visit with nothing stored, in a browser that blocks site data.
        const open = vi.spyOn(Dexie.dependencies.indexedDB!, 'open').mockImplementation(() => {
            throw new DOMException('The operation is insecure.', 'SecurityError');
        });

        renderDemo();

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        expect(screen.getByText(/isn’t letting the demo use its storage/)).toBeInTheDocument();
        expect(stillSaved()).not.toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();
        open.mockRestore();
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
        expect(stillSaved()).toBeInTheDocument();
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

    it('a failed Clear whose check cannot read either keeps the viewport unmounted, rather than bringing the ink back', async () => {
        await drawThenStartOver(() => {
            refuseDeletes();
            h.db!.close({ disableAutoOpen: true });
        });

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        expect(stillSaved()).not.toBeInTheDocument();
        expect(screen.queryByTestId('viewport')).not.toBeInTheDocument();
        expect(h.events).toEqual(['unmount', 'purge']);

        await h.db!.open();
        h.gate = null;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await latestStore().load();
        expect(latestStore().annotatedPages()).toEqual([]);
        expect(latestStore().canUndo).toBe(false);
    });

    it('Escape cancels the confirm without the event reaching the viewer', async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        const reached = vi.fn();
        window.addEventListener('keydown', reached);
        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        expect(screen.getByRole('button', { name: 'Start over' })).toHaveAttribute(
            'aria-controls',
            screen.getByText('Clear all your markings?').id,
        );

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByText('Clear all your markings?')).not.toBeInTheDocument();
        expect(reached).not.toHaveBeenCalled();
        expect(screen.getByTestId('viewport')).toBeInTheDocument();
        window.removeEventListener('keydown', reached);
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

describe('DemoViewer, the value card', () => {
    const card = () => screen.queryByRole('dialog', { name: 'What Cleffy does' });

    /** Draws `n` new strokes on the current store, one commit each, as a visitor's pen does. */
    const draw = async (n: number, prefix = 'mark') => {
        for (let i = 0; i < n; i += 1) {
            const now = new Date().toISOString();
            await act(() =>
                latestStore().create({
                    ...stroke(`${prefix}-${h.stores.length}-${i}`),
                    createdAt: now,
                    updatedAt: now,
                }),
            );
        }
    };

    /** Opens the demo and draws until the card is up. */
    const showCard = async () => {
        renderDemo();
        await screen.findByTestId('viewport');
        await draw(VALUE_CARD_AFTER_MARKS);
        return waitFor(() => {
            const shown = card();
            expect(shown).toBeInTheDocument();
            return shown!;
        });
    };

    it('stays away before the mark threshold, and comes up after it without taking focus', async () => {
        renderDemo();
        await screen.findByTestId('viewport');

        await draw(VALUE_CARD_AFTER_MARKS - 1);
        // An undo and redo of the same stroke is still one mark.
        await act(() => latestStore().undoLast());
        await act(() => latestStore().redoLast());
        expect(card()).not.toBeInTheDocument();

        await draw(1, 'last');

        const shown = await waitFor(() => {
            expect(card()).toBeInTheDocument();
            return card()!;
        });
        expect(shown).toHaveAttribute('aria-modal', 'false');
        expect(shown).not.toContainElement(document.activeElement as HTMLElement | null);
        expect(within(shown).getByText(/Bring any score/)).toBeInTheDocument();
        expect(within(shown).getByText(/saved to your library/)).toBeInTheDocument();
        expect(within(shown).getByText(/Share one link/)).toBeInTheDocument();
        // The hint went with the first stroke; the viewport is untouched.
        expect(hint()).not.toBeInTheDocument();
        expect(screen.getByTestId('viewport')).toBeInTheDocument();
    });

    it('does not count ink kept from an earlier session', async () => {
        await seedInk();
        window.localStorage.setItem(DEMO_KEEP_KEY, '1');
        renderDemo();
        await screen.findByTestId('viewport');

        await draw(VALUE_CARD_AFTER_MARKS - 1);

        expect(card()).not.toBeInTheDocument();
        await draw(1, 'last');
        await waitFor(() => expect(card()).toBeInTheDocument());
    });

    it('shows once per session: Keep playing puts it away for good, a reload included', async () => {
        const shown = await showCard();

        fireEvent.click(within(shown).getByRole('button', { name: 'Keep playing' }));

        expect(card()).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBe('1');
        await draw(VALUE_CARD_AFTER_MARKS);
        expect(card()).not.toBeInTheDocument();

        // A reload in the same tab: the dismissal holds.
        cleanup();
        renderDemo();
        await screen.findByTestId('viewport');
        await draw(VALUE_CARD_AFTER_MARKS * 2);
        expect(card()).not.toBeInTheDocument();
    });

    it('the close button puts it away, and is a 44px target on any pointer', async () => {
        const shown = await showCard();
        const close = within(shown).getByRole('button', { name: 'Close' });

        // A 44px ring on any pointer, not only touch (DemoValueCard.css).
        expect(close).toHaveClass('demo-value-close');
        fireEvent.click(close);

        expect(card()).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBe('1');
    });

    it('Escape puts it away', async () => {
        await showCard();

        fireEvent.keyDown(document.body, { key: 'Escape' });

        expect(card()).not.toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBe('1');
    });

    it('leaves Start over its Escape: hidden while the question is up, back once it is answered', async () => {
        await showCard();

        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        expect(card()).not.toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByText('Clear all your markings?')).not.toBeInTheDocument();
        expect(card()).toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBeNull();
    });

    it('Start free goes where the header’s Start free goes', async () => {
        render(
            <MemoryRouter initialEntries={['/try']}>
                <Routes>
                    <Route path="/try" element={<DemoViewer bytes={new ArrayBuffer(8)} />} />
                    <Route path="/register" element={<p>Sign-up page</p>} />
                </Routes>
            </MemoryRouter>,
        );
        await screen.findByTestId('viewport');
        await draw(VALUE_CARD_AFTER_MARKS);
        const shown = await waitFor(() => {
            expect(card()).toBeInTheDocument();
            return card()!;
        });
        const headerStartFree = within(screen.getByRole('navigation', { name: 'Score' })).getByRole('link', {
            name: 'Start free',
        });
        const cardStartFree = within(shown).getByRole('link', { name: 'Start free' });
        expect(cardStartFree).toHaveAttribute('href', '/register');
        expect(cardStartFree).toHaveAttribute('href', headerStartFree.getAttribute('href'));

        fireEvent.click(cardStartFree);

        expect(await screen.findByText('Sign-up page')).toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBe('1');
    });

    it('comes up after the fallback time for a visitor who never draws', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        renderDemo();
        await screen.findByTestId('viewport');

        act(() => vi.advanceTimersByTime(VALUE_CARD_FALLBACK_MS - 1_000));
        expect(card()).not.toBeInTheDocument();

        act(() => vi.advanceTimersByTime(1_000));
        expect(card()).toBeInTheDocument();
    });

    it('waits for the mark count, not the clock, once the visitor has started drawing', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        renderDemo();
        await screen.findByTestId('viewport');
        await draw(1);

        act(() => vi.advanceTimersByTime(VALUE_CARD_FALLBACK_MS * 2));
        expect(card()).not.toBeInTheDocument();

        await draw(VALUE_CARD_AFTER_MARKS - 1, 'more');
        await waitFor(() => expect(card()).toBeInTheDocument());
    });

    it('counts a first stroke whose write is still pending at the deadline: the clock does not bring the card', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        renderDemo();
        await screen.findByTestId('viewport');
        const store = latestStore();
        await act(() => store.load());
        // Every IndexedDB transaction waits until the test lets it go: the
        // stroke is drawn (live at pointer-up), its write is not done.
        const writes = deferred();
        const db = h.db!;
        const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
            writes.promise.then(() => transaction(...args))) as unknown as ScribblerDb['transaction']);
        const now = new Date().toISOString();
        let saved!: Promise<void>;
        act(() => {
            saved = store.create({ ...stroke('pending-first'), createdAt: now, updatedAt: now });
        });
        expect(store.liveAnnotations().map((a) => a.id)).toEqual(['pending-first']);

        act(() => vi.advanceTimersByTime(VALUE_CARD_FALLBACK_MS));

        expect(card()).not.toBeInTheDocument();

        writes.resolve();
        await act(() => saved);
        expect(card()).not.toBeInTheDocument();
        // It counts towards the marks instead.
        await draw(VALUE_CARD_AFTER_MARKS - 1, 'more');
        await waitFor(() => expect(card()).toBeInTheDocument());
    });

    it.each([
        ['Keep my markings', 'button'],
        ['Start over', 'button'],
        ['Start free', 'link'],
    ] as const)(
        'Escape with focus on the header’s %s %s, which has nothing to close, puts it away',
        async (name, role) => {
            await showCard();
            const control = within(screen.getByRole('navigation', { name: 'Score' })).getByRole(role, { name });
            control.focus();
            expect(control).toHaveFocus();

            fireEvent.keyDown(control, { key: 'Escape' });

            expect(card()).not.toBeInTheDocument();
            expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBe('1');
        },
    );

    it('leaves an open menu its Escape, then goes on the next one', async () => {
        const user = userEvent.setup();
        await showCard();

        await user.click(screen.getByRole('button', { name: 'Demo options' }));
        expect(await screen.findByRole('menu')).toBeInTheDocument();

        await user.keyboard('{Escape}');

        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
        expect(card()).toBeInTheDocument();
        expect(window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY)).toBeNull();
        // Focus is back on the menu's trigger, closed now: an ordinary button.
        expect(screen.getByRole('button', { name: 'Demo options' })).toHaveFocus();

        await user.keyboard('{Escape}');

        expect(card()).not.toBeInTheDocument();
    });

    it('leaves a text field its Escape', async () => {
        await showCard();
        const field = document.createElement('textarea');
        document.body.append(field);
        try {
            fireEvent.keyDown(field, { key: 'Escape' });
            expect(card()).toBeInTheDocument();
        } finally {
            field.remove();
        }
    });

    it('works under StrictMode, on the store the viewer was handed', async () => {
        render(
            <StrictMode>
                <MemoryRouter>
                    <DemoViewer bytes={new ArrayBuffer(8)} />
                </MemoryRouter>
            </StrictMode>,
        );
        await screen.findByTestId('viewport');
        // StrictMode makes a second store and throws it away: the stub lists only the kept one.
        expect(h.stores).toHaveLength(1);

        await draw(VALUE_CARD_AFTER_MARKS);

        await waitFor(() => expect(card()).toBeInTheDocument());
        expect(hint()).not.toBeInTheDocument();
    });

    it('sits above the phone’s bottom toolbar, by the height the toolbar reports, and clears the toolbar from sm', () => {
        // jsdom lays nothing out: the browser check (scripts/ui/uifuzz.mjs viewports)
        // measures the boxes. This holds the rule that puts it there.
        const css = readFileSync(`${process.cwd()}/src/features/demo/DemoValueCard.css`, 'utf8').replace(/\s+/g, ' ');
        expect(css).toMatch(
            /\.demo-value-dock \{ --demo-value-toolbar: var\(--toolbar-bottom-clearance, calc\(0\.75rem \+ 54px \+ var\(--safe-bottom\)\)\);/,
        );
        expect(css).toMatch(
            /padding: 0 max\(0\.5rem, var\(--safe-right\)\) calc\(0\.5rem \+ max\(var\(--demo-value-toolbar\), var\(--safe-bottom\)\)\)/,
        );
        expect(css).toMatch(
            /@media \(min-width: 40rem\) \{ \.demo-value-dock \{ padding-bottom: calc\(1rem \+ var\(--safe-bottom\)\); \} \}/,
        );
        // Below 400px wide the drawing gives its room to the words.
        expect(css).toMatch(/@media \(width < 25rem\) \{ \.demo-value-art \{ display: none; \} \}/);
    });

    it.each([
        [false, 'animates'],
        [true, 'is still'],
    ])('reduced motion %s: the illustration %s', async (reducedMotion) => {
        const { restore } = stubAnimate({ reducedMotion });
        try {
            const shown = await showCard();
            const animated = shown.querySelectorAll('.demo-value-anim');
            if (reducedMotion) {
                expect(animated).toHaveLength(0);
                expect(shown.querySelector('[class*="demo-value-anim"]')).toBeNull();
            } else {
                // Two strokes' reveals and their two cursors.
                expect(animated).toHaveLength(4);
            }
            // Either way the drawing itself is there, finished.
            expect(shown.querySelectorAll('[data-part="cursor"]')).toHaveLength(2);
        } finally {
            restore();
        }
    });

    it('never shows over a failed wipe, and comes up once Try again has worked', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
        await seedInk();
        refuseDeletes();
        renderDemo();
        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();

        act(() => vi.advanceTimersByTime(VALUE_CARD_FALLBACK_MS));

        expect(card()).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();

        h.gate = null;
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

        expect(await screen.findByTestId('viewport')).toBeInTheDocument();
        await waitFor(() => expect(card()).toBeInTheDocument());
    });

    it('never shows over a failed Start over', async () => {
        const shown = await showCard();
        expect(shown).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
        refuseDeletes();
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

        expect(await screen.findByRole('heading', { name: 'Couldn’t clear your markings' })).toBeInTheDocument();
        expect(card()).not.toBeInTheDocument();
    });
});
