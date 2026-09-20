import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HandwritingGrouper, groupStrokeIds, type StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import { HandwritingController } from '@/features/viewer/ink/handwriting/handwritingController';
import { MOUSE, groupFromHands, HANDS } from '@/features/viewer/ink/handwriting/recognizer/fixtures';
import { classifyGlyph, recognizeOnDevice } from '@/features/viewer/ink/handwriting/recognizer';
import type { TranscribeInkFn } from '@/features/viewer/ink/handwriting/transcribeApi';
import { ASPECT, FakeTimers, placeHand, placedHandWidth } from '@/features/viewer/ink/handwriting/testStrokes';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { isTextPayload, type Annotation, type TextPayload } from '@/types/models';

/**
 * UI-smoke mouse polylines that the on-device path used to get wrong:
 * tight `mf` collapsed to `f`, airy `mf` left `m` ink, and a lone `p`
 * (small bowl, or stem then bowl) read as a fingering `1`.
 */

const DOC = 'local-hw-mouse';
const H = 0.018;

const setupGrouper = () => {
    const timers = new FakeTimers();
    const flushed: StrokeGroup[] = [];
    const grouper = new HandwritingGrouper({
        onFlush: (g) => flushed.push(g),
        schedule: timers.schedule,
        cancel: timers.cancel,
    });
    return { timers, flushed, grouper };
};

const asAnnotation = (stroke: { id: string; color: string; pts: number[]; w: number }): Annotation => ({
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

describe('mouse-polyline smoke cases', () => {
    it('reads a one-stroke mouse p (small bowl) as p, not a 1 from the stem', () => {
        expect(classifyGlyph(MOUSE.pSmallBowl!)?.cls).toBe('p');
        expect(recognizeOnDevice(groupFromHands([MOUSE.pSmallBowl!]))).toEqual({ text: 'p', kind: 'symbol' });
    });

    it('groups a mouse p stem + gapped bowl into one p, not a leftover 1', () => {
        const { timers, flushed, grouper } = setupGrouper();
        const ink = placeHand('p', HANDS.p!, 0.4, 0.5, H);
        const stem = ink[0]!;
        const bowl = ink[1]!;
        // Gap ~0.08 H — old joinsGlyph required the bowl itself to be a
        // fragment, so a stem + nearby bowl never joined and the stem read as `1`.
        const shift = 0.08 * H;
        for (let i = 0; i < bowl.pts.length; i += 3) {
            bowl.pts[i] = (bowl.pts[i] ?? 0) + shift;
        }
        grouper.add(stem, ASPECT);
        grouper.add(bowl, ASPECT);
        expect(flushed).toHaveLength(0);
        timers.fire();
        expect(flushed).toHaveLength(1);
        expect(recognizeOnDevice(flushed[0]!)).toEqual({ text: 'p', kind: 'symbol' });
    });

    it('groups overlapping mouse m and f as one mf object, not a leftover m + f', () => {
        const { timers, flushed, grouper } = setupGrouper();
        const mW = placedHandWidth(HANDS.m!, H);
        const m = placeHand('m', HANDS.m!, 0.3, 0.5, H);
        const f = placeHand('f', HANDS.f!, 0.3 + mW * 0.55, 0.5, H);
        for (const stroke of [...m, ...f]) {
            grouper.add(stroke, ASPECT);
        }
        expect(flushed).toHaveLength(0);
        timers.fire();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]!.kind).toBe('line');
        expect(groupStrokeIds(flushed[0]!).some((id) => id.startsWith('m-'))).toBe(true);
        expect(groupStrokeIds(flushed[0]!).some((id) => id.startsWith('f-'))).toBe(true);
        expect(recognizeOnDevice(flushed[0]!)).toEqual({ text: 'mf', kind: 'symbol' });
    });

    it('groups an airy mouse mf (gap past old WORD_GAP) as one mf object', () => {
        const { timers, flushed, grouper } = setupGrouper();
        const mW = placedHandWidth(MOUSE.m!, H);
        const m = placeHand('m', MOUSE.m!, 0.3, 0.5, H);
        const f = placeHand('f', MOUSE.f!, 0.3 + mW + 1.2 * H, 0.5, H);
        for (const stroke of [...m, ...f]) {
            grouper.add(stroke, ASPECT);
        }
        expect(flushed).toHaveLength(0);
        timers.fire();
        expect(flushed).toHaveLength(1);
        expect(recognizeOnDevice(flushed[0]!)).toEqual({ text: 'mf', kind: 'symbol' });
    });
});

