import { afterEach, describe, expect, it, vi } from 'vitest';

import { useViewerStore } from '@/state/store';

afterEach(() => useViewerStore.setState({ penSeen: false }));

describe('penSeen', () => {
    it('starts unset and is set by the first pen', () => {
        expect(useViewerStore.getState().penSeen).toBe(false);
        useViewerStore.getState().markPenSeen();
        expect(useViewerStore.getState().penSeen).toBe(true);
    });

    it('notifies subscribers once, not on every later pen-down', () => {
        const listener = vi.fn();
        const unsubscribe = useViewerStore.subscribe(listener);
        useViewerStore.getState().markPenSeen();
        useViewerStore.getState().markPenSeen();
        useViewerStore.getState().markPenSeen();
        unsubscribe();
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
