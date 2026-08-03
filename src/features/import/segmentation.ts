import type {
    ColorBucket,
    DetectionRaster,
    InkCluster,
    PageSegmentation,
    PageSegmentationFlags,
    RleMask,
} from '@/features/import/importTypes';

/**
 * Deterministic colored-ink segmentation. Printed music and paper are
 * near-neutral (low chroma); pen annotations are saturated — so a chroma
 * mask plus connected components finds handwriting without any model.
 * All pure array math: no canvas, no DOM (unit-testable in jsdom).
 */

/** Min max(R,G,B)−min(R,G,B) for a pixel to count as ink (beige paper ≈ 10–25, JPEG fringe < 35). */
export const CHROMA_MIN = 40;
/** Saturation floor — OR'd with CHROMA_STRONG so dark saturated ink (navy) still passes. */
export const SAT_MIN = 0.28;
export const CHROMA_STRONG = 64;
/** Value floor: kill chroma noise inside solid black print. (Near-white casts die on SAT_MIN.) */
export const VALUE_MIN = 0.12;

/** Components smaller than this many ink px are dust/JPEG specks. */
export const MIN_COMPONENT_AREA_PX = 12;
/** Components with bbox above this fraction of the page are stamps/plates, not handwriting. */
export const MAX_COMPONENT_FRAC = 0.35;
/** If more of the page than this is chromatic, it's a photo/color scan — skip it. */
export const MAX_INK_FRAC = 0.08;
/** Bbox dilation when merging multi-stroke glyphs (a two-stroke "5", a dotted "i"). */
export const GLYPH_MERGE_GAP_PX = 6;
/** Run grouping: min vertical overlap (fraction of the shorter height). */
export const RUN_VOVERLAP = 0.5;
/** Run grouping: max horizontal gap as a multiple of the median member width. */
export const RUN_GAP_FACTOR = 1.2;
/**
 * Per-page cluster cap — a UI/memory bound, not an expectation. A real
 * teacher-fingered page (KV 330 NMA scans) carries 300–450 digit glyphs, so
 * this must sit well above that; pathological colored-texture pages are
 * already rejected earlier by MAX_INK_FRAC / MIN_COMPONENT_AREA_PX.
 */
export const MAX_CLUSTERS_PER_PAGE = 500;

const BUCKETS: readonly ColorBucket[] = ['red', 'yellow', 'green', 'blue', 'purple'];

/** HSV hue (0–360) → 1-based bucket index into BUCKETS. */
const bucketOfHue = (h: number): number => {
    if (h < 25 || h >= 330) {
        return 1; // red
    }
    if (h < 80) {
        return 2; // yellow/orange
    }
    if (h < 170) {
        return 3; // green
    }
    if (h < 265) {
        return 4; // blue
    }
    return 5; // purple
};

/**
 * Per-pixel chromatic-ink mask: 0 = background/print, 1–5 = ColorBucket index+1.
 * Exported for tests; segmentPage consumes it destructively.
 */
export const buildInkMask = (raster: DetectionRaster): { mask: Uint8Array; inkCount: number } => {
    const { data, width, height } = raster;
    const mask = new Uint8Array(width * height);
    let inkCount = 0;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        const r = data[p] ?? 0;
        const g = data[p + 1] ?? 0;
        const b = data[p + 2] ?? 0;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const chroma = mx - mn;
        if (chroma < CHROMA_MIN) {
            continue;
        }
        const v = mx / 255;
        if (v < VALUE_MIN) {
            continue;
        }
        const s = mx === 0 ? 0 : chroma / mx;
        if (s < SAT_MIN && chroma < CHROMA_STRONG) {
            continue;
        }
        let h: number;
        if (mx === r) {
            h = 60 * (((g - b) / chroma + 6) % 6);
        } else if (mx === g) {
            h = 60 * ((b - r) / chroma + 2);
        } else {
            h = 60 * ((r - g) / chroma + 4);
        }
        mask[i] = bucketOfHue(h);
        inkCount++;
    }
    return { mask, inkCount };
};

