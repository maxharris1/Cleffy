import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

/**
 * Measure/system pixel geometry from an Audiveris .omr project file.
 *
 * The .omr is a zip: book.xml plus one sheet#N/sheet#N.xml per input page
 * (verified against Audiveris 5.6.1 output). Inside a sheet:
 *
 *   <sheet><picture width="2482" height="3512"/>
 *     <page id="1" measure-count="8">
 *       <system id="1">
 *         <stack id="0" left="239" right="481" special="PICKUP" .../>
 *         <stack id="3" left="2366" right="2420" special="CAUTIONARY" .../>  ← courtesy sig, skip
 *         <part><staff><lines><line><point x=".." y=".."/> …
 *
 * Everything is normalized against the sheet raster dimensions here, so the
 * numbers line up with the app's 0–1 page coordinates with no DPI math.
 */

export interface OmrStack {
    x0: number;
    x1: number;
}

export interface OmrSystem {
    y0: number;
    y1: number;
    stacks: OmrStack[];
}

export interface OmrSheet {
    /** 0-based page index in the source PDF (sheet number - 1). */
    pageIndex: number;
    widthPx: number;
    heightPx: number;
    systems: OmrSystem[];
}

export interface OmrGeometry {
    sheets: OmrSheet[];
}

type Elem = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const childElements = (parent: Elem, name?: string): Elem[] => {
    const out: Elem[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const node = parent.childNodes[i];
        if (node && node.nodeType === 1 && (!name || node.nodeName === name)) {
            out.push(node as Elem);
        }
    }
    return out;
};

const intAttr = (el: Elem, name: string): number | null => {
    const raw = el.getAttribute(name);
    if (raw === null || raw === '') {
        return null;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const parseSheetXml = (xml: string, pageIndex: number): OmrSheet | null => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root) {
        return null;
    }
    const picture = root.getElementsByTagName('picture').item(0);
    const width = picture ? intAttr(picture as unknown as Elem, 'width') : null;
    const height = picture ? intAttr(picture as unknown as Elem, 'height') : null;
    if (!width || !height) {
        return null;
    }

    const systems: OmrSystem[] = [];
    for (const page of childElements(root, 'page')) {
        for (const system of collectSystems(page)) {
            const stacks: OmrStack[] = [];
            for (const stack of childElements(system, 'stack')) {
                const special = stack.getAttribute('special');
                if (special === 'CAUTIONARY') {
                    continue; // courtesy time signature at a system end — not a measure
                }
                const left = intAttr(stack, 'left');
                const right = intAttr(stack, 'right');
                if (left === null || right === null || right <= left) {
                    continue;
                }
                stacks.push({ x0: clamp01(left / width), x1: clamp01(right / width) });
            }

            const staffSpans: Array<{ top: number; bottom: number }> = [];
            for (const part of childElements(system, 'part')) {
                for (const staff of childElements(part, 'staff')) {
                    const ys: number[] = [];
                    for (const lines of childElements(staff, 'lines')) {
                        for (const line of childElements(lines, 'line')) {
                            for (const point of childElements(line, 'point')) {
                                const y = intAttr(point, 'y');
                                if (y !== null) {
                                    ys.push(y);
                                }
                            }
                        }
                    }
                    if (ys.length > 0) {
                        staffSpans.push({ top: Math.min(...ys), bottom: Math.max(...ys) });
                    }
                }
            }
            if (stacks.length === 0 || staffSpans.length === 0) {
                continue;
            }
            const top = Math.min(...staffSpans.map((s) => s.top));
            const bottom = Math.max(...staffSpans.map((s) => s.bottom));
            const avgStaffHeight = staffSpans.reduce((sum, s) => sum + (s.bottom - s.top), 0) / staffSpans.length || 40;
            // Pad by one staff height so ledger lines and dynamics sit inside the band.
            const pad = avgStaffHeight;
            systems.push({
                y0: clamp01((top - pad) / height),
                y1: clamp01((bottom + pad) / height),
                stacks,
            });
        }
    }

    return { pageIndex, widthPx: width, heightPx: height, systems };
};

/** Systems can nest under intermediate elements; collect them in document order. */
const collectSystems = (page: Elem): Elem[] => {
    const direct = childElements(page, 'system');
    if (direct.length > 0) {
        return direct;
    }
    const all = (
        page as unknown as { getElementsByTagName: (n: string) => { length: number; item: (i: number) => unknown } }
    ).getElementsByTagName('system');
    const out: Elem[] = [];
    for (let i = 0; i < all.length; i++) {
        out.push(all.item(i) as Elem);
    }
    return out;
};

/**
 * Parse the .omr zip. Returns null when nothing usable was found (the caller
 * degrades to geometry-less ScoreData rather than failing the analysis).
 */
export const parseOmrGeometry = (omrBytes: Buffer): OmrGeometry | null => {
    let zip: AdmZip;
    try {
        zip = new AdmZip(omrBytes);
    } catch {
        return null;
    }
    const sheets: OmrSheet[] = [];
    for (const entry of zip.getEntries()) {
        const match = /^sheet#(\d+)\/sheet#\1\.xml$/.exec(entry.entryName);
        if (!match || !match[1]) {
            continue;
        }
        const pageIndex = Number.parseInt(match[1], 10) - 1;
        try {
            const sheet = parseSheetXml(entry.getData().toString('utf8'), pageIndex);
            if (sheet) {
                sheets.push(sheet);
            }
        } catch {
            // A malformed sheet degrades that page only.
        }
    }
    if (sheets.length === 0) {
        return null;
    }
    sheets.sort((a, b) => a.pageIndex - b.pageIndex);
    return { sheets };
};
