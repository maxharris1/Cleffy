import { describe, expect, it } from 'vitest';

import {
    FINGERING_GAP,
    GLYPH_PAUSE_MS,
    groupBboxNormalized,
    groupStrokeIds,
    HandwritingGrouper,
    LINE_PAUSE_MS,
    MAX_GROUP_HEIGHT,
    type StrokeGroup,
} from '@/features/viewer/ink/handwriting/grouper';
import { ASPECT, boxStroke, FakeTimers } from '@/features/viewer/ink/handwriting/testStrokes';

/** Letter height used throughout (fraction of page width). */
const H = 0.012;

const setup = () => {
    const timers = new FakeTimers();
    const flushed: StrokeGroup[] = [];
    const grouper = new HandwritingGrouper({
        onFlush: (g) => flushed.push(g),
        schedule: timers.schedule,
        cancel: timers.cancel,
    });
    return { timers, flushed, grouper };
};

describe('HandwritingGrouper', () => {
    it('groups letters written on one line with small gaps into ONE line object', () => {
        const { timers, flushed, grouper } = setup();
        // "use" — three letters, gaps of ~0.2 letter heights.
        let x = 0.3;
        for (const id of ['u', 's', 'e']) {
            grouper.add(boxStroke(id, x, 0.5, H * 0.8, H), ASPECT);
            x += H * 0.8 + H * 0.2;
        }
        expect(flushed).toHaveLength(0);
        expect(timers.pending()).toEqual([LINE_PAUSE_MS]);
        timers.fire();
        expect(flushed).toHaveLength(1);
        const group = flushed[0]!;
        expect(group.kind).toBe('line');
        expect(group.glyphs).toHaveLength(3);
        expect(groupStrokeIds(group)).toEqual(['u', 's', 'e']);
    });

    it('keeps a word gap inside one line, but a wide gap starts a new object', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('a', 0.3, 0.5, H, H), ASPECT);
        // Word space: 0.8 heights → same line.
        grouper.add(boxStroke('b', 0.3 + H + 0.8 * H, 0.5, H, H), ASPECT);
        // Far away: 3 heights → spatially new, the pending line flushes now.
        grouper.add(boxStroke('c', 0.3 + 2 * H + 0.8 * H + 3 * H, 0.5, H, H), ASPECT);
        expect(flushed).toHaveLength(1);
        expect(groupStrokeIds(flushed[0]!)).toEqual(['a', 'b']);
        timers.fire();
        expect(flushed).toHaveLength(2);
        expect(flushed[1]!.kind).toBe('glyph');
    });

    it('flushes chord fingerings (~one digit-height apart) as one object each', () => {
        const { timers, flushed, grouper } = setup();
        // Origins 1.0 glyph-height apart, width 0.4 H → gap 0.6 H, above FINGERING_GAP.
        const pitch = 1.0 * H;
        grouper.add(boxStroke('one', 0.2, 0.4, H * 0.4, H), ASPECT);
        grouper.add(boxStroke('two', 0.2 + pitch, 0.4, H * 0.4, H), ASPECT);
        grouper.add(boxStroke('three', 0.2 + 2 * pitch, 0.4, H * 0.4, H), ASPECT);
        expect(flushed.map((g) => groupStrokeIds(g))).toEqual([['one'], ['two']]);
        timers.fire();
        expect(flushed.map((g) => g.kind)).toEqual(['glyph', 'glyph', 'glyph']);
        expect(flushed.map((g) => groupStrokeIds(g))).toEqual([['one'], ['two'], ['three']]);
        expect(pitch - H * 0.4).toBeGreaterThan(FINGERING_GAP * H);
    });

    it('a lone glyph flushes after the line pause as a single object', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('p', 0.5, 0.5, H * 0.7, H), ASPECT);
        expect(timers.pending()).toEqual([LINE_PAUSE_MS]);
        expect(GLYPH_PAUSE_MS).toBe(LINE_PAUSE_MS);
        timers.fire();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]!.kind).toBe('glyph');
        expect(flushed[0]!.glyphs).toHaveLength(1);
    });

    it('does not convert a lone p/f at 600 ms, so mf can still join', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('m', 0.3, 0.5, H * 0.9, H), ASPECT);
        timers.elapse(600);
        expect(flushed).toHaveLength(0);
        grouper.add(boxStroke('f', 0.3 + 1.1 * H, 0.5, H * 0.7, H), ASPECT);
        expect(flushed).toHaveLength(0);
        expect(timers.pending()).toEqual([LINE_PAUSE_MS]);
        timers.fire();
        expect(flushed).toHaveLength(1);
        expect(flushed[0]!.kind).toBe('line');
        expect(groupStrokeIds(flushed[0]!)).toEqual(['m', 'f']);
    });

    it('joins the strokes of a multi-stroke glyph (t-bar, i-dot, second stroke of a 4)', () => {
        const { timers, flushed, grouper } = setup();
        // t: stem, then a crossbar overlapping the stem.
        grouper.add(boxStroke('t-stem', 0.4, 0.5, H * 0.15, H), ASPECT);
        grouper.add(boxStroke('t-bar', 0.4 - H * 0.25, 0.5 + H * 0.3, H * 0.65, H * 0.05), ASPECT);
        // i: stem to the right, then its dot above.
        const ix = 0.4 + H * 0.7;
        grouper.add(boxStroke('i-stem', ix, 0.5 + H * 0.3, H * 0.12, H * 0.7), ASPECT);
        grouper.add(boxStroke('i-dot', ix, 0.5, H * 0.12, H * 0.08), ASPECT);
        timers.fire();
        expect(flushed).toHaveLength(1);
        const group = flushed[0]!;
        expect(group.kind).toBe('line');
        expect(group.glyphs.map((g) => g.strokes.map((s) => s.id))).toEqual([
            ['t-stem', 't-bar'],
            ['i-stem', 'i-dot'],
        ]);
    });

    it('puts each writing line of a two-line note in its own object', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('l1a', 0.3, 0.5, H, H), ASPECT);
        grouper.add(boxStroke('l1b', 0.3 + 1.2 * H, 0.5, H, H), ASPECT);
        // Second line starts back at the left margin, 1.4 heights lower.
        grouper.add(boxStroke('l2a', 0.3, 0.5 + 1.4 * H, H, H), ASPECT);
        grouper.add(boxStroke('l2b', 0.3 + 1.2 * H, 0.5 + 1.4 * H, H, H), ASPECT);
        expect(flushed).toHaveLength(1);
        timers.fire();
        expect(flushed).toHaveLength(2);
        expect(groupStrokeIds(flushed[0]!)).toEqual(['l1a', 'l1b']);
        expect(groupStrokeIds(flushed[1]!)).toEqual(['l2a', 'l2b']);
    });

    it('drops marks too large to be print (expressive circles, brackets)', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('big', 0.2, 0.2, 0.1, MAX_GROUP_HEIGHT * 1.5), ASPECT);
        timers.fire();
        expect(flushed).toHaveLength(0);
    });

    it('drops a lone long horizontal line (hairpin / underline)', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('rule', 0.2, 0.5, 0.1, H * 0.3), ASPECT);
        timers.fire();
        expect(flushed).toHaveLength(0);
    });

    it('a stroke on another page or in another color closes the pending group', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('a', 0.3, 0.5, H, H), ASPECT);
        grouper.add(boxStroke('b', 0.3, 0.5, H, H, 1), ASPECT);
        expect(flushed).toHaveLength(1);
        expect(flushed[0]!.page).toBe(0);
        grouper.add(boxStroke('c', 0.3 + 1.2 * H, 0.5, H, H, 1, '#dc2626'), ASPECT);
        expect(flushed).toHaveLength(2);
        timers.fire();
        expect(flushed).toHaveLength(3);
        expect(flushed[2]!.color).toBe('#dc2626');
    });

    it('removing an erased stroke shrinks or cancels the pending group', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('a', 0.3, 0.5, H, H), ASPECT);
        grouper.add(boxStroke('b', 0.3 + 1.2 * H, 0.5, H, H), ASPECT);
        grouper.remove('b');
        expect(grouper.pendingIds()).toEqual(['a']);
        expect(timers.pending()).toEqual([LINE_PAUSE_MS]);
        grouper.remove('a');
        expect(grouper.pendingIds()).toEqual([]);
        timers.fire();
        expect(flushed).toHaveLength(0);
    });

    it('reports the group bbox back in normalized page coordinates', () => {
        const { timers, flushed, grouper } = setup();
        grouper.add(boxStroke('a', 0.3, 0.52, H, H), ASPECT);
        timers.fire();
        const bbox = groupBboxNormalized(flushed[0]!);
        expect(bbox.x).toBeCloseTo(0.3 - 0.0005, 4);
        expect(bbox.y).toBeCloseTo((0.52 - 0.0005) / ASPECT, 4);
        expect(bbox.w).toBeCloseTo(H + 0.001, 4);
        expect(bbox.h).toBeCloseTo((H + 0.001) / ASPECT, 4);
    });
});
