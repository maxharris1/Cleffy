/**
 * $P point-cloud matcher (Vatavu, Anthony & Wobbrock 2012) for multi-stroke
 * glyphs. Stroke order and direction do not matter — a `4` drawn in either
 * order, a `t` crossed first or last, all become the same cloud.
 *
 * Every glyph is resampled to N points along its total path length, scaled
 * UNIFORMLY (a thin `1` must stay thin — non-uniform scaling would turn it
 * into a square blob), and translated to its centroid. The distance is the
 * greedy point-to-point matching cost of the original paper; lower is better
 * and 0 is a perfect match.
 */

export type Point = readonly [x: number, y: number];

/** One glyph: several polylines in the same coordinate frame. */
export type GlyphStrokes = readonly (readonly Point[])[];

export const CLOUD_POINTS = 32;

const pathLength = (strokes: GlyphStrokes): number => {
    let total = 0;
    for (const stroke of strokes) {
        for (let i = 1; i < stroke.length; i++) {
            const a = stroke[i - 1]!;
            const b = stroke[i]!;
            total += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
    }
    return total;
};

/** Resample the whole glyph to `n` equidistant points (strokes concatenated, no bridging segments). */
export const resample = (strokes: GlyphStrokes, n = CLOUD_POINTS): Point[] => {
    const nonEmpty = strokes.filter((s) => s.length > 0);
    if (nonEmpty.length === 0) {
        return [];
    }
    const total = pathLength(nonEmpty);
    if (total === 0) {
        const p = nonEmpty[0]![0]!;
        return Array.from({ length: n }, () => p);
    }
    const interval = total / (n - 1);
    const out: Point[] = [nonEmpty[0]![0]!];
    let carried = 0;
    for (const stroke of nonEmpty) {
        for (let i = 1; i < stroke.length; i++) {
            let [ax, ay] = stroke[i - 1]!;
            const [bx, by] = stroke[i]!;
            let seg = Math.hypot(bx - ax, by - ay);
            while (carried + seg >= interval && out.length < n) {
                const t = (interval - carried) / seg;
                const qx = ax + t * (bx - ax);
                const qy = ay + t * (by - ay);
                out.push([qx, qy]);
                ax = qx;
                ay = qy;
                seg = Math.hypot(bx - ax, by - ay);
                carried = 0;
            }
            carried += seg;
        }
    }
    while (out.length < n) {
        out.push(out[out.length - 1]!);
    }
    return out;
};

/** Uniform scale to a unit box (longest side 1) then centroid at the origin. */
export const normalize = (points: readonly Point[]): Point[] => {
    if (points.length === 0) {
        return [];
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    const scale = Math.max(maxX - minX, maxY - minY) || 1;
    const scaled = points.map(([x, y]): Point => [(x - minX) / scale, (y - minY) / scale]);
    let cx = 0;
    let cy = 0;
    for (const [x, y] of scaled) {
        cx += x;
        cy += y;
    }
    cx /= scaled.length;
    cy /= scaled.length;
    return scaled.map(([x, y]): Point => [x - cx, y - cy]);
};

/** Resample + normalize: the comparable form of a glyph. */
export const toCloud = (strokes: GlyphStrokes, n = CLOUD_POINTS): Point[] => normalize(resample(strokes, n));

const cloudMatch = (a: readonly Point[], b: readonly Point[], start: number): number => {
    const n = a.length;
    const matched = new Array<boolean>(n).fill(false);
    let sum = 0;
    let i = start;
    do {
        let best = Infinity;
        let index = -1;
        for (let j = 0; j < n; j++) {
            if (matched[j]) {
                continue;
            }
            const dx = a[i]![0] - b[j]![0];
            const dy = a[i]![1] - b[j]![1];
            const d = dx * dx + dy * dy;
            if (d < best) {
                best = d;
                index = j;
            }
        }
        matched[index] = true;
        // Earlier matches weigh more (paper's confidence weight).
        const weight = 1 - ((i - start + n) % n) / n;
        sum += weight * Math.sqrt(best);
        i = (i + 1) % n;
    } while (i !== start);
    return sum;
};

/** Greedy cloud distance, symmetric, minimised over sqrt(n) start points. Lower is better. */
export const cloudDistance = (a: readonly Point[], b: readonly Point[]): number => {
    const n = Math.min(a.length, b.length);
    if (n === 0) {
        return Infinity;
    }
    const step = Math.max(1, Math.floor(Math.sqrt(n)));
    let best = Infinity;
    for (let start = 0; start < n; start += step) {
        best = Math.min(best, cloudMatch(a, b, start), cloudMatch(b, a, start));
    }
    return best / n;
};
