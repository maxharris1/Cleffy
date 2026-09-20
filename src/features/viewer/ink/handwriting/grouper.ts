import { strokeBbox } from '@/features/viewer/geometry';

/**
 * Groups the writer's COMMITTED pen strokes into candidate print objects.
 *
 * Runs after pointer-up only (never mid-stroke, never on highlighter). Strokes
 * are held until a pause or a spatially new mark, then flushed as ONE group:
 *
 * - a writing line of ≥2 letter-sized glyphs with small gaps → one `line`
 *   group (one text row, so a note drags as a unit);
 * - a small isolated glyph (fingering, single dynamic) → one `glyph` group;
 * - each writing line is its own group (multi-line notes = several rows).
 *
 * All geometry is in page-WIDTH units: x is already normalized against the
 * width, y is multiplied by the page aspect (height / width) so gaps in either
 * axis compare against the same glyph height.
 */

/** A committed stroke as the grouper sees it (normalized page coords). */
export interface InkStroke {
    id: string;
    page: number;
    color: string;
    /** Flat [x, y, p, …] normalized triplets. */
    pts: number[];
    /** Base width / page width. */
    w: number;
    /** Commit time (ms). */
    at: number;
}

/** Axis-aligned box in page-width units. */
export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface Glyph {
    strokes: InkStroke[];
    box: Box;
}

export type GroupKind = 'line' | 'glyph';

export interface StrokeGroup {
    page: number;
    color: string;
    /** Page height / page width, so callers can map the box back to normalized y. */
    aspect: number;
    /** Left-to-right glyphs of the group. */
    glyphs: Glyph[];
    kind: GroupKind;
    box: Box;
}

/**
 * Pause after which a pending group flushes. Lone `p`/`f` must wait as long as
 * a writing line, otherwise `mf`/`pp`/`ff` cannot be written — the first
 * letter would convert as a glyph and steal the second stroke's window.
 * A spatially new mark still flushes immediately (`add` → `flush`).
 */
export const LINE_PAUSE_MS = 1000;
/** @deprecated Same as `LINE_PAUSE_MS` — lone glyphs share the line pause. */
export const GLYPH_PAUSE_MS = LINE_PAUSE_MS;

/** Marks taller than this (fraction of page width) are expressive ink, not print. */
export const MAX_GROUP_HEIGHT = 0.05;
/** Marks smaller than this are strays (a lone dot). */
export const MIN_GROUP_HEIGHT = 0.003;
/** A lone glyph wider than this many heights is a line/hairpin, not a character. */
const MAX_LONE_GLYPH_ASPECT = 6;
/** Hard cap on glyphs per line, so a page of scribble never becomes one text. */
const MAX_LINE_GLYPHS = 24;

/** Horizontal gap (in glyph heights) under which two strokes are one glyph. */
const GLYPH_JOIN_GAP = 0.15;
/** Vertical gap (in glyph heights) tolerated when joining (i-dot, t-bar). */
const GLYPH_JOIN_VGAP = 0.4;
/** Horizontal gap (in line heights) under which a new glyph continues the line. */
const WORD_GAP = 1.0;
/**
 * Compact tall marks (fingerings) this far apart are separate objects, even
 * when the gap is under `WORD_GAP`. Chord `1 3 5` sits closer than a word
 * space; treating them as one line would skip the closed set and bill Gemini.
 */
export const FINGERING_GAP = 0.4;
/** Width/height at or under which a glyph is digit-shaped (not a square letter). */
const DIGIT_MAX_ASPECT = 0.85;
/** New glyph centre must sit within this many line heights of the line centre. */
const LINE_BAND = 0.6;

const width = (b: Box): number => b.x1 - b.x0;
const height = (b: Box): number => b.y1 - b.y0;
const centerY = (b: Box): number => (b.y0 + b.y1) / 2;

const union = (a: Box, b: Box): Box => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
});

