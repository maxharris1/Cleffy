/// <reference lib="webworker" />
// Flattens annotations into the PDF off the main thread — pdf-lib chewing a
// 100 MB scan would freeze the UI (plan §export).

import { BlendMode, degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { getStroke } from 'perfect-freehand';

import {
    hexToRgb01,
    normalizeRotation,
    normToPdfPoint,
    rotatedViewportDims,
    sanitizeWinAnsi,
    viewportToPdfPoint,
} from '@/features/export/pdfMapping';
import { FREEHAND_OPTIONS, getSvgPathFromStroke, HIGHLIGHT_ALPHA } from '@/features/viewer/ink/strokeRenderer';
import { isTextPayload, type Annotation } from '@/types/models';

export interface ExportRequest {
    bytes: ArrayBuffer;
    annotations: Annotation[];
    /** When set, keep only this 0-based page in the output PDF. */
    pageIndex?: number;
}

export type ExportResponse = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

const flatten = async ({ bytes, annotations, pageIndex }: ExportRequest): Promise<Uint8Array> => {
    // Some IMSLP scans are owner-password encrypted; loading still works.
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const doc =
        pageIndex === undefined
            ? source
            : await (async () => {
                  const single = await PDFDocument.create();
                  const [copied] = await single.copyPages(source, [pageIndex]);
                  if (!copied) {
                      throw new Error(`Page ${pageIndex + 1} not found`);
                  }
                  single.addPage(copied);
                  return single;
              })();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();

    // When exporting a single page, annotation.page still refers to the source
    // index — remap onto the sole output page.
    const pageOf = (annotationPage: number) => {
        if (pageIndex === undefined) {
            return pages[annotationPage];
        }
        return annotationPage === pageIndex ? pages[0] : undefined;
    };

    for (const annotation of annotations) {
        if (annotation.deletedAt) {
            continue;
        }
        const page = pageOf(annotation.page);
        if (!page) {
            continue;
        }
        const rot = normalizeRotation(page.getRotation().angle);
        const { width: pw, height: ph } = page.getSize();
        const { vw, vh } = rotatedViewportDims(rot, pw, ph);
        const [r, g, b] = hexToRgb01(annotation.color);
        const color = rgb(r, g, b);

        if (isTextPayload(annotation.payload)) {
            const { x, y, text, size } = annotation.payload;
            const fontPx = size * vw;
            const lines = sanitizeWinAnsi(text).split('\n');
            lines.forEach((line, i) => {
                // Anchor each line in DISPLAY space (top-left + baseline drop),
                // then map — handles every page rotation uniformly.
                const lineNy = y + ((i * 1.25 + 0.9) * fontPx) / vh;
                const [px, py] = normToPdfPoint(rot, pw, ph, x, lineNy);
                try {
                    page.drawText(line, {
                        x: px,
                        y: py,
                        size: fontPx,
                        font,
                        color,
                        rotate: degrees(rot),
                    });
                } catch {
                    // A line that still fails to encode shouldn't kill the export.
                }
            });
            continue;
        }

        const { pts, w, sp } = annotation.payload;
        if (pts.length < 3) {
            continue;
        }
        const input: number[][] = [];
        for (let i = 0; i < pts.length - 2; i += 3) {
            input.push([(pts[i] ?? 0) * vw, (pts[i + 1] ?? 0) * vh, pts[i + 2] ?? 0.5]);
        }
        const outline = getStroke(input, {
            ...FREEHAND_OPTIONS,
            size: Math.max(0.5, w * vw),
            simulatePressure: sp === 1,
        });
        // Outline is in rotated-viewport space; convert each point to the
        // pinned y-DOWN path space (see pdfMapping docs).
        const pathPoints = outline.map(([vx, vy]) => {
            const [x, y] = viewportToPdfPoint(rot, pw, ph, vx ?? 0, vy ?? 0);
            return [x, ph - y];
        });
        const path = getSvgPathFromStroke(pathPoints);
        if (path === '') {
            continue;
        }
        page.drawSvgPath(path, {
            x: 0,
            y: ph,
            color,
            ...(annotation.kind === 'highlight' ? { opacity: HIGHLIGHT_ALPHA, blendMode: BlendMode.Multiply } : {}),
        });
    }

    return doc.save();
};

self.onmessage = (event: MessageEvent<ExportRequest>) => {
    void (async () => {
        try {
            const bytes = await flatten(event.data);
            const response: ExportResponse = { ok: true, bytes };
            // Transfer, don't copy — exports of big scans are large.
            (self as unknown as Worker).postMessage(response, [bytes.buffer as ArrayBuffer]);
        } catch (err) {
            const response: ExportResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
            (self as unknown as Worker).postMessage(response);
        }
    })();
};
