import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { beforeAll, vi } from 'vitest';

// Idle prefetches import whole route chunks (pdf.js among them) on a timer,
// which in jsdom would land after the test that scheduled them has finished.
// idlePrefetch.test.ts tests the real module.
vi.mock('@/lib/idlePrefetch', () => ({ prefetchWhenIdle: vi.fn() }));

// The Base UI dialog and menu are lazy chunks (ui/lazyPrimitives). Importing
// them here only warms the test runner's module cache: components still take
// the lazy path and mount a tick after render, as a prefetched chunk does in
// the app, rather than after a cold transform that can outlast findBy's timeout.
beforeAll(async () => {
    await Promise.all([import('@/ui/DialogPanel'), import('@/ui/MenuBase')]);
});
