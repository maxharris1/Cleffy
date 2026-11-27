import { afterEach, describe, expect, it, vi } from 'vitest';

import { useViewerStore } from '@/state/store';

afterEach(() => useViewerStore.setState({ penSeen: false, touchSeen: false }));

describe('notePointer', () => {
    it('starts with nothing seen and records each pointer kind by its first press', () => {
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: false });
        useViewerStore.getState().notePointer('mouse');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: false });
        useViewerStore.getState().notePointer('touch');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: true });
        useViewerStore.getState().notePointer('pen');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: true, touchSeen: true });
    });

    it('notifies subscribers once per kind, not on every later press', () => {
        const listener = vi.fn();
        const unsubscribe = useViewerStore.subscribe(listener);
        for (let i = 0; i < 3; i++) {
            useViewerStore.getState().notePointer('pen');
            useViewerStore.getState().notePointer('touch');
            useViewerStore.getState().notePointer('mouse');
        }
        unsubscribe();
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
