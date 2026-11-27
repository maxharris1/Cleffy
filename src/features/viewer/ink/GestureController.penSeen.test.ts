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
import { useViewerStore } from '@/state/store';

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
let nextPointerId = 1;

const swipe = (pointerType: 'pen' | 'touch', target: Element = el) => {
    const pointerId = nextPointerId++;
    const at = (type: string, x: number) =>
        new PointerEvent(type, { pointerId, pointerType, clientX: x, clientY: 300, button: 0, bubbles: true });
    target.dispatchEvent(at('pointerdown', 100));
    el.dispatchEvent(at('pointermove', 140));
    el.dispatchEvent(at('pointermove', 180));
    el.dispatchEvent(at('pointerup', 180));
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
    gestures = new GestureController(el, {
        onPan,
        onZoomBy: () => undefined,
        onWheelScroll: () => undefined,
        onGestureEnd: () => undefined,
    });
    gestures.setInkDelegate(ink.delegate);
};

afterEach(() => {
    if (gestures) {
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
    it.each([true, false])(
        'scrolls after a stylus tapped the viewer header before the viewport mounted, Finger-draw %s',
        async (fingerDraws) => {
            const title = screen.getByRole('button', { name: 'Nocturne' });
            fireEvent.pointerDown(title, { pointerType: 'pen' });
            fireEvent.pointerUp(title, { pointerType: 'pen' });

            await mountViewport();
            useViewerStore.setState({ fingerDraws });
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
