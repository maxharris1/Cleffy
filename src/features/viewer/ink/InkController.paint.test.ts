import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { InkController } from '@/features/viewer/ink/InkController';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';
import type { Annotation } from '@/types/models';

const DOC = 'local-paint-doc';
const PAGE_W = 1000;
const PAGE_H = 1300;
/** More marks than the old 400-entry path cache held. */
const BUSY = 450;

const layout: DocumentLayout = {
    layouts: [{ top: 0, left: 0, width: PAGE_W, height: PAGE_H }],
    contentWidth: PAGE_W,
    contentHeight: PAGE_H,
};

/** jsdom has no Path2D; this one counts how many paths were built. */
let pathsBuilt = 0;
class FakePath2D {
    constructor(readonly d = '') {
        pathsBuilt += 1;
    }
}

/**
 * A 2D context that keeps a display list: what the canvas would show, in
 * draw order. clearRect empties it.
 */
const fakeCanvas = (width: number, height: number) => {
    const shown: string[] = [];
    let style = '';
    const ctx = {
        clears: 0,
        fills: 0,
        save: () => undefined,
        restore: () => undefined,
        clearRect: () => {
            ctx.clears += 1;
            shown.length = 0;
        },
        fill: (path: FakePath2D) => {
            ctx.fills += 1;
            shown.push(`${style} ${path.d}`);
        },
        set fillStyle(value: string) {
            style = value;
        },
        get fillStyle() {
            return style;
        },
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
    return { canvas, ctx, shown };
};

const pointer = (clientX: number, clientY: number) =>
    ({ clientX, clientY, pointerType: 'pen', pressure: 0.5 }) as unknown as PointerEvent;

const stroke = (id: string, i: number, color = '#1d4ed8'): Annotation => {
    const x = 0.05 + (i % 30) * 0.03;
    const y = 0.05 + Math.floor(i / 30) * 0.05;
    const now = new Date().toISOString();
    return {
        id,
        docId: DOC,
        page: 0,
        kind: 'stroke',
        color,
        payload: { pts: [x, y, 0.5, x + 0.01, y + 0.004, 0.5, x + 0.02, y, 0.5], w: 0.003 },
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        seq: 0,
    };
};

/** Let the store's async commit chain (snapshot check, Dexie write, notify) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let store: AnnotationStore;
let ink: InkController;
let page: ReturnType<typeof fakeCanvas>;
let registry: CanvasRegistry;

const makeController = (onRegistry: CanvasRegistry) =>
    new InkController({
        store,
        registry: onRegistry,
        isReadOnly: () => false,
        getView: () => ({ scale: 1, scrollX: 0, scrollY: 0 }),
        getLayout: () => layout,
        toLocal: (e) => ({ x: e.clientX, y: e.clientY }),
        onTextIntent: () => undefined,
        onFingeringSelect: () => undefined,
    });

/** What a freshly mounted page would show for the store's current marks. */
const fullRepaint = (): string[] => {
    const fresh = fakeCanvas(PAGE_W, PAGE_H);
    const otherRegistry = new CanvasRegistry();
    const other = makeController(otherRegistry);
    otherRegistry.register(0, { committed: fresh.canvas, live: fakeCanvas(0, 0).canvas });
    other.destroy();
    return [...fresh.shown];
};

const drawStroke = (x: number, y: number) => {
    ink.delegate.onInkDown(pointer(x, y));
    ink.delegate.onInkMove(pointer(x + 20, y + 5));
    ink.delegate.onInkMove(pointer(x + 40, y));
    ink.delegate.onInkUp(pointer(x + 40, y));
};

beforeEach(async () => {
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    pathsBuilt = 0;
    const db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
    await store.createMany(Array.from({ length: BUSY }, (_, i) => stroke(`m${i}`, i)));
    registry = new CanvasRegistry();
    ink = makeController(registry);
    page = fakeCanvas(PAGE_W, PAGE_H);
    registry.register(0, { committed: page.canvas, live: fakeCanvas(PAGE_W, PAGE_H).canvas });
    useViewerStore.getState().setTool('pen');
});

afterEach(() => {
    ink.destroy();
    vi.unstubAllGlobals();
});

describe('InkController: committed canvas repaints only what changed', () => {
    it('pen-up on a busy page draws the new stroke alone, at once', async () => {
        expect(page.shown).toHaveLength(BUSY);
        const { clears, fills } = page.ctx;
        pathsBuilt = 0;

        drawStroke(300, 300);
        // Painted synchronously at pen-up: the ink never blinks out while
        // the IndexedDB write is in flight.
        expect(page.shown).toHaveLength(BUSY + 1);

        await settle();
        expect(page.ctx.clears).toBe(clears);
        expect(page.ctx.fills).toBe(fills + 1);
        // One path for the new stroke (the live canvas builds its own preview
        // per frame; none here, rAF is stubbed). The old cache rebuilt all.
        expect(pathsBuilt).toBe(1);
        expect(page.shown).toEqual(fullRepaint());
    });

    it('a server ack or the realtime echo of a stroke repaints nothing', async () => {
        drawStroke(300, 300);
        await settle();
        const [mine] = [...store.getPage(0).values()].slice(-1);
        const { clears, fills } = page.ctx;

        await store.markSynced(mine!.id, 'user-1');
        // The echo: the server's copy of the same stroke, a new object with a seq.
        const echo: Annotation = {
            ...mine!,
            createdBy: 'user-1',
            seq: 9001,
            payload: JSON.parse(JSON.stringify(mine!.payload)) as Annotation['payload'],
        };
        await store.applyRemoteBatch([echo], new Set());
        await settle();

        expect(page.ctx.clears).toBe(clears);
        expect(page.ctx.fills).toBe(fills);
        expect(page.shown).toEqual(fullRepaint());
    });

    it('a peer stroke landing appends; an erase repaints from cached paths', async () => {
        await store.applyRemoteBatch([{ ...stroke('peer', 7, '#dc2626'), seq: 5 }], new Set());
        expect(page.shown).toHaveLength(BUSY + 1);
        expect(page.shown).toEqual(fullRepaint());

        const fillsBefore = page.ctx.fills;
        pathsBuilt = 0;
        await store.delete('m10');
        expect(page.shown).toHaveLength(BUSY);
        expect(page.ctx.fills - fillsBefore).toBe(BUSY);
        expect(pathsBuilt).toBe(0);
        expect(page.shown).toEqual(fullRepaint());
    });

    it('a recolour or undo repaints the page in store order', async () => {
        await store.update('m3', { color: '#16a34a' });
        expect(page.shown).toEqual(fullRepaint());
        drawStroke(200, 200);
        await settle();
        await store.undoLast();
        expect(page.shown).toHaveLength(BUSY);
        expect(page.shown).toEqual(fullRepaint());
        await store.undoLast();
        expect(page.shown).toEqual(fullRepaint());
    });

    it('a re-registered canvas (zoom, remount) is painted whole', () => {
        const next = fakeCanvas(PAGE_W * 2, PAGE_H * 2);
        registry.register(0, { committed: next.canvas, live: fakeCanvas(PAGE_W * 2, PAGE_H * 2).canvas });
        expect(next.shown).toHaveLength(BUSY);
    });

    it('a canvas whose 2D context was lost and restored is painted again', async () => {
        await settle();
        // The browser dropped the bitmap (context loss): the canvas is blank,
        // and no store change is coming to heal it.
        page.ctx.clearRect();
        expect(page.shown).toHaveLength(0);
        page.canvas.dispatchEvent(new Event('contextrestored'));
        expect(page.shown).toHaveLength(BUSY);
        expect(page.shown).toEqual(fullRepaint());
    });

    it('a webfont finishing loading repaints every page (prose notes drawn in a fallback face)', () => {
        const fonts = new EventTarget();
        Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
        try {
            ink.destroy();
            ink = makeController(registry);
            registry.register(0, { committed: page.canvas, live: fakeCanvas(PAGE_W, PAGE_H).canvas });
            const { clears } = page.ctx;
            fonts.dispatchEvent(new Event('loadingdone'));
            expect(page.ctx.clears).toBe(clears + 1);
            expect(page.shown).toHaveLength(BUSY);
        } finally {
            Reflect.deleteProperty(document, 'fonts');
        }
    });

    it('a canvas of the same width but a new height rebuilds every path', () => {
        // A streamed first open lays every page out at page 1's size until
        // the download ends; a page of that width but another height then
        // gets a canvas of the same bitmap width. y scales by the height, so
        // the paths built for the provisional height are wrong for it.
        const before = [...page.shown];
        pathsBuilt = 0;
        const taller = fakeCanvas(PAGE_W, PAGE_H + 200);
        registry.register(0, { committed: taller.canvas, live: fakeCanvas(PAGE_W, PAGE_H + 200).canvas });
        expect(pathsBuilt).toBe(BUSY);
        expect(taller.shown).toHaveLength(BUSY);
        expect(taller.shown).not.toEqual(before);
    });
});