interface Component {
    pixels: number[]; // raster indices
    area: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    bucketCounts: number[]; // index 1..5
    rSum: number;
    gSum: number;
    bSum: number;
}

/** 8-connected components over the mask; consumes (zeroes) the mask as it goes. */
const collectComponents = (mask: Uint8Array, raster: DetectionRaster): Component[] => {
    const { data, width, height } = raster;
    const components: Component[] = [];
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if ((mask[start] ?? 0) === 0) {
            continue;
        }
        const comp: Component = {
            pixels: [],
            area: 0,
            minX: width,
            minY: height,
            maxX: 0,
            maxY: 0,
            bucketCounts: [0, 0, 0, 0, 0, 0],
            rSum: 0,
            gSum: 0,
            bSum: 0,
        };
        stack.push(start);
        while (stack.length > 0) {
            const idx = stack.pop() ?? 0;
            const bucket = mask[idx] ?? 0;
            if (bucket === 0) {
                continue;
            }
            mask[idx] = 0;
            comp.pixels.push(idx);
            comp.area++;
            comp.bucketCounts[bucket] = (comp.bucketCounts[bucket] ?? 0) + 1;
            const p = idx * 4;
            comp.rSum += data[p] ?? 0;
            comp.gSum += data[p + 1] ?? 0;
            comp.bSum += data[p + 2] ?? 0;
            const x = idx % width;
            const y = (idx - x) / width;
            if (x < comp.minX) comp.minX = x;
            if (y < comp.minY) comp.minY = y;
            if (x > comp.maxX) comp.maxX = x;
            if (y > comp.maxY) comp.maxY = y;
            const x0 = x > 0 ? -1 : 0;
            const x1 = x < width - 1 ? 1 : 0;
            const y0 = y > 0 ? -1 : 0;
            const y1 = y < height - 1 ? 1 : 0;
            for (let dy = y0; dy <= y1; dy++) {
                for (let dx = x0; dx <= x1; dx++) {
                    if (dx === 0 && dy === 0) {
                        continue;
                    }
                    const n = idx + dy * width + dx;
                    if ((mask[n] ?? 0) !== 0) {
                        stack.push(n);
                    }
                }
            }
        }
        components.push(comp);
    }
    return components;
};

const dominantBucket = (counts: readonly number[]): number => {
    let best = 1;
    let bestCount = -1;
    for (let b = 1; b <= 5; b++) {
        const c = counts[b] ?? 0;
        if (c > bestCount) {
            bestCount = c;
            best = b;
        }
    }
    return best;
};

const bboxesTouchDilated = (a: Component, b: Component, gap: number): boolean =>
    a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY;

/** Union-find glyph merge: same hue family + dilated bboxes intersect. */
const mergeComponents = (components: Component[]): Component[] => {
    const parent = components.map((_, i) => i);
    const find = (i: number): number => {
        let root = i;
        while ((parent[root] ?? root) !== root) {
            root = parent[root] ?? root;
        }
        // Path compression.
        let cur = i;
        while ((parent[cur] ?? cur) !== root) {
            const next = parent[cur] ?? cur;
            parent[cur] = root;
            cur = next;
        }
        return root;
    };
    for (let i = 0; i < components.length; i++) {
        const a = components[i];
        if (!a) continue;
        for (let j = i + 1; j < components.length; j++) {
            const b = components[j];
            if (!b) continue;
            if (dominantBucket(a.bucketCounts) !== dominantBucket(b.bucketCounts)) {
                continue;
            }
            if (bboxesTouchDilated(a, b, GLYPH_MERGE_GAP_PX)) {
                const ra = find(i);
                const rb = find(j);
                if (ra !== rb) {
                    parent[rb] = ra;
                }
            }
        }
    }
    const merged = new Map<number, Component>();
    for (let i = 0; i < components.length; i++) {
        const comp = components[i];
        if (!comp) continue;
        const root = find(i);
        const into = merged.get(root);
        if (!into) {
            merged.set(root, {
                ...comp,
                pixels: [...comp.pixels],
                bucketCounts: [...comp.bucketCounts],
            });
            continue;
        }
        into.pixels.push(...comp.pixels);
        into.area += comp.area;
        into.minX = Math.min(into.minX, comp.minX);
        into.minY = Math.min(into.minY, comp.minY);
        into.maxX = Math.max(into.maxX, comp.maxX);
        into.maxY = Math.max(into.maxY, comp.maxY);
        for (let b = 1; b <= 5; b++) {
            into.bucketCounts[b] = (into.bucketCounts[b] ?? 0) + (comp.bucketCounts[b] ?? 0);
        }
        into.rSum += comp.rSum;
        into.gSum += comp.gSum;
        into.bSum += comp.bSum;
    }
    return [...merged.values()];
};

