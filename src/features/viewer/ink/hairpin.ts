import type { HairpinPayload, StrokeWidthKey } from '@/types/models';

/** Mouth half-width / page width. Matches the pen size the writer already chose. */
export const hairpinSpreadFor = (widthKey: StrokeWidthKey): number => {
    switch (widthKey) {
        case 'thin':
            return 0.012;
        case 'medium':
            return 0.02;
        case 'thick':
            return 0.032;
        default: {
            const _exhaustive: never = widthKey;
            return _exhaustive;
        }
    }
};

/** Wedge stroke width / page width. */
const HAIRPIN_LINE_W = 0.0018;

export interface HairpinPx {
    tip: { x: number; y: number };
    mouth: { x: number; y: number };
    mouthA: { x: number; y: number };
    mouthB: { x: number; y: number };
}

/**
 * The wedge in page pixels. `open: 'end'` puts the mouth on (x2, y2);
 * `open: 'start'` puts it on (x1, y1). `spread` is the mouth half-width
 * in page-width units, the same denominator as x.
 */
export const hairpinPointsPx = (payload: HairpinPayload, pageWpx: number, pageHpx: number): HairpinPx => {
    const x1 = payload.x1 * pageWpx;
    const y1 = payload.y1 * pageHpx;
    const x2 = payload.x2 * pageWpx;
    const y2 = payload.y2 * pageHpx;
    const mouthIsEnd = payload.open !== 'start';
    const tip = mouthIsEnd ? { x: x1, y: y1 } : { x: x2, y: y2 };
    const mouth = mouthIsEnd ? { x: x2, y: y2 } : { x: x1, y: y1 };
    const dx = mouth.x - tip.x;
    const dy = mouth.y - tip.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const half = Math.max(0.5, payload.spread * pageWpx);
    return {
        tip,
        mouth,
        mouthA: { x: mouth.x + px * half, y: mouth.y + py * half },
        mouthB: { x: mouth.x - px * half, y: mouth.y - py * half },
    };
};

export const drawHairpin = (
    ctx: CanvasRenderingContext2D,
    payload: HairpinPayload,
    pageWpx: number,
    pageHpx: number,
    color: string,
): void => {
    const { tip, mouthA, mouthB } = hairpinPointsPx(payload, pageWpx, pageHpx);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, pageWpx * HAIRPIN_LINE_W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(mouthA.x, mouthA.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.lineTo(mouthB.x, mouthB.y);
    ctx.stroke();
    ctx.restore();
};

/** Normalized bbox covering the tip and both mouth corners. `aspect` is width/height. */
export const hairpinBboxNorm = (payload: HairpinPayload, aspect: number): [number, number, number, number] => {
    const pageW = 1000;
    const pageH = pageW / aspect;
    const { tip, mouthA, mouthB } = hairpinPointsPx(payload, pageW, pageH);
    const xs = [tip.x, mouthA.x, mouthB.x];
    const ys = [tip.y, mouthA.y, mouthB.y];
    const pad = pageW * HAIRPIN_LINE_W;
    return [
        (Math.min(...xs) - pad) / pageW,
        (Math.min(...ys) - pad) / pageH,
        (Math.max(...xs) + pad) / pageW,
        (Math.max(...ys) + pad) / pageH,
    ];
};

/** True when the point is within `radiusPx` of either arm of the wedge. */
export const hitTestHairpin = (
    payload: HairpinPayload,
    nx: number,
    ny: number,
    radiusPx: number,
    pageWpx: number,
    pageHpx: number,
): boolean => {
    const { tip, mouthA, mouthB } = hairpinPointsPx(payload, pageWpx, pageHpx);
    const px = nx * pageWpx;
    const py = ny * pageHpx;
    const limit = radiusPx * radiusPx;
    return (
        segmentDistanceSq(px, py, tip.x, tip.y, mouthA.x, mouthA.y) <= limit ||
        segmentDistanceSq(px, py, tip.x, tip.y, mouthB.x, mouthB.y) <= limit
    );
};

/** Which stored anchor the point lands on, or null. */
export const hairpinAnchorAt = (
    payload: HairpinPayload,
    nx: number,
    ny: number,
    radiusPx: number,
    pageWpx: number,
    pageHpx: number,
): 'start' | 'end' | null => {
    const px = nx * pageWpx;
    const py = ny * pageHpx;
    const startD = (px - payload.x1 * pageWpx) ** 2 + (py - payload.y1 * pageHpx) ** 2;
    const endD = (px - payload.x2 * pageWpx) ** 2 + (py - payload.y2 * pageHpx) ** 2;
    const limit = radiusPx * radiusPx;
    if (startD <= limit && startD <= endD) {
        return 'start';
    }
    if (endD <= limit) {
        return 'end';
    }
    return null;
};

const segmentDistanceSq = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
        t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return (px - cx) ** 2 + (py - cy) ** 2;
};
