/**
 * Ground truth = ASAP MusicXML pushed through the service's own parser
 * (dist/musicxml.js), so ties, grace realisation, ornaments and meter
 * correction are applied identically to GT and to every engine's output.
 *
 * For typeset scores MuseScore's `.mpos` sidecar supplies true measure boxes
 * (page-normalised) — the geometry reference for IoU.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { pdfPageSizePt } from './pdf.mjs';
import { DIST_DIR, GT_DIR, PDF_DIR } from './paths.mjs';

const require = createRequire(import.meta.url);
const AdmZip = require(join(DIST_DIR, '..', 'node_modules', 'adm-zip'));

export const gtPath = (asapPath) => join(GT_DIR, `${asapPath.replace(/[/.]/g, '_')}.musicxml`);

/** Wrap a plain MusicXML string as an .mxl buffer so parseMxlFiles can concatenate movements. */
const toMxl = (xml) => {
    const zip = new AdmZip();
    zip.addFile('score.xml', Buffer.from(xml, 'utf8'));
    zip.addFile(
        'META-INF/container.xml',
        Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>',
        ),
    );
    return zip.toBuffer();
};

export const loadGroundTruthMusical = async (score) => {
    const { parseMxlFiles } = await import(join(DIST_DIR, 'musicxml.js'));
    const files = await Promise.all(score.gt.map(async (p) => toMxl(await readFile(gtPath(p), 'utf8'))));
    return parseMxlFiles(files);
};

/** MuseScore writes .mpos coordinates in 1/3600 inch (DPI 360 × 10). */
const MPOS_UNITS_PER_INCH = 3600;

/**
 * Reference measure boxes for a typeset score, page-normalised:
 * [{ page, x0, x1, y0, y1 }] in score order. Null when no .mpos exists (scans).
 */
export const loadReferenceBoxes = async (score) => {
    if (score.pdf.type === 'concat') {
        const parts = [];
        let pageOffset = 0;
        for (const id of score.pdf.of) {
            const sub = await loadReferenceBoxesForId(id);
            if (!sub) {
                return null;
            }
            parts.push(...sub.boxes.map((b) => ({ ...b, page: b.page + pageOffset })));
            pageOffset += sub.pages;
        }
        return parts;
    }
    const own = await loadReferenceBoxesForId(score.id);
    return own?.boxes ?? null;
};

const loadReferenceBoxesForId = async (id) => {
    const pdfPath = join(PDF_DIR, `${id}.pdf`);
    let xml;
    try {
        xml = await readFile(join(PDF_DIR, `${id}.mpos`), 'utf8');
    } catch {
        return null;
    }
    const size = await pdfPageSizePt(pdfPath);
    if (!size) {
        return null;
    }
    const widthUnits = (size.width / 72) * MPOS_UNITS_PER_INCH;
    const heightUnits = (size.height / 72) * MPOS_UNITS_PER_INCH;
    const boxes = [];
    let pages = 0;
    for (const m of xml.matchAll(
        /<element id="(\d+)" x="([\d.]+)" y="([\d.]+)" sx="([\d.]+)" sy="([\d.]+)" page="(\d+)"/g,
    )) {
        const [, id, x, y, sx, sy, page] = m;
        const p = Number(page);
        pages = Math.max(pages, p + 1);
        boxes.push({
            id: Number(id),
            page: p,
            x0: Number(x) / widthUnits,
            x1: (Number(x) + Number(sx)) / widthUnits,
            y0: Number(y) / heightUnits,
            y1: (Number(y) + Number(sy)) / heightUnits,
        });
    }
    boxes.sort((a, b) => a.id - b.id);
    return { boxes, pages };
};
