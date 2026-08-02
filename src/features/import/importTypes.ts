import type { Annotation } from '@/types/models';

/**
 * Shared types for the "smart import" pipeline: detecting handwritten
 * annotations already present in an uploaded score and adopting them as
 * native, editable annotations.
 *
 * Geometry convention: detection rasters are rendered from the ROTATED
 * pdf.js viewport (same as the viewer), so raster px ÷ raster dims are
 * exactly the app's normalized 0–1 annotation coordinates.
 */

/** RGBA pixels of one rendered page, decoupled from any canvas. */
export interface DetectionRaster {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/** Hue families we bucket ink into (printed music is near-neutral and never lands here). */
export type ColorBucket = 'red' | 'yellow' | 'green' | 'blue' | 'purple';

/**
 * Run-length-encoded pixel mask, relative to its bounding box.
 * `runs` is flat [rowOffset, startColOffset, length] triplets, row-major.
 */
export interface RleMask {
    x: number;
    y: number;
    w: number;
    h: number;
    runs: Int32Array;
}

/** One detected blob of colored ink (a glyph, a bracket, a stray mark…). */
export interface InkCluster {
    /** Stable within one scan: `p{page}c{n}`. */
    id: string;
    pageIndex: number;
    /** Bounding box in detection-raster pixels. */
    bboxPx: { x: number; y: number; w: number; h: number };
    mask: RleMask;
    /** Ink pixel count. */
    area: number;
    bucket: ColorBucket;
    /** Mean ink color as #rrggbb. */
    meanColorHex: string;
    /** Estimated pen thickness in raster px (2·area/perimeter). */
    thicknessPx: number;
    /** Run-grouping hint: clusters sharing a runId sit on one horizontal line (e.g. "34323"). */
    runId: string | null;
    /** Local paper color behind the ink (sampled while the raster is in hand; used for cleanup patches). */
    bgColorHex?: string;
}

export interface PageSegmentationFlags {
    /** Page looks like a color photo/plate — skipped entirely. */
    tooColorful: boolean;
    /** At least one huge colored region (stamp, cover art) was discarded. */
    largeColorRegion: boolean;
    /** More clusters than the cap; smallest were dropped. */
    dense: boolean;
}

export interface PageSegmentation {
    pageIndex: number;
    /** Raster dimensions the cluster geometry refers to. */
    width: number;
    height: number;
    clusters: InkCluster[];
    flags: PageSegmentationFlags;
}

// ---------------------------------------------------------------------------
// Classification (AI or degraded strokes-only mode).

export interface ClusterLabel {
    id: string;
    kind: 'digit' | 'text' | 'articulation' | 'mark' | 'noise';
    /** Recognized characters for digit/text/articulation (e.g. "3", "34323", "tr"). */
    text?: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface RunLabel {
    id: string;
    /** True: the whole run is one text annotation ("34323" over a trill). */
    treatAsOneText: boolean;
    text?: string;
}

export interface ClassifyResult {
    clusters: ClusterLabel[];
    runs: RunLabel[];
}

/** Page-level classifier; resolves null when the AI is unavailable (degrade to strokes-only). */
export type ClassifyFn = (
    segmentation: PageSegmentation,
    raster: DetectionRaster,
    signal?: AbortSignal,
) => Promise<ClassifyResult | null>;

// ---------------------------------------------------------------------------
// Proposals (review units) and the whole-document scan result.

/** One reviewable unit: a glyph, a text run, or a vectorized mark (1..n annotations). */
export interface ProposedItem {
    /** Stable review id (cluster id or run id). */
    id: string;
    pageIndex: number;
    /** Source clusters (empty for born-digital PDF annotations). */
    clusterIds: string[];
    /** Ready-to-create native annotations (fresh UUIDs, docId set, seq 0). */
    annotations: Annotation[];
    /** Short human label for the review list, e.g. '“3”' or 'ink mark'. */
    label: string;
    isText: boolean;
    confidence: 'high' | 'medium' | 'low' | null;
}

export interface PageProposal {
    pageIndex: number;
    rasterWidth: number;
    rasterHeight: number;
    items: ProposedItem[];
    /** Kept for the cleanup pass (masks + background colors); rasters are NOT retained. */
    segmentation: PageSegmentation;
    /** PDF annotation subtypes converted on this page — stripped from the rebuilt file. */
    stripSubtypes: string[];
}

export interface ImportProposal {
    docId: string;
    pages: PageProposal[];
    /** True when classification was skipped/failed → marks imported as ink only. */
    aiDegraded: boolean;
    /** Pages that rasterized ≥99.5% white (undecodable scan or genuinely blank). */
    unreadablePages: number[];
    tooColorfulPages: number[];
}

/** Clean-and-replace step (M5): lift accepted ink off the page and swap the stored file. */
export type CleanFn = (
    proposal: ImportProposal,
    acceptedItems: ProposedItem[],
    onStep: (step: 'rebuild' | 'upload') => void,
) => Promise<void>;

export type ImportStatus =
    | { kind: 'idle' }
    | { kind: 'scanning'; page: number; pageCount: number }
    | { kind: 'classifying'; page: number; pageCount: number }
    | { kind: 'review'; proposal: ImportProposal }
    | { kind: 'applying'; step: 'annotations' | 'rebuild' | 'upload' }
    | { kind: 'done'; created: number; cleaned: boolean }
    | { kind: 'nothing-found'; unreadablePages: number[]; tooColorfulPages: number[] }
    | { kind: 'error'; message: string };
