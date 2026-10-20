import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// Idle prefetches import whole route chunks (pdf.js among them) on a timer,
// which in jsdom would land after the test that scheduled them has finished.
// idlePrefetch.test.ts tests the real module.
vi.mock('@/lib/idlePrefetch', () => ({ prefetchWhenIdle: vi.fn() }));
