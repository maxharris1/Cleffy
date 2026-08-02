/// <reference lib="webworker" />
// Rebuilds the PDF with cleanup patches (and stripped, now-native PDF
// annotations) off the main thread — same worker shape as exportWorker.

import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

import { normalizeRotation } from '@/features/export/pdfMapping';
import { computePatchPlacement } from '@/features/import/rebuildPlacement';

export interface RebuildPatchMsg {
    page: number;
    bboxNorm: { x: number; y: number; w: number; h: number };
    /** PNG bytes (alpha-masked paper-color patch). */
    png: Uint8Array;
}

export interface StripAnnotMsg {
    page: number;
    subtype: string;
    /** PDF-space rect of the annotation to remove (matched with tolerance). */
    rect: [number, number, number, number];
}

export interface RebuildRequest {
    bytes: ArrayBuffer;
    patches: RebuildPatchMsg[];
    stripAnnots: StripAnnotMsg[];
}

export type RebuildResponse = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

const RECT_EPSILON = 0.5;

const rectOfDict = (dict: PDFDict): [number, number, number, number] | null => {
    const rect = dict.lookup(PDFName.of('Rect'));
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }
    const nums = rect.asArray().map((el) => {
        const v = el as { asNumber?: () => number };
        try {
            return typeof v.asNumber === 'function' ? v.asNumber() : NaN;
        } catch {
            return NaN;
        }
    });
    if (nums.some((n) => Number.isNaN(n))) {
        return null;
    }
    return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
};

const rectsMatch = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= RECT_EPSILON);

const rebuild = async ({ bytes, patches, stripAnnots }: RebuildRequest): Promise<Uint8Array> => {
    // Some IMSLP scans are owner-password encrypted; loading still works.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = doc.getPages();

    // 1. Strip exactly the accepted born-digital annotations (subtype+rect match).
    const byPage = new Map<number, StripAnnotMsg[]>();
    for (const strip of stripAnnots) {
        const list = byPage.get(strip.page) ?? [];
        list.push(strip);
        byPage.set(strip.page, list);
    }
    for (const [pageIndex, strips] of byPage) {
        const page = pages[pageIndex];
        if (!page) {
            continue;
        }
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (!(annots instanceof PDFArray)) {
            continue;
        }
        const survivors: (PDFRef | PDFDict)[] = [];
        for (const el of annots.asArray()) {
            const dict = el instanceof PDFRef ? doc.context.lookup(el) : el;
            if (!(dict instanceof PDFDict)) {
                survivors.push(el as PDFRef);
                continue;
            }
            const subtype = dict.lookup(PDFName.of('Subtype'));
            const subtypeName = subtype instanceof PDFName ? subtype.decodeText() : '';
            const rect = rectOfDict(dict);
            const matches = rect !== null && strips.some((s) => s.subtype === subtypeName && rectsMatch(rect, s.rect));
            if (!matches) {
                survivors.push(el as PDFRef | PDFDict);
            }
        }
        if (survivors.length === 0) {
            page.node.delete(PDFName.of('Annots'));
        } else {
            page.node.set(PDFName.of('Annots'), doc.context.obj(survivors));
        }
    }

    // 2. Draw the paper-color patches over accepted raster ink.
    for (const patch of patches) {
        const page = pages[patch.page];
        if (!page) {
            continue;
        }
        const image = await doc.embedPng(patch.png);
        const rot = normalizeRotation(page.getRotation().angle);
        const { width: pw, height: ph } = page.getSize();
        const placement = computePatchPlacement(rot, pw, ph, patch.bboxNorm);
        page.drawImage(image, {
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
            rotate: degrees(placement.rotateDeg),
        });
    }

    const before = doc.getPageCount();
    const out = await doc.save();
    if (doc.getPageCount() !== before) {
        throw new Error('Rebuild changed the page count — aborting');
    }
    return out;
};

self.onmessage = (event: MessageEvent<RebuildRequest>) => {
    void (async () => {
        try {
            const bytes = await rebuild(event.data);
            const response: RebuildResponse = { ok: true, bytes };
            (self as unknown as Worker).postMessage(response, [bytes.buffer as ArrayBuffer]);
        } catch (err) {
            const response: RebuildResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
            (self as unknown as Worker).postMessage(response);
        }
    })();
};
