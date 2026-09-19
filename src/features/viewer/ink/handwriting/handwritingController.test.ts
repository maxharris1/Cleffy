import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HandwritingController } from '@/features/viewer/ink/handwriting/handwritingController';
import type { Recognizer } from '@/features/viewer/ink/handwriting/types';
import { ASPECT, boxStroke, FakeTimers } from '@/features/viewer/ink/handwriting/testStrokes';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { parseDbChange } from '@/sync/wire';
import { isTextPayload, type Annotation, type TextPayload } from '@/types/models';

const DOC = 'local-hw-doc';
const H = 0.012;

const strokeAnnotation = (id: string, x: number, kind: 'stroke' | 'highlight' = 'stroke'): Annotation => {
    const ink = boxStroke(id, x, 0.5, H * 0.8, H);
    return {
        id,
        docId: DOC,
        page: 0,
        kind,
        color: '#dc2626',
        payload: { pts: ink.pts, w: ink.w },
        createdBy: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        seq: 0,
    };
};

let db: ScribblerDb;
let store: AnnotationStore;
let timers: FakeTimers;
let enabled: boolean;

const make = (recognizer: Recognizer) =>
    new HandwritingController({
        store,
        recognizer,
        isEnabled: () => enabled,
        getAspect: () => ASPECT,
        schedule: timers.schedule,
        cancel: timers.cancel,
    });

/** Commit a stroke the way the InkController does, then hand it to the pipeline. */
const write = async (controller: HandwritingController, annotation: Annotation) => {
    await store.create(annotation);
    controller.onStrokeCommitted(annotation);
};

const texts = () => [...store.getPage(0).values()].filter((a) => a.kind === 'text');
const strokes = () => [...store.getPage(0).values()].filter((a) => a.kind === 'stroke');

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
    timers = new FakeTimers();
    enabled = true;
});

describe('HandwritingController', () => {
    it('converts a recognized writing line into ONE hw-flagged text in the ink color', async () => {
        const controller = make(() => ({ text: 'use wrist', kind: 'text' }));
        await write(controller, strokeAnnotation('u', 0.3));
        await write(controller, strokeAnnotation('s', 0.3 + H));
        await write(controller, strokeAnnotation('e', 0.3 + 2 * H));
        timers.fire();
        await controller.settle();

        expect(strokes()).toHaveLength(0);
        const created = texts();
        expect(created).toHaveLength(1);
        const text = created[0]!;
        expect(text.color).toBe('#dc2626');
        expect(isTextPayload(text.payload) && text.payload.text).toBe('use wrist');
        expect((text.payload as TextPayload).hw).toBe(1);
        // Print sits where the ink was.
        expect((text.payload as TextPayload).x).toBeCloseTo(0.3, 2);
    });

    it('is one undo step: undo restores every stroke and removes the print; redo re-applies', async () => {
        const controller = make(() => ({ text: 'mf', kind: 'symbol' }));
        await write(controller, strokeAnnotation('m', 0.3));
        await write(controller, strokeAnnotation('f', 0.3 + H));
        timers.fire();
        await controller.settle();
        expect(texts()).toHaveLength(1);

        await store.undoLast();
        expect(texts()).toHaveLength(0);
        expect(
            strokes()
                .map((s) => s.id)
                .sort(),
        ).toEqual(['f', 'm']);

        await store.redoLast();
        expect(texts()).toHaveLength(1);
        expect(strokes()).toHaveLength(0);
    });

    it('never converts while the opt-in is off, even if the recognizer would', async () => {
        enabled = false;
        const recognizer = vi.fn<Recognizer>(() => ({ text: '3', kind: 'digit' }));
        const controller = make(recognizer);
        await write(controller, strokeAnnotation('three', 0.3));
        timers.fire();
        await controller.settle();
        expect(recognizer).not.toHaveBeenCalled();
        expect(strokes()).toHaveLength(1);
        expect(texts()).toHaveLength(0);
    });

    it('leaves the ink when the recognizer abstains', async () => {
        const controller = make(() => null);
        await write(controller, strokeAnnotation('scribble', 0.3));
        timers.fire();
        await controller.settle();
        expect(strokes()).toHaveLength(1);
        expect(texts()).toHaveLength(0);
    });

    it('cancels a pending convert when the stroke is erased during the window', async () => {
        const recognizer = vi.fn<Recognizer>(() => ({ text: '3', kind: 'digit' }));
        const controller = make(recognizer);
        await write(controller, strokeAnnotation('three', 0.3));
        expect(controller.pendingIds()).toEqual(['three']);
        await store.delete('three');
        expect(controller.pendingIds()).toEqual([]);
        timers.fire();
        await controller.settle();
        expect(recognizer).not.toHaveBeenCalled();
        expect(texts()).toHaveLength(0);
    });

    it('does not convert if a stroke vanished while the recognizer was running', async () => {
        let resolve: (r: { text: string; kind: 'digit' }) => void = () => undefined;
        const controller = make(() => new Promise((r) => (resolve = r)));
        await write(controller, strokeAnnotation('three', 0.3));
        timers.fire();
        await store.delete('three');
        resolve({ text: '3', kind: 'digit' });
        await controller.settle();
        expect(texts()).toHaveLength(0);
    });

    it('skips highlighter strokes entirely', async () => {
        const recognizer = vi.fn<Recognizer>(() => ({ text: '3', kind: 'digit' }));
        const controller = make(recognizer);
        await write(controller, strokeAnnotation('hl', 0.3, 'highlight'));
        expect(controller.pendingIds()).toEqual([]);
        timers.fire();
        await controller.settle();
        expect(recognizer).not.toHaveBeenCalled();
        expect(store.getPage(0).get('hl')?.kind).toBe('highlight');
    });

    it('produces a payload whose hw flag survives the realtime wire schema', async () => {
        const controller = make(() => ({ text: '2', kind: 'digit' }));
        await write(controller, strokeAnnotation('two', 0.3));
        timers.fire();
        await controller.settle();
        const text = texts()[0]!;
        const row = parseDbChange({
            operation: 'INSERT',
            schema: 'public',
            table: 'annotations',
            record: {
                id: text.id,
                document_id: DOC,
                page: text.page,
                kind: text.kind,
                color: text.color,
                payload: text.payload,
                created_by: 'user-1',
                created_at: text.createdAt,
                updated_at: text.updatedAt,
                deleted_at: null,
                seq: 9,
            },
        });
        expect(row).not.toBeNull();
        expect((row?.payload as TextPayload).hw).toBe(1);
        expect((row?.payload as TextPayload).text).toBe('2');
    });
});
