import type { PDFPageProxy } from 'pdfjs-dist';

import { snapToPalette } from '@/features/import/colorSnap';
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE } from '@/features/import/textFit';
import { MAX_STROKE_W, MIN_STROKE_W } from '@/features/import/vectorize';
import type { ProposedItem } from '@/features/import/importTypes';
import type { Annotation, StrokePayload } from '@/types/models';

/**
 * Born-digital pass: PDFs annotated in other apps (FreeText notes, Ink
 * strokes) carry real annotation objects. Those convert EXACTLY — no vision,
 * no heuristics — and are stripped from the rebuilt file at accept time.
 * Detection rasters render with annotationMode 0, so nothing here is ever
 * double-detected by the ink pass.
 */

/** Annotation subtypes we convert (everything else — links, widgets — is preserved). */
export const CONVERTIBLE_SUBTYPES = ['FreeText', 'Ink'] as const;

/** Loose view of pdf.js's untyped annotation records. */
interface RawPdfAnnotation {
    subtype?: string;
    rect?: number[];
    color?: ArrayLike<number> | null;
    contents?: string;
    contentsObj?: { str?: string };
    inkLists?: unknown;
    borderStyle?: { width?: number };
    defaultAppearanceData?: { fontSize?: number };
    hidden?: boolean;
    noView?: boolean;
}

const colorHexOf = (raw: RawPdfAnnotation): string => {
    const c = raw.color;
    if (!c || typeof c[0] !== 'number') {
        return '#1f2937'; // app default ink
    }
    const toHex = (v: number): string =>
        Math.max(0, Math.min(255, Math.round(v)))
            .toString(16)
            .padStart(2, '0');
    return snapToPalette(`#${toHex(c[0] ?? 0)}${toHex(c[1] ?? 0)}${toHex(c[2] ?? 0)}`);
};

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

/** Flatten pdf.js inkLists (Float32Array flat pairs, number[][] pairs, or {x,y}[] lists). */
const inkListPoints = (list: unknown): [number, number][] => {
    if (!Array.isArray(list) && !ArrayBuffer.isView(list)) {
        return [];
    }
    const arr = list as ArrayLike<unknown>;
    const first = arr[0];
    if (typeof first === 'number') {
        const flat = arr as ArrayLike<number>;
        const out: [number, number][] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
            out.push([flat[i] ?? 0, flat[i + 1] ?? 0]);
        }
        return out;
    }
    const out: [number, number][] = [];
    for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
            out.push([p[0], p[1]]);
        } else if (p && typeof p === 'object' && 'x' in p && 'y' in p) {
            const o = p as { x?: number; y?: number };
            out.push([o.x ?? 0, o.y ?? 0]);
        }
    }
    return out;
};

export interface BornDigitalResult {
    items: ProposedItem[];
    /** Subtypes that were converted on this page (to strip during rebuild). */
    stripSubtypes: string[];
}

/** Extract FreeText/Ink annotations from one page as ready-to-create native annotations. */
export const extractBornDigital = async (
    page: PDFPageProxy,
    pageIndex: number,
    docId: string,
): Promise<BornDigitalResult> => {
    const viewport = page.getViewport({ scale: 1 });
    const vw = viewport.width;
    const vh = viewport.height;
    const toNorm = (x: number, y: number): [number, number] => {
        const [vx, vy] = viewport.convertToViewportPoint(x, y);
        return [(vx ?? 0) / vw, (vy ?? 0) / vh];
    };

    let raws: RawPdfAnnotation[];
    try {
        raws = (await page.getAnnotations()) as RawPdfAnnotation[];
    } catch {
        return { items: [], stripSubtypes: [] };
    }

    const items: ProposedItem[] = [];
    const stripSubtypes = new Set<string>();
    let n = 0;

    for (const raw of raws) {
        if (raw.hidden || raw.noView) {
            continue;
        }
        if (raw.subtype === 'FreeText') {
            const text = (raw.contentsObj?.str ?? raw.contents ?? '').trim();
            const rect = raw.rect;
            if (!text || !rect || rect.length < 4) {
                continue;
            }
            const [ax, ay] = toNorm(rect[0] ?? 0, rect[1] ?? 0);
            const [bx, by] = toNorm(rect[2] ?? 0, rect[3] ?? 0);
            const x = Math.min(ax, bx);
            const y = Math.min(ay, by);
            const boxH = Math.abs(by - ay);
            // Font size in PDF points = viewport units at scale 1; fall back to 80% of the box height.
            const fontPt = raw.defaultAppearanceData?.fontSize;
            const fontPx = fontPt && fontPt > 0 ? fontPt : boxH * vh * 0.8;
            const size = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, fontPx / vw));
            const annotation = makeAnnotation(docId, pageIndex, 'text', colorHexOf(raw), { x, y, text, size });
            items.push({
                id: `p${pageIndex}bd${n++}`,
                pageIndex,
                clusterIds: [],
                annotations: [annotation],
                label: `“${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`,
                isText: true,
                confidence: 'high',
            });
            stripSubtypes.add('FreeText');
            continue;
        }
        if (raw.subtype === 'Ink') {
            const lists = Array.isArray(raw.inkLists) ? raw.inkLists : [];
            const strokes: StrokePayload[] = [];
            const wPt = raw.borderStyle?.width;
            const w = Math.min(MAX_STROKE_W, Math.max(MIN_STROKE_W, wPt && wPt > 0 ? wPt / vw : 0.005));
            for (const list of lists) {
                const pts = inkListPoints(list);
                if (pts.length < 2) {
                    continue;
                }
                const flat: number[] = [];
                for (const [px, py] of pts) {
                    const [nx, ny] = toNorm(px, py);
                    flat.push(nx, ny, 0.5);
                }
                strokes.push({ pts: flat, w });
            }
            if (strokes.length === 0) {
                continue;
            }
            const color = colorHexOf(raw);
            items.push({
                id: `p${pageIndex}bd${n++}`,
                pageIndex,
                clusterIds: [],
                annotations: strokes.map((payload) => makeAnnotation(docId, pageIndex, 'stroke', color, payload)),
                label: 'drawn mark',
                isText: false,
                confidence: 'high',
            });
            stripSubtypes.add('Ink');
        }
    }

    return { items, stripSubtypes: [...stripSubtypes] };
};
