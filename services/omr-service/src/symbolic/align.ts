import { printedBarCountFromMeasures } from './signals.js';
import type { BarBox } from './pdfLayout.js';
import type { ScoreData } from '../scoreData.js';

export interface AlignBox {
    page: number;
    system: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

export interface AlignmentEntry {
    printedBar: number;
    performedBar: number;
    page: number;
    system: number;
    box: AlignBox;
}

export interface AlignmentMap {
    pdfSha256: string;
    candidateSha256: string;
    pickup: boolean;
    printedBars: number;
    /** `candidateMeasure.srcIndex` → printed page/system/box. */
    bySrcIndex: Record<number, AlignBox>;
    entries: AlignmentEntry[];
}

export type AlignResult = { ok: true; map: AlignmentMap } | { ok: false; reason: 'alignment_failed' };

const asBox = (box: BarBox): AlignBox => ({
    page: box.page,
    system: box.system,
    x0: box.x0,
    x1: box.x1,
    y0: box.y0,
    y1: box.y1,
});

const uniqueSrcOrder = (score: ScoreData): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < score.measures.length; i++) {
        const src = score.measures[i]?.srcIndex ?? i;
        if (seen.has(src)) {
            continue;
        }
        seen.add(src);
        out.push(src);
    }
    return out;
};

/**
 * Same-source Mutopia alignment: printed bar boxes in page order map onto
 * engraved `srcIndex` values. Performed measures that share a srcIndex (repeats
 * unrolled by `repeats.ts` / `buildScoreData`) highlight the same box.
 */
export const alignMutopia = (
    layout: { boxes: readonly BarBox[]; pickupFlagged: boolean; printedBars: number },
    score: ScoreData,
    pdfSha256: string,
    candidateSha256: string,
): AlignResult => {
    const printed = printedBarCountFromMeasures(score.measures);
    if (Math.abs(layout.printedBars - printed) > 1) {
        return { ok: false, reason: 'alignment_failed' };
    }
    const srcOrder = uniqueSrcOrder(score);
    if (Math.abs(layout.boxes.length - srcOrder.length) > 1) {
        return { ok: false, reason: 'alignment_failed' };
    }
    const n = Math.min(layout.boxes.length, srcOrder.length);
    const bySrcIndex: Record<number, AlignBox> = {};
    for (let i = 0; i < n; i++) {
        const src = srcOrder[i];
        const box = layout.boxes[i];
        if (src === undefined || box === undefined) {
            continue;
        }
        bySrcIndex[src] = asBox(box);
    }
    const entries: AlignmentEntry[] = [];
    for (let i = 0; i < score.measures.length; i++) {
        const src = score.measures[i]?.srcIndex ?? i;
        const box = bySrcIndex[src];
        if (!box) {
            continue;
        }
        entries.push({
            printedBar: src,
            performedBar: i,
            page: box.page,
            system: box.system,
            box,
        });
    }
    return {
        ok: true,
        map: {
            pdfSha256,
            candidateSha256,
            pickup: layout.pickupFlagged,
            printedBars: n,
            bySrcIndex,
            entries,
        },
    };
};
