import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_MUSIC_TEXT_SIZE, MAX_TEXT_SIZE, MIN_TEXT_SIZE, measureInkText } from '@/features/import/textFit';
import type { DocumentLayout } from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import {
    InkController,
    RESIZE_HANDLE_HIT_CSS,
    TEXT_DRAG_SYNC_MS,
    type TextIntent,
} from '@/features/viewer/ink/InkController';
import { textBoundsNorm, textDrawSpec } from '@/features/viewer/ink/musicFont';
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

    it('live drag updates keep a peer edit of text/hw instead of the pointer-down snapshot', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf', { hw: 1 }));
        ink.delegate.onInkDown(pointer(305, 655));
        await store.update('note', { payload: { ...payloadOf('note'), text: 'use wrist', hw: undefined } });
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        ink.delegate.onInkMove(pointer(355, 655));
        ink.delegate.onInkUp(pointer(355, 655));
        await settle();
        const moved = payloadOf('note');
        expect(moved.x).toBeCloseTo(0.35, 5);
        expect(moved.text).toBe('use wrist');
        expect(moved.hw).toBeUndefined();
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

    it('pressing a note selects it and exposes a corner handle at its glyph bounds', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf', { hw: 1 }));
        expect(ink.getTextSelection()).toBeNull();
        ink.delegate.onInkDown(pointer(305, 655));
        ink.delegate.onInkUp(pointer(305, 655));
        const selection = ink.getTextSelection();
        expect(selection?.id).toBe('note');
        const [minX, minY, maxX, maxY] = selection!.bounds;
        expect(minX).toBe(0.3);
        expect(minY).toBeGreaterThanOrEqual(0.5);
        expect(selection!.handle).toEqual({ nx: maxX, ny: maxY });
        // Pressing empty paper deselects; switching tools deselects too.
        ink.delegate.onInkDown(pointer(800, 200));
        ink.delegate.onInkUp(pointer(800, 200));
        expect(ink.getTextSelection()).toBeNull();
        ink.delegate.onInkDown(pointer(305, 655));
        ink.delegate.onInkUp(pointer(305, 655));
        expect(ink.getTextSelection()).not.toBeNull();
        useViewerStore.getState().setTool('pen');
        expect(ink.getTextSelection()).toBeNull();
    });
});

