import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackPointerKinds, useViewerStore } from '@/state/store';

afterEach(() => {
    vi.useRealTimers();
    useViewerStore.setState({ penSeen: false, touchSeen: false });
});

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

describe('trackPointerKinds', () => {
    const press = (doc: EventTarget, type: string, pointerType = 'touch') =>
        doc.dispatchEvent(Object.assign(new Event(type), { pointerType }));

    const track = () => {
        const doc = new EventTarget();
        const stop = trackPointerKinds(doc as Document);
        return { doc, stop };
    };

    it('records a pen at once, so drawing never waits on it', () => {
        const { doc, stop } = track();
        press(doc, 'pointerdown', 'pen');
        expect(useViewerStore.getState().penSeen).toBe(true);
        stop();
    });

    it.each([
        ['its click', (doc: EventTarget) => press(doc, 'click')],
        ['a cancel', (doc: EventTarget) => press(doc, 'pointercancel')],
        [
            'half a second after the finger lifts',
            (doc: EventTarget) => {
                press(doc, 'pointerup');
                vi.advanceTimersByTime(499);
                expect(useViewerStore.getState().touchSeen).toBe(false);
                vi.advanceTimersByTime(1);
            },
        ],
    ])('records a touch only once its press ends with %s', (_, end) => {
        vi.useFakeTimers();
        const { doc, stop } = track();
        press(doc, 'pointerdown');
        expect(useViewerStore.getState().touchSeen).toBe(false);
        end(doc);
        expect(useViewerStore.getState().touchSeen).toBe(true);
        stop();
    });

    it('records nothing once stopped, even a touch pressed before', () => {
        vi.useFakeTimers();
        const { doc, stop } = track();
        press(doc, 'pointerdown');
        press(doc, 'pointerup');
        stop();
        vi.runAllTimers();
        press(doc, 'click');
        press(doc, 'pointerdown', 'pen');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: false });
    });

    it('records a click with no touch before it as nothing', () => {
        const { doc, stop } = track();
        press(doc, 'click', 'mouse');
        expect(useViewerStore.getState().touchSeen).toBe(false);
        stop();
    });
});
