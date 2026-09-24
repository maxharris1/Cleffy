import { DRAW_OPS, OPS, openPdfDocument } from './pdfjs.js';

export interface PdfRect {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    w: number;
    h: number;
}

export interface PdfTextTok {
    str: string;
    x: number;
    y: number;
}

export interface Staff {
    yTop: number;
    yBot: number;
    x0: number;
    x1: number;
    space: number;
}

export interface BarBox {
    page: number;
    system: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

export interface PdfSystem {
    page: number;
    index: number;
    yTop: number;
    yBot: number;
    x0: number;
    x1: number;
    barXs: number[];
}

export interface PdfPageLayout {
    page: number;
    width: number;
    height: number;
    text: PdfTextTok[];
    systems: PdfSystem[];
}

export interface PdfLayout {
    pageCount: number;
    pages: PdfPageLayout[];
    boxes: BarBox[];
    printedBars: number;
    pickupFlagged: boolean;
    title: string;
    author: string;
    subtitle: string;
    composer: string;
    headerText: string;
}

type Ctm = [number, number, number, number, number, number];

const IDENTITY: Ctm = [1, 0, 0, 1, 0, 0];

const apply = (m: Ctm, x: number, y: number): [number, number] => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
];

const mul = (a: Ctm, b: readonly number[]): Ctm => [
    a[0] * (b[0] ?? 0) + a[2] * (b[1] ?? 0),
    a[1] * (b[0] ?? 0) + a[3] * (b[1] ?? 0),
    a[0] * (b[2] ?? 0) + a[2] * (b[3] ?? 0),
    a[1] * (b[2] ?? 0) + a[3] * (b[3] ?? 0),
    a[0] * (b[4] ?? 0) + a[2] * (b[5] ?? 0) + a[4],
    a[1] * (b[4] ?? 0) + a[3] * (b[5] ?? 0) + a[5],
];

const cluster1d = (values: readonly number[], tol: number): Array<{ mean: number; vals: number[] }> => {
    const sorted = [...values].sort((a, b) => a - b);
    const groups: Array<{ mean: number; vals: number[] }> = [];
    for (const v of sorted) {
        const last = groups[groups.length - 1];
        if (last && Math.abs(v - last.mean) <= tol) {
            last.vals.push(v);
            last.mean = last.vals.reduce((s, x) => s + x, 0) / last.vals.length;
        } else {
            groups.push({ mean: v, vals: [v] });
        }
    }
    return groups;
};

const asCtm = (args: unknown): Ctm | null => {
    if (!Array.isArray(args) || args.length < 6) {
        return null;
    }
    if (args.some((n) => typeof n !== 'number')) {
        return null;
    }
    return [args[0] as number, args[1] as number, args[2] as number, args[3] as number, args[4] as number, args[5] as number];
};

const collectRects = (fnArray: readonly number[], argsArray: readonly unknown[]): PdfRect[] => {
    const ctmStack: Ctm[] = [[...IDENTITY]];
    let ctm: Ctm = [...IDENTITY];
    const rects: PdfRect[] = [];
    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i];
        const args = argsArray[i];
        if (fn === OPS.save) {
            ctmStack.push([...ctm]);
            continue;
        }
        if (fn === OPS.restore) {
            ctm = ctmStack.pop() ?? [...IDENTITY];
            continue;
        }
        if (fn === OPS.transform) {
            const next = asCtm(args);
            if (next) {
                ctm = mul(ctm, next);
            }
            continue;
        }
        if (fn !== OPS.constructPath || !Array.isArray(args)) {
            continue;
        }
        const packed = args[1];
        const path = Array.isArray(packed) ? packed[0] : undefined;
        if (!path || typeof path.length !== 'number') {
            continue;
        }
        const pts: Array<[number, number]> = [];
        for (let k = 0; k < path.length; ) {
            const op = path[k++];
            switch (op) {
                case DRAW_OPS.moveTo:
                case DRAW_OPS.lineTo:
                    pts.push(apply(ctm, path[k++] as number, path[k++] as number));
                    break;
                case DRAW_OPS.curveTo:
                    k += 4;
                    pts.push(apply(ctm, path[k++] as number, path[k++] as number));
                    break;
                case DRAW_OPS.quadraticCurveTo:
                    k += 2;
                    pts.push(apply(ctm, path[k++] as number, path[k++] as number));
                    break;
                case DRAW_OPS.closePath:
                    break;
                default:
                    // Unknown packed op — stop rather than spin.
                    k = path.length;
                    break;
            }
        }
        if (pts.length < 2) {
            continue;
        }
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        rects.push({ x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 });
    }
    return rects;
};

