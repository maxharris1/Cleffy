import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { InkController } from '@/features/viewer/ink/InkController';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';

const DOC = 'local-ink-gesture-tool';
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

const fakeCanvas = (width: number, height: number) => {
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
        width,
        height,
        getContext: () => ctx,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
    } as unknown as HTMLCanvasElement;
    return { canvas, shown };
};

const pointer = (clientX: number, clientY: number) =>
    ({ clientX, clientY, pointerType: 'pen', pressure: 0.5 }) as unknown as PointerEvent;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let store: AnnotationStore;
let ink: InkController;
let page: ReturnType<typeof fakeCanvas>;

const drawStroke = (x: number, y: number) => {
    ink.delegate.onInkDown(pointer(x, y));
    ink.delegate.onInkMove(pointer(x + 20, y + 5));
    ink.delegate.onInkMove(pointer(x + 40, y));
    ink.delegate.onInkUp(pointer(x + 40, y));
};

beforeEach(async () => {
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
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
    page = fakeCanvas(PAGE_W, PAGE_H);
    registry.register(0, { committed: page.canvas, live: fakeCanvas(PAGE_W, PAGE_H).canvas });
    useViewerStore.getState().setTool('pen');
});

afterEach(() => {
    ink.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const strokesShown = () => page.shown.length;

const startErasingSecondStroke = async () => {
    drawStroke(100, 300);
    drawStroke(300, 300);
    await settle();
    expect(strokesShown()).toBe(2);
    useViewerStore.getState().setTool('eraser');
    ink.delegate.onInkDown(pointer(310, 302));
    ink.delegate.onInkMove(pointer(330, 304));
    await settle();
    expect(strokesShown()).toBe(1);
};

describe('InkController ends a gesture with the tool that began it', () => {
    it('undo restores an erase whose tool was put down before the stylus lifted', async () => {
        await startErasingSecondStroke();
        useViewerStore.getState().setTool(null);
        ink.delegate.onInkMove(pointer(335, 304));
        ink.delegate.onInkUp(pointer(335, 304));
        await settle();

        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(2);
    });

    it('closes the erase as its own undo step when the tool is switched mid-gesture', async () => {
        await startErasingSecondStroke();
        useViewerStore.getState().setTool('pen');
        ink.delegate.onInkUp(pointer(330, 304));
        drawStroke(500, 300);
        await settle();
        expect(strokesShown()).toBe(2);

        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(1);
        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(2);
    });

    it('commits a pen stroke whose tool was switched before the pen lifted', async () => {
        ink.delegate.onInkDown(pointer(300, 300));
        ink.delegate.onInkMove(pointer(320, 305));
        ink.delegate.onInkMove(pointer(340, 300));
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkUp(pointer(340, 300));
        await settle();
        expect(strokesShown()).toBe(1);
    });
});
