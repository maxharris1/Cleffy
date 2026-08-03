// Generates e2e-fixtures/test-score-annotated.pdf: the plain test score with
// pre-existing "teacher" annotations baked in — blue fingering digits and a
// red bracket drawn INTO the page content (what a scanned/flattened score
// looks like), plus one real FreeText PDF annotation (the born-digital case).
// Used by live-e2e to exercise the smart-import flow end to end.
//
//   node scripts/generate-annotated-fixture.mjs

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, 'e2e-fixtures', 'test-score.pdf');
const outPath = path.join(root, 'e2e-fixtures', 'test-score-annotated.pdf');

const BLUE = rgb(37 / 255, 99 / 255, 235 / 255);
const RED = rgb(220 / 255, 38 / 255, 38 / 255);

/** Chunky hand-drawn-ish digit strokes (rectangles read as pen lines after rasterizing). */
const drawDigit3 = (page, x, y, s) => {
    // Two stacked arcs approximated with bars — enough for the detector+vision.
    page.drawRectangle({ x, y: y + s * 0.8, width: s * 0.7, height: s * 0.16, color: BLUE });
    page.drawRectangle({ x, y: y + s * 0.42, width: s * 0.7, height: s * 0.16, color: BLUE });
    page.drawRectangle({ x, y, width: s * 0.7, height: s * 0.16, color: BLUE });
    page.drawRectangle({ x: x + s * 0.54, y, width: s * 0.16, height: s, color: BLUE });
};

const drawDigit1 = (page, x, y, s) => {
    page.drawRectangle({ x: x + s * 0.3, y, width: s * 0.16, height: s, color: BLUE });
    page.drawRectangle({ x, y, width: s * 0.76, height: s * 0.14, color: BLUE });
};

const main = async () => {
    const source = await readFile(sourcePath);
    const doc = await PDFDocument.load(source);
    const page = doc.getPage(0);
    const { height } = page.getSize();

    // "Fingering" digits near the top (baked into content — the raster-detection case).
    drawDigit3(page, 140, height - 120, 14);
    drawDigit1(page, 180, height - 120, 14);
    drawDigit3(page, 220, height - 120, 14);

    // A red bracket in the left margin.
    page.drawRectangle({ x: 60, y: height - 260, width: 4, height: 80, color: RED });
    page.drawRectangle({ x: 60, y: height - 184, width: 22, height: 4, color: RED });
    page.drawRectangle({ x: 60, y: height - 260, width: 22, height: 4, color: RED });

    // One born-digital FreeText annotation (the exact-conversion case).
    const rect = [300, height - 140, 380, height - 116];
    const annot = doc.context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: rect,
        Contents: PDFString.of('legato'),
        C: [1, 0, 0],
        DA: PDFString.of('/Helv 12 Tf 1 0 0 rg'),
        F: 4,
    });
    const annotRef = doc.context.register(annot);
    const existing = page.node.lookup(PDFName.of('Annots'));
    const annots = existing ?? doc.context.obj([]);
    annots.push(annotRef);
    page.node.set(PDFName.of('Annots'), annots);

    await writeFile(outPath, await doc.save());
    console.log(`Wrote ${outPath}`);
};

await main();
