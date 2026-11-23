import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

// Idle prefetches import whole route chunks (pdf.js among them) on a timer,
// which in jsdom would land after the test that scheduled them has finished.
// idlePrefetch.test.ts tests the real module.
vi.mock('@/lib/idlePrefetch', () => ({ prefetchWhenIdle: vi.fn() }));

// The Base UI dialog and menu are lazy chunks (ui/lazyPrimitives). Importing
// them here only warms the test runner's module cache: components still take
// the lazy path and mount a tick after render, as a prefetched chunk does in
// the app, rather than after a cold transform that can outlast findBy's timeout.
beforeAll(async () => {
    if (typeof document === 'undefined') return;
    await Promise.all([import('@/ui/DialogPanel'), import('@/ui/MenuBase')]);
});

// Test files share one worker without isolation (AGENTS.md, "Tests run
// without isolation"). Each file starts from what a fresh worker would give it.
afterEach(async () => {
    if (typeof document === 'undefined') return;
    const { cleanup } = await import('@testing-library/react');
    cleanup();
});

afterAll(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();

    const indexedDB = new IDBFactory();
    globalThis.indexedDB = indexedDB;
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;

    if (typeof document === 'undefined') return;
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
});
