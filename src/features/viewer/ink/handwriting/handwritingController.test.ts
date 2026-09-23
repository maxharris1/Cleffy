import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import { convertGroupToText } from '@/features/viewer/ink/handwriting/convert';
import type { StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import { fontForRecognition, HandwritingController } from '@/features/viewer/ink/handwriting/handwritingController';
import { groupFromHands, HANDS } from '@/features/viewer/ink/handwriting/recognizer/fixtures';
import { ACCENT_TEXT, recognizeOnDevice } from '@/features/viewer/ink/handwriting/recognizer';
import type { Recognizer } from '@/features/viewer/ink/handwriting/types';
import { ASPECT, boxStroke, FakeTimers } from '@/features/viewer/ink/handwriting/testStrokes';
import type * as MusicFontModule from '@/features/viewer/ink/musicFont';
import * as musicFont from '@/features/viewer/ink/musicFont';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { parseDbChange } from '@/sync/wire';
import { isTextPayload, type Annotation, type TextPayload } from '@/types/models';

vi.mock('@/features/viewer/ink/musicFont', async (importOriginal) => {
    const actual = (await importOriginal()) as typeof MusicFontModule;
    return { ...actual, ensureMusicFontLoaded: vi.fn(() => actual.ensureMusicFontLoaded()) };
});

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

const writeGroup = async (controller: HandwritingController, group: StrokeGroup) => {
    for (const glyph of group.glyphs) {
        for (const stroke of glyph.strokes) {
            await write(controller, {
                id: stroke.id,
                docId: DOC,
                page: 0,
                kind: 'stroke',
                color: stroke.color,
                payload: { pts: stroke.pts, w: stroke.w },
                createdBy: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deletedAt: null,
                seq: 0,
            });
        }
    }
};

const textsByX = () =>
    texts()
        .map((a) => ({ text: (a.payload as TextPayload).text, x: (a.payload as TextPayload).x }))
        .sort((a, b) => a.x - b.x)
        .map((a) => a.text);

const texts = () => [...store.getPage(0).values()].filter((a) => a.kind === 'text');
const strokes = () => [...store.getPage(0).values()].filter((a) => a.kind === 'stroke');

const glyphGroup = (id: string, x: number): StrokeGroup => {
    const ink = boxStroke(id, x, 0.5, H * 0.4, H);
    const box = { x0: x, y0: 0.5, x1: x + H * 0.4, y1: 0.5 + H };
    return {
        page: 0,
        color: '#dc2626',
        aspect: ASPECT,
        glyphs: [{ strokes: [ink], box }],
        kind: 'glyph',
        box,
    };
};

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

    describe('letters stay ink', () => {
        it('leaves a writing line the on-device reader refused', async () => {
            const controller = make(() => null);
            await write(controller, strokeAnnotation('u', 0.3));
            await write(controller, strokeAnnotation('s', 0.3 + H));
            timers.fire();
            await controller.settle();
            expect(strokes()).toHaveLength(2);
            expect(texts()).toHaveLength(0);
        });

        it('leaves a lone glyph as ink when the on-device reader abstains', async () => {
            const controller = make(() => null);
            await write(controller, strokeAnnotation('lone', 0.3));
            timers.fire();
            await controller.settle();
            expect(strokes()).toHaveLength(1);
            expect(texts()).toHaveLength(0);
        });

        it('still converts a line the on-device reader already read', async () => {
            const controller = make(() => ({ text: 'mf', kind: 'symbol' }));
            await write(controller, strokeAnnotation('m', 0.3));
            await write(controller, strokeAnnotation('f', 0.3 + H));
            timers.fire();
            await controller.settle();
            expect((texts()[0]!.payload as TextPayload).text).toBe('mf');
            expect(strokes()).toHaveLength(0);
        });
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

    it('nested undo: convert does not close an open eraser batch', async () => {
        const controller = make(() => ({ text: '3', kind: 'digit' }));
        await store.create(strokeAnnotation('keep', 0.7));
        await write(controller, strokeAnnotation('three', 0.3));
        store.beginBatch();
        await store.delete('keep');
        timers.fire();
        await controller.settle();
        expect(texts()).toHaveLength(1);
        await store.create(strokeAnnotation('later', 0.8));
        store.endBatch();

        await store.undoLast();
        expect(store.get('keep')?.deletedAt).toBeNull();
        expect(texts()).toHaveLength(1);
        expect(store.get('later')?.deletedAt).not.toBeNull();

        await store.undoLast();
        expect(texts()).toHaveLength(0);
        expect(store.get('three')?.deletedAt).toBeNull();
    });

    it('converts a nearby fingering run on-device, one digit each', async () => {
        const controller = make(recognizeOnDevice);
        const group = groupFromHands([HANDS.one!, HANDS.two!], { gapW: 0.25 * 0.012 });
        for (const glyph of group.glyphs) {
            for (const stroke of glyph.strokes) {
                const annotation: Annotation = {
                    id: stroke.id,
                    docId: DOC,
                    page: 0,
                    kind: 'stroke',
                    color: stroke.color,
                    payload: { pts: stroke.pts, w: stroke.w },
                    createdBy: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: null,
                    seq: 0,
                };
                await write(controller, annotation);
            }
        }
        timers.fire();
        await controller.settle();
        const printed = texts()
            .map((a) => (a.payload as TextPayload).text)
            .sort();
        expect(printed).toEqual(['1', '2']);
        expect(strokes()).toHaveLength(0);
    });

    it('splits 123 + a word: digits print on device and the letter run stays ink', async () => {
        const controller = make(recognizeOnDevice);
        await writeGroup(controller, groupFromHands([HANDS.one!, HANDS.two!, HANDS.three!, HANDS.m!, HANDS.m!]));
        timers.elapse(300);
        await controller.settle();
        expect(texts()).toHaveLength(0);
        timers.elapse(700);
        await controller.settle();
        expect(textsByX()).toEqual(['1', '2', '3']);
        expect(
            strokes()
                .map((s) => s.id)
                .sort(),
        ).toEqual(['g3', 'g4']);
    });

    it('keeps mf on device when it shares a line with a fingering', async () => {
        const controller = make(recognizeOnDevice);
        await writeGroup(controller, groupFromHands([HANDS.one!, HANDS.m!, HANDS.f!]));
        timers.fire();
        await controller.settle();
        expect(textsByX()).toEqual(['1', 'mf']);
        expect(strokes()).toHaveLength(0);
    });

    it('converts an accent beside a digit on device', async () => {
        const controller = make(recognizeOnDevice);
        await writeGroup(controller, groupFromHands([HANDS.three!, HANDS.accent!]));
        timers.fire();
        await controller.settle();
        expect(textsByX()).toEqual(['3', ACCENT_TEXT]);
        expect(strokes()).toHaveLength(0);
    });

    it('leaves the letter run as ink when transcription is unavailable', async () => {
        const controller = make(recognizeOnDevice);
        await writeGroup(controller, groupFromHands([HANDS.one!, HANDS.two!, HANDS.three!, HANDS.m!, HANDS.m!]));
        timers.fire();
        await controller.settle();
        expect(textsByX()).toEqual(['1', '2', '3']);
        expect(
            strokes()
                .map((s) => s.id)
                .sort(),
        ).toEqual(['g3', 'g4']);
    });

    it('converts without waiting for the music font to load', async () => {
        let released = false;
        const loadSpy = vi.spyOn(musicFont, 'ensureMusicFontLoaded').mockReturnValue(
            new Promise<boolean>((resolve) => {
                setTimeout(() => {
                    released = true;
                    resolve(true);
                }, 30_000);
            }),
        );
        const readySpy = vi.spyOn(musicFont, 'isMusicFontReady').mockReturnValue(false);
        const controller = make(() => ({ text: 'mf', kind: 'symbol' }));
        await write(controller, strokeAnnotation('m', 0.3));
        await write(controller, strokeAnnotation('f', 0.3 + H));
        timers.fire();
        await controller.settle();
        expect(released).toBe(false);
        expect(texts()).toHaveLength(1);
        expect((texts()[0]!.payload as TextPayload).text).toBe('mf');
        loadSpy.mockRestore();
        readySpy.mockRestore();
    });

    it('measures fallback ASCII in system-ui when the music face is not ready', async () => {
        const loadSpy = vi.spyOn(musicFont, 'ensureMusicFontLoaded').mockResolvedValue(false);
        const readySpy = vi.spyOn(musicFont, 'isMusicFontReady').mockReturnValue(false);
        const measured = fontForRecognition({ text: 'mf', kind: 'symbol' });
        expect(measured.font.family).toBe(SYSTEM_FONT_FAMILY);
        expect(measured.font.style).toBe('italic');
        expect(measured.text).toBe('mf');
        expect(measured.music).toBe(false);
        loadSpy.mockRestore();
        readySpy.mockRestore();
    });

    it('aborts convert and restores siblings when a stroke vanishes mid-batch', async () => {
        const group = groupFromHands([HANDS.one!, HANDS.two!]);
        const anns: Annotation[] = [];
        for (const glyph of group.glyphs) {
            for (const stroke of glyph.strokes) {
                anns.push({
                    id: stroke.id,
                    docId: DOC,
                    page: 0,
                    kind: 'stroke',
                    color: stroke.color,
                    payload: { pts: stroke.pts, w: stroke.w },
                    createdBy: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    deletedAt: null,
                    seq: 0,
                });
            }
        }
        for (const a of anns) {
            await store.create(a);
        }
        const first = anns[0]!.id;
        const peerErase = anns[1]!.id;
        const origDelete = store.delete.bind(store);
        store.delete = async (id: string) => {
            if (id === first) {
                await origDelete(peerErase);
            }
            return origDelete(id);
        };
        const created = await convertGroupToText(store, group, {
            x: 0.3,
            y: 0.5,
            text: '12',
            size: 0.02,
        });
        expect(created).toBeNull();
        expect(texts()).toHaveLength(0);
        expect(store.get(first)?.deletedAt).toBeNull();
        expect(store.get(peerErase)?.deletedAt).not.toBeNull();
    });

    it('overlapping converts do not share a batch frame', async () => {
        const groupA = glyphGroup('dyn-a', 0.2);
        const groupB = glyphGroup('dyn-b', 0.5);
        await store.create(strokeAnnotation('dyn-a', 0.2));
        await store.create(strokeAnnotation('dyn-b', 0.5));

        let releaseA = () => undefined;
        const blockA = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        let sawA = () => undefined;
        const enteredA = new Promise<void>((resolve) => {
            sawA = resolve;
        });
        let aBlocked = false;
        let bWhileA = false;
        const origDelete = store.delete.bind(store);
        store.delete = async (id: string) => {
            if (id === 'dyn-a') {
                aBlocked = true;
                sawA();
                await blockA;
                aBlocked = false;
            } else if (aBlocked) {
                bWhileA = true;
            }
            return origDelete(id);
        };

        const first = convertGroupToText(store, groupA, { x: 0.2, y: 0.5, text: 'p', size: 0.02 });
        await enteredA;
        const second = convertGroupToText(store, groupB, { x: 0.5, y: 0.5, text: 'f', size: 0.02 });
        await Promise.resolve();
        await Promise.resolve();
        expect(bWhileA).toBe(false);
        releaseA();
        await Promise.all([first, second]);

        expect(
            texts()
                .map((a) => (a.payload as TextPayload).text)
                .sort(),
        ).toEqual(['f', 'p']);

        await store.undoLast();
        expect(texts().map((a) => (a.payload as TextPayload).text)).toEqual(['p']);
        expect(store.get('dyn-b')?.deletedAt).toBeNull();
        expect(store.get('dyn-a')?.deletedAt).not.toBeNull();

        await store.undoLast();
        expect(texts()).toHaveLength(0);
        expect(store.get('dyn-a')?.deletedAt).toBeNull();
    });

    it('outer endBatch during convert delete does not steal the convert frame', async () => {
        const controller = make(() => ({ text: '3', kind: 'digit' }));
        await store.create(strokeAnnotation('keep', 0.7));
        await write(controller, strokeAnnotation('three', 0.3));

        let release = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let sawThree = () => undefined;
        const enteredThree = new Promise<void>((resolve) => {
            sawThree = resolve;
        });
        let firstThree = true;
        const origDelete = store.delete.bind(store);
        store.delete = async (id: string) => {
            if (id === 'three' && firstThree) {
                firstThree = false;
                sawThree();
                await blocked;
            }
            return origDelete(id);
        };

        const outer = store.beginBatch();
        await store.delete('keep');
        timers.fire();
        await enteredThree;
        store.endBatch(outer);
        release();
        await controller.settle();

        expect(texts()).toHaveLength(1);
        expect(store.get('keep')?.deletedAt).not.toBeNull();

        await store.undoLast();
        expect(texts()).toHaveLength(0);
        expect(store.get('three')?.deletedAt).toBeNull();
        expect(store.get('keep')?.deletedAt).not.toBeNull();

        await store.undoLast();
        expect(store.get('keep')?.deletedAt).toBeNull();
    });
});
