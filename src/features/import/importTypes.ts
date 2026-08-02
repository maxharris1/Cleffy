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
