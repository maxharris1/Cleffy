import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GestureController, type GestureCallbacks, type InkDelegate } from '@/features/viewer/ink/GestureController';

/** Two-finger pinch on the viewer surface, as PointerEvents. */
const touch = (type: string, pointerId: number, x: number, y: number): PointerEvent =>
    new PointerEvent(type, { pointerId, pointerType: 'touch', clientX: x, clientY: y, button: 0, bubbles: true });

let el: HTMLDivElement;
let callbacks: {
    onPan: ReturnType<typeof vi.fn<GestureCallbacks['onPan']>>;
    onZoomBy: ReturnType<typeof vi.fn<GestureCallbacks['onZoomBy']>>;
    onWheelScroll: ReturnType<typeof vi.fn<GestureCallbacks['onWheelScroll']>>;
    onGestureEnd: ReturnType<typeof vi.fn<GestureCallbacks['onGestureEnd']>>;
};
let controller: GestureController;

beforeEach(() => {
    el = document.createElement('div');
    el.setPointerCapture = () => undefined;
    document.body.appendChild(el);
    callbacks = {
        onPan: vi.fn<GestureCallbacks['onPan']>(),
        onZoomBy: vi.fn<GestureCallbacks['onZoomBy']>(),
        onWheelScroll: vi.fn<GestureCallbacks['onWheelScroll']>(),
        onGestureEnd: vi.fn<GestureCallbacks['onGestureEnd']>(),
    };
});

afterEach(() => {
    controller.destroy();
    el.remove();
});

const delegate = (claim: boolean, shouldInk: InkDelegate['shouldInk'] = () => false) => {
    const onPinch = vi.fn<(factor: number) => boolean>(() => claim);
    const onPinchEnd = vi.fn<() => void>();
    const onInkDown = vi.fn();
    const onInkCancel = vi.fn();
    const ink: InkDelegate = {
        shouldInk,
        onInkDown,
        onInkMove: () => undefined,
        onInkUp: () => undefined,
        onInkCancel,
        onPinch,
        onPinchEnd,
        canPinch: () => claim,
    };
    return { ink, onPinch, onPinchEnd, onInkDown, onInkCancel };
};

const pinchOut = () => {
    el.dispatchEvent(touch('pointerdown', 1, 100, 100));
    el.dispatchEvent(touch('pointerdown', 2, 200, 100));
    el.dispatchEvent(touch('pointermove', 2, 250, 100));
    el.dispatchEvent(touch('pointermove', 2, 300, 100));
    el.dispatchEvent(touch('pointerup', 2, 300, 100));
    el.dispatchEvent(touch('pointerup', 1, 100, 100));
};

describe('GestureController pinch hand-off', () => {
    it('lets the ink delegate claim a pinch: no page zoom or pan, and an end callback', () => {
        controller = new GestureController(el, callbacks);
        const { ink, onPinch, onPinchEnd } = delegate(true);
        controller.setInkDelegate(ink);
        pinchOut();
        expect(onPinch).toHaveBeenCalledTimes(2);
        expect(onPinch.mock.calls[0]![0]).toBeCloseTo(1.5);
        expect(onPinch.mock.calls[1]![0]).toBeCloseTo(200 / 150);
        expect(onPinchEnd).toHaveBeenCalledTimes(1);
        expect(callbacks.onZoomBy).not.toHaveBeenCalled();
        expect(callbacks.onPan).not.toHaveBeenCalled();
    });

    it('zooms the page as before when the delegate declines', () => {
        controller = new GestureController(el, callbacks);
        const { ink, onPinchEnd } = delegate(false);
        controller.setInkDelegate(ink);
        pinchOut();
        expect(callbacks.onZoomBy).toHaveBeenCalledTimes(2);
        expect(callbacks.onZoomBy.mock.calls[0]![0]).toBeCloseTo(1.5);
        expect(onPinchEnd).not.toHaveBeenCalled();
    });

    it('promotes the first finger-draw ink pointer into a pinch when Finger-draw is on', () => {
        controller = new GestureController(el, callbacks);
        const { ink, onPinch, onPinchEnd, onInkDown, onInkCancel } = delegate(true, (e) => e.pointerId === 1);
        controller.setInkDelegate(ink);
        pinchOut();
        expect(onInkDown).toHaveBeenCalledTimes(1);
        expect(onInkCancel).toHaveBeenCalledTimes(1);
        expect(onPinch).toHaveBeenCalledTimes(2);
        expect(onPinchEnd).toHaveBeenCalledTimes(1);
        expect(callbacks.onZoomBy).not.toHaveBeenCalled();
        expect(callbacks.onPan).not.toHaveBeenCalled();
    });

    it('does not ink a third Finger-draw touch during a claimed pinch', () => {
        controller = new GestureController(el, callbacks);
        const { ink, onPinch, onInkDown } = delegate(true, () => true);
        controller.setInkDelegate(ink);
        el.dispatchEvent(touch('pointerdown', 1, 100, 100));
        el.dispatchEvent(touch('pointerdown', 2, 200, 100));
        el.dispatchEvent(touch('pointermove', 2, 250, 100));
        expect(onPinch).toHaveBeenCalled();
        el.dispatchEvent(touch('pointerdown', 3, 150, 180));
        expect(onInkDown).toHaveBeenCalledTimes(1);
        expect(callbacks.onZoomBy).not.toHaveBeenCalled();
    });
});