describe('InkController text tool: resize', () => {
    /** Select a note and return its handle in viewport px (scale 1, no scroll). */
    const select = async (id: string, px: number, py: number) => {
        ink.delegate.onInkDown(pointer(px, py));
        ink.delegate.onInkUp(pointer(px, py));
        await settle();
        const selection = ink.getTextSelection();
        expect(selection?.id).toBe(id);
        // The selecting tap opened the editor; the gestures under test must not.
        intents.length = 0;
        const [minX, minY] = selection!.bounds;
        return {
            handle: { x: selection!.handle.nx * PAGE_W, y: selection!.handle.ny * PAGE_H },
            anchor: { x: minX * PAGE_W, y: minY * PAGE_H },
        };
    };

    /** Drag the handle so its distance from the anchor is multiplied by `factor`. */
    const dragHandleBy = async (
        handle: { x: number; y: number },
        anchor: { x: number; y: number },
        factor: number,
        steps = 3,
    ) => {
        ink.delegate.onInkDown(pointer(handle.x, handle.y));
        for (let i = 1; i <= steps; i++) {
            const f = 1 + ((factor - 1) * i) / steps;
            vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
            ink.delegate.onInkMove(pointer(anchor.x + (handle.x - anchor.x) * f, anchor.y + (handle.y - anchor.y) * f));
        }
        ink.delegate.onInkUp(
            pointer(anchor.x + (handle.x - anchor.x) * factor, anchor.y + (handle.y - anchor.y) * factor),
        );
        await settle();
    };

    it('dragging the handle scales size about the visual top-left', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'use wrist', { hw: 1 }));
        const aspect = PAGE_H / PAGE_W;
        const before = textBoundsNorm(payloadOf('note'), aspect);
        const { handle, anchor } = await select('note', 310, 655);
        await dragHandleBy(handle, anchor, 1.5);
        const scaled = payloadOf('note');
        expect(scaled.size).toBeCloseTo(0.03, 5);
        expect(scaled.x).toBe(0.3);
        expect(scaled.text).toBe('use wrist');
        expect(scaled.hw).toBe(1);
        const after = textBoundsNorm(scaled, aspect);
        expect(after[1]).toBeCloseTo(before[1], 5);
        const spec = textDrawSpec('use wrist', true);
        const metrics = measureInkText(spec.glyphs, { family: spec.family, style: spec.style });
        expect(scaled.y).toBeCloseTo(0.5 + (metrics.topInset * (0.02 - 0.03)) / aspect, 5);
        const selection = ink.getTextSelection()!;
        expect(selection.handle.nx * PAGE_W).toBeCloseTo(anchor.x + (handle.x - anchor.x) * 1.5, 3);
        expect(intents).toHaveLength(0);
    });

    it('shrinks too, and is ONE undo step across the live-synced commits', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        const { handle, anchor } = await select('note', 305, 655);
        const update = vi.spyOn(store, 'update');
        await dragHandleBy(handle, anchor, 0.5, 4);
        expect(payloadOf('note').size).toBeCloseTo(0.01, 5);
        expect(update.mock.calls.length).toBeGreaterThan(1);
        await store.undoLast();
        expect(payloadOf('note').size).toBe(0.02);
        await store.redoLast();
        expect(payloadOf('note').size).toBeCloseTo(0.01, 5);
    });

    it('clamps: typed text tops out at MAX_TEXT_SIZE, a music glyph at MAX_MUSIC_TEXT_SIZE, both floor at MIN', async () => {
        await store.create(textNote('typed', 0.1, 0.1, 'mf'));
        await store.create(textNote('music', 0.1, 0.6, 'mf', { hw: 1 }));

        let sel = await select('typed', 103, 133);
        await dragHandleBy(sel.handle, sel.anchor, 40);
        expect(payloadOf('typed').size).toBe(MAX_TEXT_SIZE);

        sel = await select('music', 103, 790);
        await dragHandleBy(sel.handle, sel.anchor, 40);
        expect(payloadOf('music').size).toBe(MAX_MUSIC_TEXT_SIZE);

        sel = await select('typed', 103 + 20, 133 + 20);
        await dragHandleBy(sel.handle, sel.anchor, 0.001);
        expect(payloadOf('typed').size).toBe(MIN_TEXT_SIZE);
    });

    it('the handle press wins over the note under it, and a tap on the handle changes nothing', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        const { handle } = await select('note', 305, 655);
        ink.delegate.onInkDown(pointer(handle.x + RESIZE_HANDLE_HIT_CSS / 2, handle.y));
        ink.delegate.onInkUp(pointer(handle.x + RESIZE_HANDLE_HIT_CSS / 2, handle.y));
        await settle();
        expect(payloadOf('note').size).toBe(0.02);
        expect(intents).toHaveLength(0);
        // Only the create is on the undo stack.
        await store.undoLast();
        expect(store.getPage(0).size).toBe(0);
    });

    it('a pinch on a selected note scales it (cumulative), as one undo step; unselected pinches are not claimed', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf', { hw: 1 }));
        expect(ink.delegate.onPinch!(1.2)).toBe(false);

        await select('note', 305, 655);
        expect(ink.delegate.onPinch!(1.25)).toBe(true);
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        expect(ink.delegate.onPinch!(1.6)).toBe(true);
        ink.delegate.onPinchEnd!();
        await settle();
        expect(payloadOf('note').size).toBeCloseTo(0.02 * 1.25 * 1.6, 6);
        expect(payloadOf('note').x).toBe(0.3);

        await store.undoLast();
        expect(payloadOf('note').size).toBe(0.02);
    });

    it('a pinch is not claimed for other tools or read-only viewers', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        await select('note', 305, 655);
        useViewerStore.getState().setTool('pan');
        expect(ink.delegate.onPinch!(1.2)).toBe(false);
    });

    it('a pinch does not steal an in-flight handle drag or close its undo batch', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf', { hw: 1 }));
        const { handle, anchor } = await select('note', 305, 655);
        ink.delegate.onInkDown(pointer(handle.x, handle.y));
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        ink.delegate.onInkMove(pointer(anchor.x + (handle.x - anchor.x) * 2, anchor.y + (handle.y - anchor.y) * 2));
        expect(ink.delegate.onPinch!(1.5)).toBe(false);
        ink.delegate.onPinchEnd!();
        ink.delegate.onInkUp(pointer(anchor.x + (handle.x - anchor.x) * 2, anchor.y + (handle.y - anchor.y) * 2));
        await settle();
        expect(payloadOf('note').size).toBeCloseTo(0.04, 5);
        await store.undoLast();
        expect(payloadOf('note').size).toBe(0.02);
    });

    it('keeps the selection on a miss so Finger-draw can pinch from empty paper', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        await select('note', 305, 655);
        expect(ink.delegate.canPinch?.()).toBe(true);
        ink.delegate.onInkDown(pointer(800, 200));
        expect(ink.getTextSelection()?.id).toBe('note');
        expect(ink.delegate.canPinch?.()).toBe(true);
        ink.delegate.onInkUp(pointer(800, 200));
        expect(ink.getTextSelection()).toBeNull();
    });

    it('a drag that promotes into a pinch is one undo step', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf', { hw: 1 }));
        ink.delegate.onInkDown(pointer(310, 655));
        vi.setSystemTime(Date.now() + TEXT_DRAG_SYNC_MS + 1);
        ink.delegate.onInkMove(pointer(360, 655));
        await settle();
        expect(payloadOf('note').x).toBeCloseTo(0.35, 5);
        expect(ink.delegate.canPinch?.()).toBe(true);
        ink.delegate.onPromoteToPinch?.();
        expect(ink.delegate.onPinch!(1.5)).toBe(true);
        await settle();
        ink.delegate.onPinchEnd!();
        await settle();
        expect(payloadOf('note').x).toBeCloseTo(0.35, 5);
        expect(payloadOf('note').size).toBeCloseTo(0.03, 5);

        await store.undoLast();
        expect(payloadOf('note').x).toBeCloseTo(0.3, 5);
        expect(payloadOf('note').size).toBe(0.02);
    });

    it('tap without movement still opens the editor on a selected note', async () => {
        await store.create(textNote('note', 0.3, 0.5, 'mf'));
        await select('note', 305, 655);
        ink.delegate.onInkDown(pointer(306, 656));
        ink.delegate.onInkUp(pointer(306, 656));
        expect(intents).toHaveLength(1);
        expect(intents[0]!.existing?.id).toBe('note');
        expect(payloadOf('note').size).toBe(0.02);
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
