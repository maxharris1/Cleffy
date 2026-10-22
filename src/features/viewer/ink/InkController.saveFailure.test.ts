import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { InkController } from '@/features/viewer/ink/InkController';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';

/**
 * SF-1: InkController's edits are fire-and-forget (a pen-up does not wait on
 * IndexedDB). When the write fails, the stroke must stay on the page, the
 * store must flag it for the viewer's banner, and nothing may surface as an
 * unhandled rejection.
 */

const DOC = 'local-ink-save-failure';
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

/** A 2D context that keeps what the canvas would show. */
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

let db: ScribblerDb;
let store: AnnotationStore;
let ink: InkController;
let page: ReturnType<typeof fakeCanvas>;
const unhandled = vi.fn();

const drawStroke = (x: number, y: number) => {
    ink.delegate.onInkDown(pointer(x, y));
    ink.delegate.onInkMove(pointer(x + 20, y + 5));
    ink.delegate.onInkMove(pointer(x + 40, y));
    ink.delegate.onInkUp(pointer(x + 40, y));
};

beforeEach(async () => {
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    unhandled.mockClear();
    process.on('unhandledRejection', unhandled);
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
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
    page = fakeCanvas(PAGE_W, PAGE_H);
    registry.register(0, { committed: page.canvas, live: fakeCanvas(PAGE_W, PAGE_H).canvas });
    useViewerStore.getState().setTool('pen');
});

afterEach(async () => {
    process.off('unhandledRejection', unhandled);
    ink.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await store.retryFailedPersist();
});

describe('InkController when the device cannot store a mark', () => {
    it('keeps the stroke drawn, flags it, and raises no unhandled rejection', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(
            new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
        );

        drawStroke(300, 300);
        await settle();

        const [mark] = [...store.getPage(0).values()];
        expect(mark).toBeDefined();
        expect(page.shown).toHaveLength(1);
        expect(store.hasPersistFailure(mark!.id)).toBe(true);
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('an eraser pass whose write fails does the same', async () => {
        drawStroke(300, 300);
        await settle();
        const [mark] = [...store.getPage(0).values()];
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(
            new DOMException('The quota has been exceeded.', 'QuotaExceededError'),
        );

        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        ink.delegate.onInkUp(pointer(330, 304));
        await settle();

        expect(store.get(mark!.id)?.deletedAt).not.toBeNull();
        expect(store.hasPersistFailure(mark!.id)).toBe(true);
        expect(unhandled).not.toHaveBeenCalled();
    });
});
