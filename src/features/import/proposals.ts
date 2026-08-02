import { snapToPalette } from '@/features/import/colorSnap';
import { textPayloadFromBbox } from '@/features/import/textFit';
import { vectorizeMask } from '@/features/import/vectorize';
import type {
    ClassifyResult,
    ClusterLabel,
    InkCluster,
    PageSegmentation,
    ProposedItem,
} from '@/features/import/importTypes';
import type { Annotation } from '@/types/models';

/**
 * Merge deterministic clusters with (optional) AI labels into reviewable
 * proposal items carrying ready-to-create native annotations. With no labels
 * (AI down / not configured / local doc) every cluster degrades to
 * vectorized ink strokes — the whole feature keeps working.
 */

const nowIso = (): string => new Date().toISOString();

const makeAnnotation = (
    docId: string,
    pageIndex: number,
    kind: 'stroke' | 'text',
    color: string,
    payload: Annotation['payload'],
): Annotation => ({
    id: crypto.randomUUID(),
    docId,
    page: pageIndex,
    kind,
    color,
    payload,
    createdBy: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    deletedAt: null,
    seq: 0,
});

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const unionBbox = (clusters: InkCluster[]): { x: number; y: number; w: number; h: number } => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of clusters) {
        x0 = Math.min(x0, c.bboxPx.x);
        y0 = Math.min(y0, c.bboxPx.y);
        x1 = Math.max(x1, c.bboxPx.x + c.bboxPx.w);
        y1 = Math.max(y1, c.bboxPx.y + c.bboxPx.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const strokesItem = (docId: string, seg: PageSegmentation, cluster: InkCluster): ProposedItem | null => {
    const payloads = vectorizeMask(cluster.mask, cluster.area, cluster.thicknessPx, seg.width, seg.height);
    if (payloads.length === 0) {
        return null;
    }
    const color = snapToPalette(cluster.meanColorHex);
    return {
        id: cluster.id,
        pageIndex: seg.pageIndex,
        clusterIds: [cluster.id],
        annotations: payloads.map((p) => makeAnnotation(docId, seg.pageIndex, 'stroke', color, p)),
        label: `${cluster.bucket} mark`,
        isText: false,
        confidence: null,
    };
};

const textItem = (
    docId: string,
    seg: PageSegmentation,
    clusters: InkCluster[],
    id: string,
    text: string,
    confidence: ProposedItem['confidence'],
): ProposedItem => {
    const bbox = unionBbox(clusters);
    // Median member height, not union height — one tall glyph must not inflate a run.
    const glyphHeight = median(clusters.map((c) => c.bboxPx.h));
    const payload = textPayloadFromBbox(bbox, glyphHeight, text, seg.width, seg.height);
    const color = snapToPalette(clusters[0]?.meanColorHex ?? '#1f2937');
    return {
        id,
        pageIndex: seg.pageIndex,
        clusterIds: clusters.map((c) => c.id),
        annotations: [makeAnnotation(docId, seg.pageIndex, 'text', color, payload)],
        label: `“${text}”`,
        isText: true,
        confidence,
    };
};

const isTextLabel = (label: ClusterLabel): boolean =>
    (label.kind === 'digit' || label.kind === 'text' || label.kind === 'articulation') &&
    typeof label.text === 'string' &&
    label.text.trim().length > 0;

/** Build review items for one page. `labels: null` → strokes-only degradation. */
export const buildProposals = (
    docId: string,
    seg: PageSegmentation,
    labels: ClassifyResult | null,
): ProposedItem[] => {
    if (!labels) {
        return seg.clusters
            .map((c) => strokesItem(docId, seg, c))
            .filter((item): item is ProposedItem => item !== null);
    }

    const labelById = new Map(labels.clusters.map((l) => [l.id, l]));
    const runById = new Map(labels.runs.map((r) => [r.id, r]));
    const items: ProposedItem[] = [];
    const consumed = new Set<string>();

    // Runs the AI wants as one text annotation ("34323", "cresc.").
    const byRun = new Map<string, InkCluster[]>();
    for (const cluster of seg.clusters) {
        if (cluster.runId) {
            const list = byRun.get(cluster.runId) ?? [];
            list.push(cluster);
            byRun.set(cluster.runId, list);
        }
    }
    for (const [runId, members] of byRun) {
        const decision = runById.get(runId);
        if (!decision?.treatAsOneText) {
            continue;
        }
        const sorted = [...members].sort((a, b) => a.bboxPx.x - b.bboxPx.x);
        const memberLabels = sorted.map((m) => labelById.get(m.id));
        const text =
            decision.text?.trim() ||
            memberLabels
                .map((l) => (l && isTextLabel(l) ? (l.text ?? '') : ''))
                .join('')
                .trim();
        if (!text) {
            continue; // fall through to per-cluster handling
        }
        const confidences = memberLabels.map((l) => l?.confidence ?? 'low');
        const confidence = confidences.includes('low') ? 'low' : confidences.includes('medium') ? 'medium' : 'high';
        items.push(textItem(docId, seg, sorted, runId, text, confidence));
        for (const m of sorted) {
            consumed.add(m.id);
        }
    }

    for (const cluster of seg.clusters) {
        if (consumed.has(cluster.id)) {
            continue;
        }
        const label = labelById.get(cluster.id);
        if (label?.kind === 'noise') {
            continue;
        }
        if (label && isTextLabel(label)) {
            items.push(textItem(docId, seg, [cluster], cluster.id, (label.text ?? '').trim(), label.confidence));
            continue;
        }
        // 'mark', unknown id, or unusable text → ink strokes.
        const item = strokesItem(docId, seg, cluster);
        if (item) {
            items.push({ ...item, confidence: label?.confidence ?? null });
        }
    }

    return items;
};
