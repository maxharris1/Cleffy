import { describe, expect, it } from 'vitest';

import { buildProposals } from '@/features/import/proposals';
import { segmentPage } from '@/features/import/segmentation';
import { INK_BLUE, INK_RED, makeRaster, paintRect } from '@/test/rasterFixtures';
import { isTextPayload } from '@/types/models';

const DOC = 'doc-1';

/** Three blue digits in a run + one red bracket-ish mark. */
const makeSeg = () => {
    const raster = makeRaster(512, 256);
    paintRect(raster, 100, 30, 10, 14, INK_BLUE);
    paintRect(raster, 118, 30, 10, 14, INK_BLUE);
    paintRect(raster, 136, 30, 10, 14, INK_BLUE);
    paintRect(raster, 60, 120, 4, 40, INK_RED);
    const seg = segmentPage(raster, 2);
    expect(seg.clusters).toHaveLength(4);
    return seg;
};

describe('buildProposals — strokes-only degradation (no labels)', () => {
    it('vectorizes every cluster into stroke annotations with snapped colors', () => {
        const seg = makeSeg();
        const items = buildProposals(DOC, seg, null);
        expect(items).toHaveLength(4);
        for (const item of items) {
            expect(item.isText).toBe(false);
            expect(item.annotations.length).toBeGreaterThanOrEqual(1);
            for (const a of item.annotations) {
                expect(a.docId).toBe(DOC);
                expect(a.page).toBe(2);
                expect(a.kind).toBe('stroke');
                expect(a.seq).toBe(0);
                expect(a.deletedAt).toBeNull();
                expect(isTextPayload(a.payload)).toBe(false);
            }
        }
        const colors = new Set(items.map((i) => i.annotations[0]?.color));
        expect(colors.has('#2563eb')).toBe(true);
        expect(colors.has('#dc2626')).toBe(true);
    });
});

describe('buildProposals — with AI labels', () => {
    it('converts labeled digits to editable text and marks to ink; noise is dropped', () => {
        const seg = makeSeg();
        const [d1, d2, d3, mark] = seg.clusters.map((c) => c.id);
        const items = buildProposals(DOC, seg, {
            clusters: [
                { id: d1 ?? '', kind: 'digit', text: '3', confidence: 'high' },
                { id: d2 ?? '', kind: 'noise', confidence: 'high' },
                { id: d3 ?? '', kind: 'digit', text: '4', confidence: 'medium' },
                { id: mark ?? '', kind: 'mark', confidence: 'high' },
            ],
            runs: [],
        });
        expect(items).toHaveLength(3); // noise dropped
        const texts = items.filter((i) => i.isText);
        expect(texts).toHaveLength(2);
        const t1 = texts[0]?.annotations[0];
        expect(t1?.kind).toBe('text');
        expect(t1 && isTextPayload(t1.payload) && t1.payload.text).toBe('3');
        const ink = items.find((i) => !i.isText);
        expect(ink?.annotations[0]?.kind).toBe('stroke');
    });

    it('merges a run into one text annotation when the AI says treatAsOneText', () => {
        const seg = makeSeg();
        const runId = seg.clusters.find((c) => c.runId)?.runId ?? '';
        expect(runId).not.toBe('');
        const digitIds = seg.clusters.filter((c) => c.runId === runId).map((c) => c.id);
        const items = buildProposals(DOC, seg, {
            clusters: digitIds.map((id, i) => ({
                id,
                kind: 'digit' as const,
                text: String(i + 1),
                confidence: 'high' as const,
            })),
            runs: [{ id: runId, treatAsOneText: true, text: '123' }],
        });
        const runItem = items.find((i) => i.id === runId);
        expect(runItem?.isText).toBe(true);
        expect(runItem?.clusterIds).toHaveLength(3);
        const a = runItem?.annotations[0];
        expect(a && isTextPayload(a.payload) && a.payload.text).toBe('123');
        // Members are consumed — not proposed a second time individually.
        expect(items.filter((i) => digitIds.includes(i.id))).toHaveLength(0);
    });

    it('keeps run members separate when treatAsOneText is false', () => {
        const seg = makeSeg();
        const runId = seg.clusters.find((c) => c.runId)?.runId ?? '';
        const digitIds = seg.clusters.filter((c) => c.runId === runId).map((c) => c.id);
        const items = buildProposals(DOC, seg, {
            clusters: digitIds.map((id) => ({ id, kind: 'digit' as const, text: '2', confidence: 'high' as const })),
            runs: [{ id: runId, treatAsOneText: false }],
        });
        expect(items.filter((i) => digitIds.includes(i.id))).toHaveLength(3);
    });
});
