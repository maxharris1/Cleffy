import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadExportMarks } from '@/features/export/exportAnnotations';
import { purgeLocalDocument } from '@/features/library/documentsService';
import type { DocumentLayout } from '@/features/viewer/geometry';
import * as snapshotService from '@/features/viewer/history/snapshotService';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { HandwritingController } from '@/features/viewer/ink/handwriting/handwritingController';
import { FakeTimers } from '@/features/viewer/ink/handwriting/testStrokes';
import { InkController } from '@/features/viewer/ink/InkController';
import { AnnotationStore } from '@/sync/annotationStore';
import type * as dbModule from '@/sync/db';
import { ScribblerDb } from '@/sync/db';
import { accountSignedIn, lostAccessInk, rememberScoreSource, resetInkRecoveryForTests } from '@/sync/inkRecovery';
import { useViewerStore } from '@/state/store';

vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof dbModule>()),
    getDb: () => db,
}));

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
        fillText: () => undefined,
        measureText: (text: string) => ({ width: text.length * 8 }),
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

const drawStroke = (x: number, y: number) => {
    ink.delegate.onInkDown(pointer(x, y));
    ink.delegate.onInkMove(pointer(x + 20, y + 5));
    ink.delegate.onInkMove(pointer(x + 40, y));
    ink.delegate.onInkUp(pointer(x + 40, y));
};

const mount = async (docId: string, author: string | null) => {
    store = new AnnotationStore(db, docId);
    store.setAuthor(author);
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
};

beforeEach(async () => {
    vi.stubGlobal('Path2D', FakePath2D);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    await mount(DOC, null);
});

