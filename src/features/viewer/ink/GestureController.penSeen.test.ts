// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { GestureController, type GestureCallbacks } from '@/features/viewer/ink/GestureController';
import { InkController } from '@/features/viewer/ink/InkController';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { trackPointerKinds, useViewerStore } from '@/state/store';
import { useViewport } from '@/test/touchLayout';

const PAGE_W = 1000;
const PAGE_H = 1300;

const layout: DocumentLayout = {
    layouts: [{ top: 0, left: 0, width: PAGE_W, height: PAGE_H }],
    contentWidth: PAGE_W,
    contentHeight: PAGE_H,
};

class FakePath2D {
    constructor(readonly d = '') {}
}

const fakeCanvas = () => {
    const shown: string[] = [];
    const ctx = {
        save: () => undefined,
        restore: () => undefined,
        clearRect: () => {
            shown.length = 0;
        },
        fill: (path: FakePath2D) => {
            shown.push(path.d);
        },
        fillStyle: '',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
    };
    const events = new EventTarget();
    const canvas = {
        width: PAGE_W,
        height: PAGE_H,
        getContext: () => ctx,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
    } as unknown as HTMLCanvasElement;
    return { canvas, shown };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let clock: number;
let el: HTMLDivElement;
let page: ReturnType<typeof fakeCanvas>;
let ink: InkController;
let gestures: GestureController | null;
let onPan: ReturnType<typeof vi.fn<GestureCallbacks['onPan']>>;
let onZoomBy: ReturnType<typeof vi.fn<GestureCallbacks['onZoomBy']>>;
let stopTracking: () => void;
let nextPointerId = 1;

const swipe = (pointerType: 'pen' | 'touch', target: Element = el, pauseMs = 1000) => {
    const pointerId = nextPointerId++;
    const at = (type: string, x: number) =>
        new PointerEvent(type, { pointerId, pointerType, clientX: x, clientY: 300, button: 0, bubbles: true });
    target.dispatchEvent(at('pointerdown', 100));
    el.dispatchEvent(at('pointermove', 140));
    el.dispatchEvent(at('pointermove', 180));
    el.dispatchEvent(at('pointerup', 180));
    clock += pauseMs;
};

const finger = (type: string, pointerId: number, x: number, y: number) =>
    new PointerEvent(type, { pointerId, pointerType: 'touch', clientX: x, clientY: y, button: 0, bubbles: true });

const twoFingerPinch = (firstX: number) => {
    const [a, b] = [nextPointerId++, nextPointerId++];
    el.dispatchEvent(finger('pointerdown', a, firstX, 300));
    el.dispatchEvent(finger('pointermove', a, firstX + 10, 300));
    el.dispatchEvent(finger('pointerdown', b, firstX + 100, 300));
    el.dispatchEvent(finger('pointermove', b, firstX + 160, 320));
    el.dispatchEvent(finger('pointermove', b, firstX + 220, 340));
    el.dispatchEvent(finger('pointerup', b, firstX + 220, 340));
    el.dispatchEvent(finger('pointerup', a, firstX + 10, 300));
    clock += 1000;
};

beforeEach(() => {
    clock = 10_000;
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    useViewerStore.setState({ tool: 'pen', fingerDraws: true, penSeen: false, touchSeen: false });
    gestures = null;
    render(
        createElement(
            MemoryRouter,
            null,
            createElement(ViewerHeader, { backTo: '/library', backLabel: 'Back to library', title: 'Nocturne' }),
        ),
    );
});

const mountViewport = async () => {
    const store = new AnnotationStore(new ScribblerDb(`test-${crypto.randomUUID()}`), 'local-pen-seen');
    await store.load();
    const registry = new CanvasRegistry();
    ink = new InkController({
        store,
        registry,
        isReadOnly: () => false,
        panKeyHeld: () => false,
        getView: () => ({ scale: 1, scrollX: 0, scrollY: 0 }),
        getLayout: () => layout,
        toLocal: (e) => ({ x: e.clientX, y: e.clientY }),
        onTextIntent: () => undefined,
        onFingeringSelect: () => undefined,
    });
    page = fakeCanvas();
    registry.register(0, { committed: page.canvas, live: fakeCanvas().canvas });

    el = document.createElement('div');
    el.setPointerCapture = () => undefined;
    document.body.appendChild(el);
    onPan = vi.fn<GestureCallbacks['onPan']>();
    onZoomBy = vi.fn<GestureCallbacks['onZoomBy']>();
    stopTracking = trackPointerKinds(document);
    gestures = new GestureController(el, {
        onPan,
        onZoomBy,
        onWheelScroll: () => undefined,
        onGestureEnd: () => undefined,
    });
    gestures.setInkDelegate(ink.delegate);
};

afterEach(() => {
    if (gestures) {
        stopTracking();
        gestures.destroy();
        ink.destroy();
        el.remove();
    }
    cleanup();
    useViewerStore.setState({ penSeen: false, touchSeen: false, fingerDraws: false });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('a finger once a stylus has been seen', () => {
    beforeEach(mountViewport);

    it('draws with Finger-draw on while no stylus has been seen', async () => {
        swipe('touch');
        await settle();
        expect(page.shown).toHaveLength(1);
        expect(onPan).not.toHaveBeenCalled();
    });

    it('scrolls after a stylus stroke, while the stylus keeps drawing', async () => {
        swipe('pen');
        await settle();
        expect(page.shown).toHaveLength(1);

        swipe('touch');
        await settle();
        expect(page.shown).toHaveLength(1);
        expect(onPan).toHaveBeenCalled();

        swipe('pen');
        await settle();
        expect(page.shown).toHaveLength(2);
    });

    it('scrolls after the stylus only tapped the toolbar', async () => {
        const toolbar = document.createElement('button');
        toolbar.setAttribute('data-ui-overlay', '');
        el.appendChild(toolbar);
        swipe('pen', toolbar);

        swipe('touch');
        await settle();
        expect(page.shown).toHaveLength(0);
        expect(onPan).toHaveBeenCalled();
    });
});

describe('a stylus seen before the viewport mounts', () => {
    beforeEach(() => useViewport({ width: 1024, coarse: true }));

    it.each([true, false])(
        'scrolls after a stylus tapped the viewer header before the viewport mounted, Finger-draw %s',
        async (fingerDraws) => {
            useViewerStore.setState({ fingerDraws });
            expect(useViewerStore.getState().fingerDraws).toBe(fingerDraws);

            const title = screen.getByRole('button', { name: 'Nocturne' });
            fireEvent.pointerDown(title, { pointerType: 'pen' });
            fireEvent.pointerUp(title, { pointerType: 'pen' });
            expect(useViewerStore.getState().penSeen).toBe(true);

            await mountViewport();
            expect(useViewerStore.getState().fingerDraws).toBe(fingerDraws);
            swipe('touch');
            await settle();
            expect(page.shown).toHaveLength(0);
            expect(onPan).toHaveBeenCalled();
        },
    );
});

describe('a touch observed in the viewer', () => {
    beforeEach(mountViewport);

    it('is recorded on the first finger, before any stylus', () => {
        useViewerStore.setState({ fingerDraws: false });
        expect(useViewerStore.getState().touchSeen).toBe(false);
        swipe('touch');
        expect(useViewerStore.getState().touchSeen).toBe(true);
        expect(onPan).toHaveBeenCalled();
    });
});

describe('two fingers in Draw with a tool in hand', () => {
    beforeEach(mountViewport);

    it('pan and zoom the page and leave no stroke', async () => {
        twoFingerPinch(100);
        await settle();
        expect(page.shown).toHaveLength(0);
        expect(onPan).toHaveBeenCalled();
        expect(onZoomBy).toHaveBeenCalled();
    });

    it('pan and zoom when the first finger landed off the page', async () => {
        const [a, b] = [nextPointerId++, nextPointerId++];
        el.dispatchEvent(finger('pointerdown', a, 1100, 300));
        el.dispatchEvent(finger('pointerdown', b, 900, 300));
        el.dispatchEvent(finger('pointermove', b, 800, 320));
        el.dispatchEvent(finger('pointermove', b, 700, 340));
        el.dispatchEvent(finger('pointerup', b, 700, 340));
        el.dispatchEvent(finger('pointerup', a, 1100, 300));
        await settle();
        expect(page.shown).toHaveLength(0);
        expect(onZoomBy).toHaveBeenCalled();
    });
});

describe('successive finger contacts in a finger-only session', () => {
    beforeEach(mountViewport);

    it('draws a second stroke begun 100ms after the first', async () => {
        swipe('touch', el, 100);
        swipe('touch', el, 100);
        await settle();
        expect(page.shown).toHaveLength(2);
    });

    it('pans right after switching from Draw to Scroll', async () => {
        swipe('touch', el, 100);
        useViewerStore.setState({ fingerDraws: false });
        swipe('touch');
        await settle();
        expect(page.shown).toHaveLength(1);
        expect(onPan).toHaveBeenCalled();
    });
});