/** Build an RLE mask (bbox-relative) from a component's raster pixel indices. */
const rleFromPixels = (comp: Component, rasterWidth: number): RleMask => {
    const sorted = Int32Array.from(comp.pixels).sort();
    const runs: number[] = [];
    let runRow = -1;
    let runStart = -1;
    let runLen = 0;
    for (let i = 0; i < sorted.length; i++) {
        const idx = sorted[i] ?? 0;
        const x = idx % rasterWidth;
        const y = (idx - x) / rasterWidth;
        if (y === runRow && x === runStart + runLen) {
            runLen++;
            continue;
        }
        if (runLen > 0) {
            runs.push(runRow - comp.minY, runStart - comp.minX, runLen);
        }
        runRow = y;
        runStart = x;
        runLen = 1;
    }
    if (runLen > 0) {
        runs.push(runRow - comp.minY, runStart - comp.minX, runLen);
    }
    return {
        x: comp.minX,
        y: comp.minY,
        w: comp.maxX - comp.minX + 1,
        h: comp.maxY - comp.minY + 1,
        runs: Int32Array.from(runs),
    };
};

/**
 * Rasterized perimeter of an RLE mask (exposed cell edges). For a long
 * stroke of width t this ≈ 2·length, so 2·area/perimeter ≈ t.
 */
export const rlePerimeter = (mask: RleMask): number => {
    // Per-row run lists for vertical-exposure lookups.
    const rows: [number, number][][] = Array.from({ length: mask.h }, () => []);
    const runs = mask.runs;
    for (let i = 0; i < runs.length; i += 3) {
        const row = runs[i] ?? 0;
        rows[row]?.push([runs[i + 1] ?? 0, runs[i + 2] ?? 0]);
    }
    const overlapWithRow = (start: number, len: number, row: [number, number][] | undefined): number => {
        if (!row) {
            return 0;
        }
        let covered = 0;
        for (const [s, l] of row) {
            const lo = Math.max(start, s);
            const hi = Math.min(start + len, s + l);
            if (hi > lo) {
                covered += hi - lo;
            }
        }
        return covered;
    };
    let perimeter = 0;
    for (let r = 0; r < mask.h; r++) {
        for (const [s, l] of rows[r] ?? []) {
            perimeter += 2; // left + right ends
            perimeter += l - overlapWithRow(s, l, rows[r - 1]); // exposed top
            perimeter += l - overlapWithRow(s, l, rows[r + 1]); // exposed bottom
        }
    }
    return perimeter;
};

const toHex = (v: number): string => Math.round(v).toString(16).padStart(2, '0');