describe('mouse-polyline convert (controller)', () => {
    let db: ScribblerDb;
    let store: AnnotationStore;
    let timers: FakeTimers;

    const writeAll = async (controller: HandwritingController, strokes: ReturnType<typeof placeHand>) => {
        for (const stroke of strokes) {
            const annotation = asAnnotation(stroke);
            await store.create(annotation);
            controller.onStrokeCommitted(annotation);
        }
    };

    const texts = () => [...store.getPage(0).values()].filter((a) => a.kind === 'text');
    const strokes = () => [...store.getPage(0).values()].filter((a) => a.kind === 'stroke');

    beforeEach(async () => {
        db = new ScribblerDb(`test-${crypto.randomUUID()}`);
        store = new AnnotationStore(db, DOC);
        await store.load();
        timers = new FakeTimers();
    });

    const make = (transcribe?: TranscribeInkFn) =>
        new HandwritingController({
            store,
            recognizer: recognizeOnDevice,
            transcribe,
            isEnabled: () => true,
            getAspect: () => ASPECT,
            schedule: timers.schedule,
            cancel: timers.cancel,
        });

    it('converts a one-stroke mouse p to one print p', async () => {
        const controller = make();
        await writeAll(controller, placeHand('p', MOUSE.pSmallBowl!, 0.4, 0.5, H));
        timers.fire();
        await controller.settle();
        expect(strokes()).toHaveLength(0);
        expect(texts()).toHaveLength(1);
        expect(isTextPayload(texts()[0]!.payload) && (texts()[0]!.payload as TextPayload).text).toBe('p');
    });

    it('converts overlapping mouse mf to one print mf', async () => {
        const controller = make();
        const mW = placedHandWidth(HANDS.m!, H);
        await writeAll(controller, placeHand('m', HANDS.m!, 0.3, 0.5, H));
        await writeAll(controller, placeHand('f', HANDS.f!, 0.3 + mW * 0.55, 0.5, H));
        timers.fire();
        await controller.settle();
        expect(strokes()).toHaveLength(0);
        expect(texts()).toHaveLength(1);
        expect((texts()[0]!.payload as TextPayload).text).toBe('mf');
        expect((texts()[0]!.payload as TextPayload).hw).toBe(1);
    });

    it('converts a gapped mouse p stem+bowl to one print p, not a 1', async () => {
        const controller = make();
        const ink = placeHand('p', HANDS.p!, 0.4, 0.5, H);
        const bowl = ink[1]!;
        const shift = 0.08 * H;
        for (let i = 0; i < bowl.pts.length; i += 3) {
            bowl.pts[i] = (bowl.pts[i] ?? 0) + shift;
        }
        await writeAll(controller, ink);
        timers.fire();
        await controller.settle();
        expect(strokes()).toHaveLength(0);
        expect(texts()).toHaveLength(1);
        expect((texts()[0]!.payload as TextPayload).text).toBe('p');
    });

    it('clumps a handwritten phrase into one transcribeable text row', async () => {
        const transcribe = vi.fn<TranscribeInkFn>(async () => 'use wrist');
        const controller = make(transcribe);
        let x = 0.25;
        for (const [id, hand] of [
            ['u', HANDS.m!],
            ['s', HANDS.m!],
            ['e', HANDS.m!],
        ] as const) {
            const w = placedHandWidth(hand, H);
            await writeAll(controller, placeHand(id, hand, x, 0.5, H));
            x += w + 0.35 * H;
        }
        // Word space past the old 1.0 WORD_GAP, still one line.
        x += 1.15 * H;
        for (const [id, hand] of [
            ['w', HANDS.m!],
            ['r', HANDS.m!],
        ] as const) {
            const w = placedHandWidth(hand, H);
            await writeAll(controller, placeHand(id, hand, x, 0.51, H));
            x += w + 0.3 * H;
        }
        expect(transcribe).not.toHaveBeenCalled();
        timers.fire();
        await controller.settle();
        expect(transcribe).toHaveBeenCalledTimes(1);
        expect(transcribe.mock.calls[0]![0]!.kind).toBe('line');
        expect(strokes()).toHaveLength(0);
        expect(texts()).toHaveLength(1);
        expect((texts()[0]!.payload as TextPayload).text).toBe('use wrist');
        expect((texts()[0]!.payload as TextPayload).hw).toBe(1);
    });
});
