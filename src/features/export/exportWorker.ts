/// <reference lib="webworker" />
// Flattens annotations into the PDF off the main thread — pdf-lib chewing a
// 100 MB scan would freeze the UI (plan §export).

import fontkit from '@pdf-lib/fontkit';
import { BlendMode, degrees, PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { getStroke } from 'perfect-freehand';

import {
    hexToRgb01,
    normalizeRotation,
    normToPdfPoint,
    rotatedViewportDims,
    sanitizeWinAnsi,
    viewportToPdfPoint,
} from '@/features/export/pdfMapping';
import { annotationNeedsMusicFont, pdfFallbackGlyphs, textDrawSpec } from '@/features/viewer/ink/musicFont';
import { FREEHAND_OPTIONS, getSvgPathFromStroke, HIGHLIGHT_ALPHA } from '@/features/viewer/ink/strokeRenderer';
import { isTextPayload, type Annotation } from '@/types/models';

export interface ExportRequest {
    bytes: ArrayBuffer;
    annotations: Annotation[];
    /** When set, keep only this 0-based page in the output PDF. */
    pageIndex?: number;
    /**
     * The SMuFL music-text face (WOFF2/OTF bytes), present when a converted
     * dynamic/mark is among the annotations — embedded (subset) so exported
     * `mf` matches the screen. Without it such symbols fall back to Helvetica
     * drawing the ASCII `text` field (`mf`, `sfz`), not SMuFL codepoints.
     */
    musicFont?: ArrayBuffer;
}

export type ExportResponse = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/** Baseline drop (fraction of font size) below the 'top' anchor for the standard faces. */
const STANDARD_ASCENT = 0.9;

export const flatten = async ({ bytes, annotations, pageIndex, musicFont }: ExportRequest): Promise<Uint8Array> => {
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
    const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
    let music: { font: PDFFont; ascent: number } | null = null;
    if (musicFont && annotations.some(annotationNeedsMusicFont)) {
        doc.registerFontkit(fontkit);
        const bytes = new Uint8Array(musicFont);
        const parsed = fontkit.create(bytes);
        music = {
            font: await doc.embedFont(bytes, { subset: true }),
            ascent: parsed.ascent / parsed.unitsPerEm,
        };
    }
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
            const { x, y, text, size, hw } = annotation.payload;
            const fontPx = size * vw;
            const spec = textDrawSpec(text, hw === 1);
            // Same face as the screen: music glyphs when the font is embedded,
            // italic Helvetica when a music token has no face (matches canvas),
            // oblique for italic teaching words, else Helvetica. The baseline
            // drop follows the chosen face's ascent so tops line up.
            const useMusic = spec.music && music !== null;
            const drawFont = useMusic ? music!.font : spec.style === 'italic' || spec.music ? italic : font;
            const ascent = useMusic ? music!.ascent : STANDARD_ASCENT;
            const source = useMusic ? spec.glyphs : pdfFallbackGlyphs(text, spec);
            const lines = (useMusic ? source : sanitizeWinAnsi(source)).split('\n');
            lines.forEach((line, i) => {
                // Anchor each line in DISPLAY space (top-left + baseline drop),
                // then map — handles every page rotation uniformly.
                const lineNy = y + ((i * 1.25 + ascent) * fontPx) / vh;
                const [px, py] = normToPdfPoint(rot, pw, ph, x, lineNy);
                try {
                    page.drawText(line, {
                        x: px,
                        y: py,
                        size: fontPx,
                        font: drawFont,
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