/** Positive distance between intervals, 0 when they overlap. */
const gap = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/** Stroke bbox in page-width units (half the pen width padded on every side). */
export const strokeBox = (stroke: InkStroke, aspect: number): Box => {
    const [minX, minY, maxX, maxY] = strokeBbox(stroke.pts);
    const r = stroke.w / 2;
    return { x0: minX - r, y0: minY * aspect - r, x1: maxX + r, y1: maxY * aspect + r };
};

const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** Does this stroke belong to an existing glyph (t-bar, i-dot, the second stroke of a 4)? */
const joinsGlyph = (glyph: Glyph, box: Box): boolean => {
    const ref = Math.max(height(glyph.box), height(box), 1e-6);
    const xGap = gap(glyph.box.x0, glyph.box.x1, box.x0, box.x1);
    const yGap = gap(glyph.box.y0, glyph.box.y1, box.y0, box.y1);
    if (xGap > GLYPH_JOIN_GAP * ref || yGap > GLYPH_JOIN_VGAP * ref) {
        return false;
    }
    if (yGap > 0) {
        // Stacked parts (dot over a stem) must share x, and one of them must
        // be a fragment — two full letters one above the other are two lines.
        return xGap === 0 && Math.min(height(glyph.box), height(box)) < 0.45 * ref;
    }
    if (xGap > 0) {
        // Side by side but nearly touching: only when the newcomer is small
        // (a stroke fragment), never a full neighbouring letter.
        return width(box) < 0.6 * ref || height(box) < 0.6 * ref;
    }
    // Overlapping boxes: same glyph unless they merely brush edges (adjacent
    // letters written tight). Require real horizontal overlap.
    const overlap = Math.min(glyph.box.x1, box.x1) - Math.max(glyph.box.x0, box.x0);
    return overlap >= 0.4 * Math.min(width(glyph.box), width(box));
};

const isDigitShaped = (b: Box): boolean => {
    const h = height(b);
    return h > 0 && width(b) <= DIGIT_MAX_ASPECT * h;
};

/** Does a new glyph continue the pending writing line? */
const continuesLine = (lineBox: Box, box: Box, lastBox: Box): boolean => {
    const lineH = Math.max(height(lineBox), 1e-6);
    if (Math.abs(centerY(box) - centerY(lineBox)) > LINE_BAND * lineH) {
        return false;
    }
    const xGap = gap(lineBox.x0, lineBox.x1, box.x0, box.x1);
    if (isDigitShaped(box) && isDigitShaped(lastBox)) {
        const ref = Math.max(height(box), height(lastBox), 1e-6);
        if (xGap > FINGERING_GAP * ref) {
            return false;
        }
    }
    return xGap <= WORD_GAP * lineH;
};

export interface GrouperOptions {
    onFlush: (group: StrokeGroup) => void;
    /** Timer injection for tests. */
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
}

interface Pending {
    page: number;
    color: string;
    aspect: number;
    glyphs: Glyph[];
    box: Box;
    timer: unknown;
}

export class HandwritingGrouper {
    private pending: Pending | null = null;
    private readonly schedule: (fn: () => void, ms: number) => unknown;
    private readonly cancel: (handle: unknown) => void;

