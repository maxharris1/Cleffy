import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { InkController, TEXT_DRAG_SYNC_MS, type TextIntent } from '@/features/viewer/ink/InkController';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { useViewerStore } from '@/state/store';
import type { Annotation, TextPayload } from '@/types/models';

const DOC = 'local-drag-doc';
const PAGE_W = 1000;
const PAGE_H = 1300;

const layout: DocumentLayout = {
    layouts: [{ top: 0, left: 0, width: PAGE_W, height: PAGE_H }],
    contentWidth: PAGE_W,
    contentHeight: PAGE_H,
};

/** Canvas stand-ins: hit-testing only needs the committed bitmap size. */
const fakeCanvas = (width: number, height: number) =>
    ({ width, height, getContext: () => null }) as unknown as HTMLCanvasElement;

const pointer = (clientX: number, clientY: number) =>
    ({ clientX, clientY, pointerType: 'pen', pressure: 0.5 }) as unknown as PointerEvent;

const textNote = (id: string, x: number, y: number, text: string, extra: Partial<TextPayload> = {}): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'text',
    color: '#1f2937',
    payload: { x, y, text, size: 0.02, ...extra },
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    seq: 0,
});

let store: AnnotationStore;
let ink: InkController;
let intents: TextIntent[];

/** Let the store's async update chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const payloadOf = (id: string) => store.get(id)!.payload as TextPayload;

beforeEach(async () => {
    const db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
    const registry = new CanvasRegistry();
    registry.register(0, { committed: fakeCanvas(PAGE_W, PAGE_H), live: fakeCanvas(0, 0) });
    intents = [];
    ink = new InkController({
        store,
        registry,
        isReadOnly: () => false,
        getView: () => ({ scale: 1, scrollX: 0, scrollY: 0 }),
        getLayout: () => layout,
        toLocal: (e) => ({ x: e.clientX, y: e.clientY }),
        onTextIntent: (intent) => intents.push(intent),
        onFingeringSelect: () => undefined,
    });
    useViewerStore.getState().setTool('text');
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
    ink.destroy();
    vi.useRealTimers();
    useViewerStore.getState().setTool('pen');
});

describe('InkController text tool: tap edits, drag moves', () => {
    it('press on a note + move past the tap threshold patches x/y, keeping text and size', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'use wrist', { hw: 1 }));
        // Press inside the note's hit box (x 300–408, y 650–675 in page px).
        ink.delegate.onInkDown(pointer(310, 655));
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        ink.delegate.onInkMove(pointer(360, 705));
        ink.delegate.onInkUp(pointer(410, 755));
        await settle();

        const moved = payloadOf('note');
        expect(moved.x).toBeCloseTo(0.4, 5);
        expect(moved.y).toBeCloseTo(0.5 + 100 / PAGE_H, 5);
        expect(moved.text).toBe('use wrist');
        expect(moved.size).toBe(0.02);
        expect(moved.hw).toBe(1);
        expect(intents).toHaveLength(0);
    });

    it('is ONE undo step even though the drag committed several live positions', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        ink.delegate.onInkDown(pointer(305, 655));
        for (let i = 1; i <= 5; i++) {
            vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
            ink.delegate.onInkMove(pointer(305 + i * 20, 655 + i * 10));
        }
        ink.delegate.onInkUp(pointer(405, 705));
        await settle();
        expect(payloadOf('note').x).toBeCloseTo(0.4, 5);

        // Several update ops were synced live…
        expect(store.canUndo).toBe(true);
        await store.undoLast();
        // …but one undo puts the note straight back.
        expect(payloadOf('note').x).toBeCloseTo(0.3, 5);
        expect(payloadOf('note').y).toBeCloseTo(0.5, 5);
        expect(store.canRedo).toBe(true);
    });

    it('throttles intermediate commits to the live-sync interval', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        const update = vi.spyOn(store, 'update');
        ink.delegate.onInkDown(pointer(305, 655));
        // Three moves inside one sync window → one commit; pointer-up adds the final one.
        ink.delegate.onInkMove(pointer(325, 655));
        ink.delegate.onInkMove(pointer(335, 655));
        ink.delegate.onInkMove(pointer(345, 655));
        ink.delegate.onInkUp(pointer(355, 655));
        await settle();
        expect(update).toHaveBeenCalledTimes(2);
        expect(payloadOf('note').x).toBeCloseTo(0.35, 5);
    });

    it('moves the whole converted note as one object and leaves other notes alone', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'use wrist', { hw: 1 }));
        await store.create(textNote('other', 0.3, 0.7, 'slow'));
        ink.delegate.onInkDown(pointer(320, 660));
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        ink.delegate.onInkMove(pointer(320, 600));
        ink.delegate.onInkUp(pointer(320, 600));
        await settle();
        expect(store.getPage(0).size).toBe(2);
        expect(payloadOf('note').text).toBe('use wrist');
        expect(payloadOf('note').y).toBeCloseTo(0.5 - 60 / PAGE_H, 5);
        expect(payloadOf('other')).toMatchObject({ x: 0.3, y: 0.7, text: 'slow' });
    });

    it('a tap without movement still opens the editor on the existing note', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        ink.delegate.onInkDown(pointer(310, 655));
        ink.delegate.onInkMove(pointer(312, 656));
        ink.delegate.onInkUp(pointer(312, 656));
        await settle();
        expect(intents).toHaveLength(1);
        expect(intents[0]!.existing?.id).toBe('note');
        expect(payloadOf('note')).toMatchObject({ x: 0.3, y: 0.5 });
        expect(store.canUndo).toBe(true); // only the create
        await store.undoLast();
        expect(store.getPage(0).size).toBe(0);
    });

    it('a tap on empty paper opens a new-note editor; dragging empty paper does nothing', async () => {
        ink.delegate.onInkDown(pointer(500, 500));
        ink.delegate.onInkUp(pointer(500, 500));
        expect(intents).toHaveLength(1);
        expect(intents[0]!.existing).toBeNull();

        ink.delegate.onInkDown(pointer(500, 500));
        ink.delegate.onInkMove(pointer(600, 600));
        ink.delegate.onInkUp(pointer(600, 600));
        expect(intents).toHaveLength(1);
        expect(store.canUndo).toBe(false);
    });
});