afterEach(() => {
    ink.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetInkRecoveryForTests();
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

describe('InkController erase undo batch', () => {
    const eraseFirstTwoOfThree = async () => {
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        expect(strokesShown()).toBe(3);
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        await settle();
        expect(strokesShown()).toBe(2);
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
    };

    it('one undo restores every mark the gesture erased when the stylus lifts before the last delete lands', async () => {
        await eraseFirstTwoOfThree();
        ink.delegate.onInkUp(pointer(330, 304));
        await settle();
        expect(strokesShown()).toBe(1);

        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(3);
    });

    it('one undo restores every mark the gesture erased when the gesture is cancelled before the last delete lands', async () => {
        await eraseFirstTwoOfThree();
        ink.delegate.onInkCancel(pointer(330, 304));
        await settle();
        expect(strokesShown()).toBe(1);

        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(3);
    });

    it('undo pressed right after the stylus lifts, before the last delete lands, restores every mark the gesture erased', async () => {
        await eraseFirstTwoOfThree();
        ink.delegate.onInkUp(pointer(330, 304));
        const undoing = store.undoLast();
        await settle();
        await undoing;
        await settle();
        expect(strokesShown()).toBe(3);

        await store.redoLast();
        await settle();
        expect(strokesShown()).toBe(1);
    });

    it('undo pressed right after the gesture is cancelled, before the last delete lands, restores every mark the gesture erased', async () => {
        await eraseFirstTwoOfThree();
        ink.delegate.onInkCancel(pointer(330, 304));
        const undoing = store.undoLast();
        await settle();
        await undoing;
        await settle();
        expect(strokesShown()).toBe(3);

        await store.redoLast();
        await settle();
        expect(strokesShown()).toBe(1);
    });

    it('undo and redo replay a settled erase as one step', async () => {
        await eraseFirstTwoOfThree();
        await settle();
        ink.delegate.onInkUp(pointer(330, 304));
        await settle();
        expect(strokesShown()).toBe(1);

        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(3);
        await store.redoLast();
        await settle();
        expect(strokesShown()).toBe(1);
        await store.undoLast();
        await settle();
        expect(strokesShown()).toBe(3);
    });

    const holdNextSnapshotCheck = () => {
        const orig = snapshotService.ensureDayStartingSnapshot;
        let out!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (out = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementationOnce(async (...args) => {
            out();
            await released;
            return orig(...args);
        });
        return { held, release };
    };

    const marksSaved = async () => (await db.annotations.toArray()).filter((a) => !a.deletedAt).length;

    const undoWhileLastDeletePendingThenDraw = async (end: (e: PointerEvent) => void) => {
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        await settle();
        expect(strokesShown()).toBe(2);

        const gate = holdNextSnapshotCheck();
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        await gate.held;
        end(pointer(330, 304));
        const undoing = store.undoLast();

        useViewerStore.getState().setTool('pen');
        drawStroke(700, 300);
        await settle();
        expect(await marksSaved()).toBe(2);

        gate.release();
        await undoing;
        await settle();
    };

    it('undo pressed while the last delete is pending after lift keeps a stroke drawn after the press', async () => {
        await undoWhileLastDeletePendingThenDraw((e) => ink.delegate.onInkUp(e));
        expect(strokesShown()).toBe(4);
        expect(await marksSaved()).toBe(4);
    });

    it('undo pressed while the last delete is pending after cancel keeps a stroke drawn after the press', async () => {
        await undoWhileLastDeletePendingThenDraw((e) => ink.delegate.onInkCancel(e));
        expect(strokesShown()).toBe(4);
        expect(await marksSaved()).toBe(4);
    });

    const mirrorAfterUndoOvertakenByPurge = async (end: (e: PointerEvent) => void, holdLastDelete: boolean) => {
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        await settle();
        const gate = holdLastDelete ? holdNextSnapshotCheck() : null;
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        await (gate ? gate.held : settle());
        end(pointer(330, 304));

        const undone = Promise.allSettled([store.undoLast()]);
        await purgeLocalDocument(DOC);
        gate?.release();
        await undone;
        await settle();
        return {
            rows: await db.annotations.where('docId').equals(DOC).toArray(),
            ops: await db.ops.where('docId').equals(DOC).toArray(),
        };
    };

    it('undo overtaken by a score purge after lift writes nothing back', async () => {
        expect(await mirrorAfterUndoOvertakenByPurge((e) => ink.delegate.onInkUp(e), false)).toEqual({
            rows: [],
            ops: [],
        });
    });

    it('undo overtaken by a score purge after cancel writes nothing back', async () => {
        expect(await mirrorAfterUndoOvertakenByPurge((e) => ink.delegate.onInkCancel(e), false)).toEqual({
            rows: [],
            ops: [],
        });
    });

    it('undo overtaken by a score purge while the last delete is pending writes nothing back', async () => {
        expect(await mirrorAfterUndoOvertakenByPurge((e) => ink.delegate.onInkUp(e), true)).toEqual({
            rows: [],
            ops: [],
        });
    });

    it('undo overtaken by a score purge after cancel while the last delete is pending writes nothing back', async () => {
        expect(await mirrorAfterUndoOvertakenByPurge((e) => ink.delegate.onInkCancel(e), true)).toEqual({
            rows: [],
            ops: [],
        });
    });
});

describe('InkController erase undo batch overlapping handwriting conversion', () => {
    let timers: FakeTimers;
    let handwriting: HandwritingController;

    beforeEach(() => {
        timers = new FakeTimers();
        handwriting = new HandwritingController({
            store,
            recognizer: () => ({ text: '3', kind: 'digit' }),
            isEnabled: () => true,
            getAspect: () => PAGE_W / PAGE_H,
            schedule: timers.schedule,
            cancel: timers.cancel,
        });
    });

    afterEach(() => handwriting.dispose());

    const holdNextSnapshotCheck = () => {
        const orig = snapshotService.ensureDayStartingSnapshot;
        let out!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (out = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementationOnce(async (...args) => {
            out();
            await released;
            return orig(...args);
        });
        return { held, release };
    };

    const row = async (id: string) => db.annotations.get(id);

    const eraseAcrossConversion = async (end: (e: PointerEvent) => void) => {
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        const [a, b, c] = [...store.getPage(0).keys()] as [string, string, string];
        handwriting.onStrokeCommitted(store.get(c)!);

        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        await settle();
        expect((await row(a))?.deletedAt).not.toBeNull();

        const conversion = holdNextSnapshotCheck();
        timers.fire();
        await conversion.held;

        const eraseB = holdNextSnapshotCheck();
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        await eraseB.held;

        conversion.release();
        await handwriting.settle();
        const printed = [...store.getPage(0).values()].find((mark) => mark.kind === 'text')!;
        expect(printed).toBeDefined();

        eraseB.release();
        await settle();
        expect((await row(b))?.deletedAt).not.toBeNull();
        end(pointer(330, 304));
        await settle();
        return { a, b, c, printed: printed.id };
    };

    const undoRestoresEraseThenConversion = async (end: (e: PointerEvent) => void) => {
        const { a, b, c, printed } = await eraseAcrossConversion(end);

        await store.undoLast();
        await settle();
        expect(store.getPage(0).has(a)).toBe(true);
        expect(store.getPage(0).has(b)).toBe(true);
        expect((await row(a))?.deletedAt).toBeNull();
        expect((await row(b))?.deletedAt).toBeNull();
        expect(store.getPage(0).has(printed)).toBe(true);
        expect((await row(printed))?.deletedAt).toBeNull();

        await store.undoLast();
        await settle();
        expect((await row(printed))?.deletedAt).not.toBeNull();
        expect(store.getPage(0).has(printed)).toBe(false);
        expect(store.getPage(0).has(c)).toBe(true);
        expect((await row(c))?.deletedAt).toBeNull();
        expect(store.getPage(0).has(a)).toBe(true);
        expect(store.getPage(0).has(b)).toBe(true);
    };

    it('one undo restores every stroke the drag erased after lift, and leaves the print for the next undo', async () => {
        await undoRestoresEraseThenConversion((e) => ink.delegate.onInkUp(e));
    });

    it('one undo restores every stroke the drag erased after cancel, and leaves the print for the next undo', async () => {
        await undoRestoresEraseThenConversion((e) => ink.delegate.onInkCancel(e));
    });
});

describe('InkController settled erase undo overtaken by a loss-of-access purge', () => {
    const CLOUD_DOC = '6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b';
    const AUTHOR = 'author-1';

    beforeEach(async () => {
        ink.destroy();
        accountSignedIn(AUTHOR);
        await mount(CLOUD_DOC, AUTHOR);
    });

    const drawn = () => [...store.getPage(0).keys()];

    const undoSettledEraseThenPurge = async (end: (e: PointerEvent) => void, heldInk: 'keep' | 'discard' = 'keep') => {
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        const erased = drawn().slice(0, 2).sort();
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        await settle();
        expect(strokesShown()).toBe(1);
        expect((await db.annotations.bulkGet(erased)).map((row) => Boolean(row?.deletedAt))).toEqual([true, true]);
        end(pointer(330, 304));

        await Promise.allSettled([store.undoLast(), purgeLocalDocument(CLOUD_DOC, { heldInk })]);
        await settle();
        const exported = await loadExportMarks(CLOUD_DOC, AUTHOR, undefined, { lostAccess: true });
        return {
            marks: lostAccessInk().map((score) => [score.userId, score.docId, score.marks]),
            exported: exported.annotations.map((mark) => mark.id).sort(),
            restored: erased,
            rows: await db.annotations.where('docId').equals(CLOUD_DOC).toArray(),
            ops: await db.ops.where('docId').equals(CLOUD_DOC).toArray(),
        };
    };

    it('keeps the restored marks for Export after lift, and writes nothing back', async () => {
        const after = await undoSettledEraseThenPurge((e) => ink.delegate.onInkUp(e));
        expect(after.marks).toEqual([[AUTHOR, CLOUD_DOC, 2]]);
        expect(after.exported).toEqual(after.restored);
        expect(after.rows).toEqual([]);
        expect(after.ops).toEqual([]);
    });

    it('keeps the restored marks for Export after cancel, and writes nothing back', async () => {
        const after = await undoSettledEraseThenPurge((e) => ink.delegate.onInkCancel(e));
        expect(after.marks).toEqual([[AUTHOR, CLOUD_DOC, 2]]);
        expect(after.exported).toEqual(after.restored);
        expect(after.rows).toEqual([]);
        expect(after.ops).toEqual([]);
    });

    const holdSnapshot = () => {
        const orig = snapshotService.ensureDayStartingSnapshot;
        let out!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (out = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementationOnce(async (...args) => {
            out();
            await released;
            return orig(...args);
        });
        return { held, release };
    };

    const BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

    const undoPendingEraseAcrossSourceReleaseAndPurge = async (end: (e: PointerEvent) => void) => {
        const releaseSource = rememberScoreSource(CLOUD_DOC, 'Sonata', BYTES);
        drawStroke(100, 300);
        drawStroke(300, 300);
        drawStroke(500, 300);
        await settle();
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        await settle();
        const gate = holdSnapshot();
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        await gate.held;
        end(pointer(330, 304));

        const undoing = store.undoLast();
        releaseSource();
        await purgeLocalDocument(CLOUD_DOC);
        gate.release();
        await Promise.allSettled([undoing]);
        await settle();
        return lostAccessInk().map((score) => ({ marks: score.marks, bytes: score.bytes }));
    };

    it('keeps the PDF for Export while an Undo waits on an erase pending at lift', async () => {
        expect(await undoPendingEraseAcrossSourceReleaseAndPurge((e) => ink.delegate.onInkUp(e))).toEqual([
            { marks: 1, bytes: BYTES },
        ]);
    });

    it('keeps the PDF for Export while an Undo waits on an erase pending at cancel', async () => {
        expect(await undoPendingEraseAcrossSourceReleaseAndPurge((e) => ink.delegate.onInkCancel(e))).toEqual([
            { marks: 1, bytes: BYTES },
        ]);
    });

    it('keeps the PDF for Export when the viewer lets it go between a settled Undo press and the purge', async () => {
        const releaseSource = rememberScoreSource(CLOUD_DOC, 'Sonata', BYTES);
        drawStroke(100, 300);
        drawStroke(300, 300);
        await settle();
        useViewerStore.getState().setTool('eraser');
        ink.delegate.onInkDown(pointer(110, 302));
        ink.delegate.onInkMove(pointer(130, 304));
        ink.delegate.onInkMove(pointer(310, 302));
        ink.delegate.onInkMove(pointer(330, 304));
        ink.delegate.onInkUp(pointer(330, 304));
        await settle();

        const undoing = store.undoLast();
        releaseSource();
        await Promise.allSettled([undoing, purgeLocalDocument(CLOUD_DOC)]);
        await settle();
        expect(
            lostAccessInk().map((score) => ({ marks: score.marks, title: score.title, bytes: score.bytes })),
        ).toEqual([{ marks: 2, title: 'Sonata', bytes: BYTES }]);
    });

    it('lets the restored marks go when the purge discards held ink', async () => {
        const after = await undoSettledEraseThenPurge((e) => ink.delegate.onInkUp(e), 'discard');
        expect(after.marks).toEqual([]);
        expect(after.exported).toEqual([]);
        expect(after.rows).toEqual([]);
        expect(after.ops).toEqual([]);
    });
});