    constructor(private readonly opts: GrouperOptions) {
        this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.cancel = opts.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    /** Hold a freshly committed stroke. `aspect` = page height / page width. */
    add(stroke: InkStroke, aspect: number): void {
        const box = strokeBox(stroke, aspect);
        const pending = this.pending;
        if (pending && (pending.page !== stroke.page || pending.color !== stroke.color)) {
            this.flush();
        }
        if (this.pending) {
            const current = this.pending;
            const glyph = current.glyphs.find((g) => joinsGlyph(g, box));
            if (glyph) {
                glyph.strokes.push(stroke);
                glyph.box = union(glyph.box, box);
                current.box = current.glyphs.map((g) => g.box).reduce(union);
                this.arm(current);
                return;
            }
            const last = current.glyphs[current.glyphs.length - 1];
            if (last && continuesLine(current.box, box, last.box) && current.glyphs.length < MAX_LINE_GLYPHS) {
                current.glyphs.push({ strokes: [stroke], box });
                current.box = union(current.box, box);
                this.arm(current);
                return;
            }
            // Spatially new mark: the pending group is complete.
            this.flush();
        }
        this.pending = {
            page: stroke.page,
            color: stroke.color,
            aspect,
            glyphs: [{ strokes: [stroke], box }],
            box,
            timer: null,
        };
        this.arm(this.pending);
    }

    /** A stroke was erased (or undone) while pending — it can no longer convert. */
    remove(id: string): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        for (const glyph of pending.glyphs) {
            glyph.strokes = glyph.strokes.filter((s) => s.id !== id);
        }
        pending.glyphs = pending.glyphs.filter((g) => g.strokes.length > 0);
        if (pending.glyphs.length === 0) {
            this.disarm(pending);
            this.pending = null;
            return;
        }
        for (const glyph of pending.glyphs) {
            glyph.box = glyph.strokes.map((s) => strokeBox(s, pending.aspect)).reduce(union);
        }
        pending.box = pending.glyphs.map((g) => g.box).reduce(union);
        this.arm(pending);
    }

    /** Ids currently held (for tests and for cancel-on-erase bookkeeping). */
    pendingIds(): string[] {
        return this.pending?.glyphs.flatMap((g) => g.strokes.map((s) => s.id)) ?? [];
    }

    /** Emit the pending group now (or drop it when it cannot be print). */
    flush(): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        this.disarm(pending);
        this.pending = null;
        const group = finalizeGroup(pending);
        if (group) {
            this.opts.onFlush(group);
        }
    }

    dispose(): void {
        if (this.pending) {
            this.disarm(this.pending);
            this.pending = null;
        }
    }

    private arm(pending: Pending): void {
        this.disarm(pending);
        const ms = LINE_PAUSE_MS;
        pending.timer = this.schedule(() => {
            if (this.pending === pending) {
                this.flush();
            }
        }, ms);
    }

    private disarm(pending: Pending): void {
        if (pending.timer !== null) {
            this.cancel(pending.timer);
            pending.timer = null;
        }
    }
}

/** Order glyphs left to right and apply the size sanity filters. Null = leave ink. */
const finalizeGroup = (pending: Pending): StrokeGroup | null => {
    const glyphs = [...pending.glyphs].sort((a, b) => a.box.x0 - b.box.x0);
    const box = glyphs.map((g) => g.box).reduce(union);
    const h = height(box);
    if (h > MAX_GROUP_HEIGHT || h < MIN_GROUP_HEIGHT) {
        return null;
    }
    if (glyphs.length === 1 && width(box) > MAX_LONE_GLYPH_ASPECT * h) {
        return null;
    }
    // A line whose members are wildly different sizes is not one written line.
    if (glyphs.length >= 2) {
        const med = median(glyphs.map((g) => height(g.box)));
        if (glyphs.some((g) => height(g.box) > 2.5 * med && width(g.box) > 2.5 * med)) {
            return null;
        }
    }
    return {
        page: pending.page,
        color: pending.color,
        aspect: pending.aspect,
        glyphs,
        kind: glyphs.length >= 2 ? 'line' : 'glyph',
        box,
    };
};

/** Normalized page bbox of a group (x, w against width; y, h against height). */
export const groupBboxNormalized = (group: StrokeGroup): { x: number; y: number; w: number; h: number } => ({
    x: group.box.x0,
    y: group.box.y0 / group.aspect,
    w: width(group.box),
    h: height(group.box) / group.aspect,
});

/** Every stroke id in a group. */
export const groupStrokeIds = (group: StrokeGroup): string[] => group.glyphs.flatMap((g) => g.strokes.map((s) => s.id));