const stavesOf = (rects: readonly PdfRect[]): Staff[] => {
    const longAll = rects.filter((r) => r.w > 160 && r.h < 2.2);
    if (longAll.length < 5) {
        return [];
    }
    // Keep every width that looks like a staff (first system is often indented).
    const widthHits = cluster1d(
        longAll.map((r) => r.w),
        12,
    ).filter((g) => g.vals.length >= 5 && (g.vals.length % 5 === 0 || g.vals.length >= 10));
    const long =
        widthHits.length === 0
            ? longAll
            : longAll.filter((r) => widthHits.some((g) => Math.abs(r.w - g.mean) <= 12));
    if (long.length < 5) {
        return [];
    }
    const ys = cluster1d(
        long.map((r) => (r.y0 + r.y1) / 2),
        0.9,
    )
        .map((g) => g.mean)
        .sort((a, b) => b - a);
    const staves: Staff[] = [];
    for (let i = 0; i + 4 < ys.length; i++) {
        const five = ys.slice(i, i + 5);
        const y0 = five[0];
        const y1 = five[1];
        const y2 = five[2];
        const y3 = five[3];
        const y4 = five[4];
        if (y0 === undefined || y1 === undefined || y2 === undefined || y3 === undefined || y4 === undefined) {
            continue;
        }
        const gaps = [y0 - y1, y1 - y2, y2 - y3, y3 - y4];
        const mean = gaps.reduce((s, g) => s + g, 0) / 4;
        if (mean < 2.8 || mean > 10) {
            continue;
        }
        if (gaps.some((g) => Math.abs(g - mean) > 0.9)) {
            continue;
        }
        const members = long.filter((r) => {
            const y = (r.y0 + r.y1) / 2;
            return y <= y0 + 1.2 && y >= y4 - 1.2;
        });
        if (members.length < 5) {
            continue;
        }
        staves.push({
            yTop: y0,
            yBot: y4,
            x0: Math.min(...members.map((r) => r.x0)),
            x1: Math.max(...members.map((r) => r.x1)),
            space: mean,
        });
        i += 4;
    }
    return staves;
};

const staffBarXs = (staff: Staff, verts: readonly PdfRect[]): number[] => {
    const h = staff.yTop - staff.yBot;
    const covering = verts.filter((r) => {
        if (r.w >= 3.2) {
            return false;
        }
        const overlap = Math.min(r.y1, staff.yTop) - Math.max(r.y0, staff.yBot);
        return overlap > h * 0.85 && r.x0 >= staff.x0 - 8 && r.x0 <= staff.x1 + 8;
    });
    return cluster1d(
        covering.map((r) => (r.x0 + r.x1) / 2),
        12,
    ).map((g) => g.mean);
};

const intersectX = (a: readonly number[], b: readonly number[], tol: number): number[] =>
    a.filter((x) => b.some((y) => Math.abs(x - y) < tol)).sort((x, y) => x - y);

const withStaffEnds = (xs: readonly number[], staff: Staff): number[] => {
    const sorted = [...xs].sort((a, b) => a - b);
    const out = [...sorted];
    const first = out[0];
    if (first === undefined || first - staff.x0 > 24) {
        out.unshift(staff.x0);
    }
    const last = out[out.length - 1];
    if (last === undefined || staff.x1 - last > 24) {
        out.push(staff.x1);
    }
    return out;
};

interface BarXsChoice {
    inter: number[];
    longer: number[];
    xa: number[];
    xb: number[];
}

/** Insert a barline in an interior run that is clearly two bars wide. */
const splitWideInterior = (xs: readonly number[], enabled: boolean): number[] => {
    if (!enabled || xs.length < 3) {
        return [...xs];
    }
    const widths: number[] = [];
    for (let i = 0; i + 1 < xs.length; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        if (left === undefined || right === undefined) {
            continue;
        }
        widths.push(right - left);
    }
    const body = widths.slice(1);
    const sorted = [...(body.length > 0 ? body : widths)].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (med <= 0) {
        return [...xs];
    }
    const out: number[] = [xs[0]!];
    for (let i = 0; i + 1 < xs.length; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        if (left === undefined || right === undefined) {
            continue;
        }
        if (i > 0 && right - left > med * 2.05) {
            out.push((left + right) / 2);
        }
        out.push(right);
    }
    return out;
};

/** Merge interior slices much narrower than the system median (double-bar hairlines). */
const mergeNarrowInterior = (xs: readonly number[]): number[] => {
    if (xs.length < 4) {
        return [...xs];
    }
    const widths: number[] = [];
    for (let i = 0; i + 1 < xs.length; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        if (left === undefined || right === undefined) {
            continue;
        }
        widths.push(right - left);
    }
    const sorted = [...widths].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (med <= 0) {
        return [...xs];
    }
    const out: number[] = [xs[0]!];
    for (let i = 0; i + 1 < xs.length; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        if (left === undefined || right === undefined) {
            continue;
        }
        const w = right - left;
        if (i > 0 && w < med * 0.62) {
            continue;
        }
        out.push(right);
    }
    return out;
};