/** Greedy left-to-right chaining of same-color clusters on one text line. */
const assignRuns = (clusters: InkCluster[], pageIndex: number): void => {
    const byX = [...clusters].sort((a, b) => a.bboxPx.x - b.bboxPx.x);
    const used = new Set<string>();
    let runCounter = 0;
    for (const seed of byX) {
        if (used.has(seed.id)) {
            continue;
        }
        const members = [seed];
        used.add(seed.id);
        for (const candidate of byX) {
            if (used.has(candidate.id)) {
                continue;
            }
            const last = members[members.length - 1];
            if (!last || candidate.bucket !== seed.bucket) {
                continue;
            }
            const gap = candidate.bboxPx.x - (last.bboxPx.x + last.bboxPx.w);
            if (gap < 0) {
                continue;
            }
            const widths = members.map((m) => m.bboxPx.w).sort((a, b) => a - b);
            const median = widths[Math.floor(widths.length / 2)] ?? 1;
            if (gap > RUN_GAP_FACTOR * Math.max(median, candidate.bboxPx.w)) {
                continue;
            }
            const top = Math.max(candidate.bboxPx.y, last.bboxPx.y);
            const bottom = Math.min(candidate.bboxPx.y + candidate.bboxPx.h, last.bboxPx.y + last.bboxPx.h);
            const overlap = bottom - top;
            if (overlap < RUN_VOVERLAP * Math.min(candidate.bboxPx.h, last.bboxPx.h)) {
                continue;
            }
            members.push(candidate);
            used.add(candidate.id);
        }
        if (members.length >= 2) {
            const runId = `p${pageIndex}r${runCounter++}`;
            for (const m of members) {
                m.runId = runId;
            }
        }
    }
};

/** Full deterministic pass over one rendered page. */
export const segmentPage = (raster: DetectionRaster, pageIndex: number): PageSegmentation => {
    const { width, height } = raster;
    const flags: PageSegmentationFlags = { tooColorful: false, largeColorRegion: false, dense: false };
    const { mask, inkCount } = buildInkMask(raster);
    if (inkCount > MAX_INK_FRAC * width * height) {
        flags.tooColorful = true;
        return { pageIndex, width, height, clusters: [], flags };
    }

    let components = collectComponents(mask, raster);
    components = components.filter((c) => {
        const w = c.maxX - c.minX + 1;
        const h = c.maxY - c.minY + 1;
        if (c.area < MIN_COMPONENT_AREA_PX || (w < 3 && h < 3)) {
            return false; // dust
        }
        if (w > MAX_COMPONENT_FRAC * width || h > MAX_COMPONENT_FRAC * height) {
            flags.largeColorRegion = true;
            return false;
        }
        return true;
    });

    let merged = mergeComponents(components);
    // Re-check size after merging: a merged cluster can also exceed the cap.
    merged = merged.filter((c) => {
        const w = c.maxX - c.minX + 1;
        const h = c.maxY - c.minY + 1;
        if (w > MAX_COMPONENT_FRAC * width || h > MAX_COMPONENT_FRAC * height) {
            flags.largeColorRegion = true;
            return false;
        }
        return true;
    });

    if (merged.length > MAX_CLUSTERS_PER_PAGE) {
        flags.dense = true;
        merged.sort((a, b) => b.area - a.area);
        merged = merged.slice(0, MAX_CLUSTERS_PER_PAGE);
    }

    // Stable reading order: top-to-bottom, then left-to-right.
    merged.sort((a, b) => a.minY - b.minY || a.minX - b.minX);

    const clusters: InkCluster[] = merged.map((comp, n) => {
        const rle = rleFromPixels(comp, width);
        const perimeter = rlePerimeter(rle);
        return {
            id: `p${pageIndex}c${n}`,
            pageIndex,
            bboxPx: { x: rle.x, y: rle.y, w: rle.w, h: rle.h },
            mask: rle,
            area: comp.area,
            bucket: BUCKETS[dominantBucket(comp.bucketCounts) - 1] ?? 'red',
            meanColorHex: `#${toHex(comp.rSum / comp.area)}${toHex(comp.gSum / comp.area)}${toHex(comp.bSum / comp.area)}`,
            thicknessPx: perimeter > 0 ? (2 * comp.area) / perimeter : 1,
            runId: null,
        };
    });

    assignRuns(clusters, pageIndex);
    return { pageIndex, width, height, clusters, flags };
};

/** Iterate the absolute raster pixel coords of an RLE mask. */
export const forEachRlePixel = (mask: RleMask, fn: (x: number, y: number) => void): void => {
    const runs = mask.runs;
    for (let i = 0; i < runs.length; i += 3) {
        const y = mask.y + (runs[i] ?? 0);
        const start = mask.x + (runs[i + 1] ?? 0);
        const len = runs[i + 2] ?? 0;
        for (let x = start; x < start + len; x++) {
            fn(x, y);
        }
    }
};
