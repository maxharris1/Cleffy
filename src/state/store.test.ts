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
    const FINGER = 2;
    const send = (doc: EventTarget, type: string, pointerType = 'touch', pointerId = FINGER) =>
        doc.dispatchEvent(Object.assign(new Event(type), { pointerType, pointerId }));

    const track = () => {
        const doc = new EventTarget();
        const stop = trackPointerKinds(doc as Document);
        return { doc, stop };
    };

    const touchSeen = () => useViewerStore.getState().touchSeen;

    it('records a pen at once, so drawing never waits on it', () => {
        const { doc, stop } = track();
        send(doc, 'pointerdown', 'pen');
        expect(useViewerStore.getState().penSeen).toBe(true);
        stop();
    });

    it.each([
        [
            'its click after the finger lifts',
            (doc: EventTarget) => {
                send(doc, 'pointerup');
                send(doc, 'click');
            },
        ],
        ['its cancel', (doc: EventTarget) => send(doc, 'pointercancel')],
        [
            'half a second after the finger lifts',
            (doc: EventTarget) => {
                send(doc, 'pointerup');
                vi.advanceTimersByTime(499);
                expect(touchSeen()).toBe(false);
                vi.advanceTimersByTime(1);
            },
        ],
    ])('records a touch only once its press ends with %s', (_, end) => {
        vi.useFakeTimers();
        const { doc, stop } = track();
        send(doc, 'pointerdown');
        expect(touchSeen()).toBe(false);
        end(doc);
        expect(touchSeen()).toBe(true);
        stop();
    });

    it.each([
        ['a keyboard click', (doc: EventTarget) => send(doc, 'click', '', -1)],
        [
            'a right-click',
            (doc: EventTarget) => {
                send(doc, 'pointerdown', 'mouse', 1);
                send(doc, 'pointerup', 'mouse', 1);
                send(doc, 'click', 'mouse', 1);
            },
        ],
        [
            'another finger lifting',
            (doc: EventTarget) => {
                send(doc, 'pointerdown', 'touch', FINGER + 1);
                send(doc, 'pointerup', 'touch', FINGER + 1);
                send(doc, 'click', 'touch', FINGER + 1);
            },
        ],
        ['another finger cancelling', (doc: EventTarget) => send(doc, 'pointercancel', 'touch', FINGER + 1)],
    ])('keeps a held touch unrecorded through %s', (_, interleave) => {
        vi.useFakeTimers();
        const { doc, stop } = track();
        send(doc, 'pointerdown');
        interleave(doc);
        vi.advanceTimersByTime(10_000);
        expect(touchSeen()).toBe(false);
        send(doc, 'pointerup');
        vi.advanceTimersByTime(500);
        expect(touchSeen()).toBe(true);
        stop();
    });

    it('records nothing once stopped, even a touch pressed before', () => {
        vi.useFakeTimers();
        const { doc, stop } = track();
        send(doc, 'pointerdown');
        send(doc, 'pointerup');
        stop();
        vi.runAllTimers();
        send(doc, 'click');
        send(doc, 'pointerdown', 'pen');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: false, touchSeen: false });
    });

    it('records a click with no touch before it as nothing', () => {
        const { doc, stop } = track();
        send(doc, 'click', 'mouse');
        expect(touchSeen()).toBe(false);
        stop();
    });
});