const pickBarXs = (upper: Staff, lower: Staff | null, verts: readonly PdfRect[]): BarXsChoice => {
    const xa = staffBarXs(upper, verts);
    if (!lower) {
        const xs = collapseTinyGaps(withStaffEnds(xa, upper));
        return { inter: xs, longer: xs, xa: xs, xb: xs };
    }
    const xb = staffBarXs(lower, verts);
    const inter = collapseTinyGaps(intersectX(xa, xb, 6));
    const longer = collapseTinyGaps(xa.length >= xb.length ? xa : xb);
    return { inter, longer, xa, xb };
};

const spanningBrace = (upper: Staff, lower: Staff, verts: readonly PdfRect[]): boolean => {
    const span = upper.yTop - lower.yBot;
    if (span <= 0) {
        return false;
    }
    return verts.some((r) => {
        const overlap = Math.min(r.y1, upper.yTop) - Math.max(r.y0, lower.yBot);
        return overlap > span * 0.75 && r.x0 >= upper.x0 - 12 && r.x0 <= upper.x0 + 28 && r.w < 10;
    });
};

const pairSystems = (
    staves: readonly Staff[],
    verts: readonly PdfRect[],
): Array<{ upper: Staff; lower: Staff | null }> => {
    const systems: Array<{ upper: Staff; lower: Staff | null }> = [];
    const used = new Set<number>();
    for (let i = 0; i < staves.length; i++) {
        if (used.has(i)) {
            continue;
        }
        const a = staves[i];
        const b = staves[i + 1];
        if (!a) {
            continue;
        }
        const gap = b ? a.yBot - b.yTop : Number.POSITIVE_INFINITY;
        if (b && gap > -a.space && gap < a.space * 12 && spanningBrace(a, b, verts)) {
            used.add(i);
            used.add(i + 1);
            systems.push({ upper: a, lower: b });
        } else {
            used.add(i);
            systems.push({ upper: a, lower: null });
        }
    }
    const hasPair = systems.some((s) => s.lower !== null);
    if (hasPair) {
        return systems.filter((s) => s.lower !== null);
    }
    return systems;
};

/** Drop the hairline gap between a thin+thick double bar so it is one barline. */
const collapseTinyGaps = (xs: readonly number[]): number[] => {
    if (xs.length < 3) {
        return [...xs];
    }
    const widths: number[] = [];
    for (let i = 0; i + 1 < xs.length; i++) {
        const left = xs[i];
        const right = xs[i + 1];
        if (left === undefined || right === undefined) {
            continue;
        }
        widths.push(right - left);
    }
    const sorted = [...widths].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (med <= 0) {
        return [...xs];
    }
    const minW = med * 0.18;
    const out: number[] = [xs[0]!];
    for (let i = 1; i < xs.length; i++) {
        const x = xs[i];
        const prev = out[out.length - 1];
        if (x === undefined || prev === undefined) {
            continue;
        }
        if (x - prev < minW) {
            out[out.length - 1] = (prev + x) / 2;
            continue;
        }
        out.push(x);
    }
    return out;
};

const toNormBox = (
    page: number,
    system: number,
    x0: number,
    x1: number,
    yTop: number,
    yBot: number,
    width: number,
    height: number,
): BarBox => ({
    page,
    system,
    x0: Math.min(1, Math.max(0, x0 / width)),
    x1: Math.min(1, Math.max(0, x1 / width)),
    y0: Math.min(1, Math.max(0, 1 - yTop / height)),
    y1: Math.min(1, Math.max(0, 1 - yBot / height)),
});

const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');

export const pdfLayoutFromBytes = async (pdfBytes: Uint8Array): Promise<PdfLayout> => {
    const doc = await openPdfDocument(pdfBytes);
    try {
        const meta = await doc.getMetadata();
        const info = (meta.info ?? {}) as Record<string, unknown>;
        const custom = (info.Custom ?? {}) as Record<string, unknown>;
        const pages: PdfPageLayout[] = [];
        const boxes: BarBox[] = [];
        let pickupFlagged = false;
        for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const viewport = page.getViewport({ scale: 1 });
            const ops = await page.getOperatorList();
            const rects = collectRects(ops.fnArray, ops.argsArray);
            const rawText = await page.getTextContent();
            const text: PdfTextTok[] = [];
            for (const item of rawText.items) {
                if (!('str' in item) || typeof item.str !== 'string' || item.str.length === 0) {
                    continue;
                }
                const t = item.transform;
                text.push({ str: item.str, x: t[4] ?? 0, y: t[5] ?? 0 });
            }
            const staves = stavesOf(rects);
            const verts = rects.filter((r) => r.h > 8 && r.w < 3.5);
            const paired = pairSystems(staves, verts);
            const drafts: Array<{
                si: number;
                yTop: number;
                yBot: number;
                x0: number;
                x1: number;
                inter: number[];
                longer: number[];
                xa: number[];
                xb: number[];
            }> = [];
            for (let si = 0; si < paired.length; si++) {
                const sys = paired[si];
                if (!sys) {
                    continue;
                }
                const choice = pickBarXs(sys.upper, sys.lower, verts);
                drafts.push({
                    si,
                    yTop: sys.upper.yTop,
                    yBot: sys.lower?.yBot ?? sys.upper.yBot,
                    x0: Math.min(sys.upper.x0, sys.lower?.x0 ?? sys.upper.x0),
                    x1: Math.max(sys.upper.x1, sys.lower?.x1 ?? sys.upper.x1),
                    inter: choice.inter,
                    longer: choice.longer,
                    xa: choice.xa,
                    xb: choice.xb,
                });
            }
            const barCounts = drafts.map((d) => Math.max(0, d.inter.length - 1)).sort((a, b) => a - b);
            const medianBars = barCounts[Math.floor(barCounts.length / 2)] ?? 0;
            const systems: PdfSystem[] = [];
            for (const draft of drafts) {
                const bars = Math.max(0, draft.inter.length - 1);
                const sparse = drafts.length >= 6 && medianBars > 0 && medianBars - bars >= 2;
                const raw = sparse
                    ? collapseTinyGaps(intersectX(draft.xa, draft.xb, 16))
                    : draft.inter;
                const split = splitWideInterior(raw, drafts.length >= 6);
                const crowded = medianBars > 0 && split.length - 1 > medianBars * 1.6;
                const xs = crowded ? mergeNarrowInterior(split) : split;
                systems.push({
                    page: p - 1,
                    index: draft.si,
                    yTop: draft.yTop,
                    yBot: draft.yBot,
                    x0: draft.x0,
                    x1: draft.x1,
                    barXs: xs,
                });
                const widths: number[] = [];
                for (let i = 0; i + 1 < xs.length; i++) {
                    const left = xs[i];
                    const right = xs[i + 1];
                    if (left === undefined || right === undefined) {
                        continue;
                    }
                    widths.push(right - left);
                    boxes.push(toNormBox(p - 1, draft.si, left, right, draft.yTop, draft.yBot, viewport.width, viewport.height));
                }
                if (p === 1 && draft.si === 0 && widths.length > 1) {
                    const sorted = [...widths].sort((a, b) => a - b);
                    const med = sorted[Math.floor(sorted.length / 2)] ?? widths[0] ?? 0;
                    const first = widths[0] ?? med;
                    if (med > 0 && first < med * 0.72) {
                        pickupFlagged = true;
                    } else if (med > 0) {
                        const left = xs[0];
                        const right = xs[1];
                        if (left !== undefined && right !== undefined) {
                            const stacked = text.filter((t) => /^\d{1,2}$/.test(t.str.trim()) && t.x >= left && t.x <= right);
                            let digitX = 0;
                            let found = false;
                            for (const a of stacked) {
                                for (const b of stacked) {
                                    if (a === b) {
                                        continue;
                                    }
                                    const dx = Math.abs(a.x - b.x);
                                    const dy = Math.abs(a.y - b.y);
                                    if (dx > 10 || dy < 4 || dy > 22) {
                                        continue;
                                    }
                                    found = true;
                                    digitX = Math.max(digitX, a.x, b.x);
                                }
                            }
                            if (found) {
                                const content = right - digitX;
                                if (content > 0 && content < med * 0.55) {
                                    pickupFlagged = true;
                                }
                            }
                        }
                    }
                }
            }
            pages.push({
                page: p - 1,
                width: viewport.width,
                height: viewport.height,
                text,
                systems,
            });
        }
        const headerBits = pages[0]?.text
            .filter((t) => /[A-Za-z]{2,}|\d/.test(t.str))
            .map((t) => t.str.trim())
            .filter((s) => s.length > 0);
        return {
            pageCount: doc.numPages,
            pages,
            boxes,
            printedBars: boxes.length,
            pickupFlagged,
            title: strOf(info.Title),
            author: strOf(info.Author),
            subtitle: strOf(custom.Subtitle),
            composer: strOf(custom.Composer),
            headerText: (headerBits ?? []).join(' '),
        };
    } finally {
        await doc.destroy();
    }
};
