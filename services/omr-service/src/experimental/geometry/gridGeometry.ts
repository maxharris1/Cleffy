import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

import type { CheapGeometry, CheapSheet, CheapSystem } from './types.js';

const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';

type Elem = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const children = (parent: Elem, name?: string): Elem[] => {
    const out: Elem[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const node = parent.childNodes[i];
        if (node && node.nodeType === 1 && (!name || node.nodeName === name)) {
            out.push(node as Elem);
        }
    }
    return out;
};

const num = (el: Elem | null | undefined, attr: string): number | null => {
    const raw = el?.getAttribute(attr);
    if (raw === null || raw === undefined || raw === '') {
        return null;
    }
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
};

/**
 * Track A, variant 2: Audiveris stopped at its GRID step (`-step GRID -save`).
 * LOAD→BINARY→SCALE→GRID yields staves, systems (via bar connectors) and
 * barlines; no heads, stems, rhythm or OCR. The intermediate .omr has no
 * <stack> elements, so measures are rebuilt here from each system's top-staff
 * barlines. `columns` stay empty — GRID does not see noteheads.
 */
export const extractGridGeometry = async (pdfPath: string, workDir: string): Promise<CheapGeometry> => {
    const t0 = Date.now();
    const outDir = join(workDir, 'grid-out');
    await mkdir(outDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn(AUDIVERIS_BIN, ['-batch', '-step', 'GRID', '-save', '-output', outDir, '--', pdfPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
        child.on('error', reject);
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Audiveris GRID exited ${code}: ${stderr.slice(-500)}`));
            }
        });
    });
    const detectMs = Date.now() - t0;
    const omrName = (await readdir(outDir)).find((f) => f.endsWith('.omr'));
    if (!omrName) {
        throw new Error('Audiveris GRID produced no .omr');
    }
    const zip = new AdmZip(await readFile(join(outDir, omrName)));
    const sheets: CheapSheet[] = [];
    for (const entry of zip.getEntries()) {
        const m = /^sheet#(\d+)\/sheet#\1\.xml$/.exec(entry.entryName);
        if (!m?.[1]) {
            continue;
        }
        const sheet = parseGridSheet(entry.getData().toString('utf8'), Number(m[1]) - 1);
        if (sheet) {
            sheets.push(sheet);
        }
    }
    sheets.sort((a, b) => a.pageIndex - b.pageIndex);
    return { sheets, source: 'audiveris-grid', timings: { renderMs: 0, detectMs, totalMs: Date.now() - t0 } };
};

const parseGridSheet = (xml: string, pageIndex: number): CheapSheet | null => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root) {
        return null;
    }
    const picture = children(root, 'picture')[0];
    const width = num(picture, 'width');
    const height = num(picture, 'height');
    if (!width || !height) {
        return null;
    }
    const interline = num(children(children(root, 'scale')[0] ?? root, 'interline')[0], 'main') ?? 20;

    // Barline inters by id (bounds are absolute px).
    const barlineX = new Map<number, number>();
    const all = root.getElementsByTagName('barline');
    for (let i = 0; i < all.length; i++) {
        const bl = all.item(i) as Elem;
        const id = num(bl, 'id');
        const bounds = children(bl, 'bounds')[0];
        const x = num(bounds, 'x');
        const w = num(bounds, 'w') ?? 0;
        if (id !== null && x !== null) {
            barlineX.set(id, x + w / 2);
        }
    }

    const systems: CheapSystem[] = [];
    for (const page of children(root, 'page')) {
        for (const system of children(page, 'system')) {
            const staves: Array<{ top: number; bottom: number; left: number; right: number; bars: number[] }> = [];
            for (const part of children(system, 'part')) {
                for (const staff of children(part, 'staff')) {
                    const ys: number[] = [];
                    for (const lines of children(staff, 'lines')) {
                        for (const line of children(lines, 'line')) {
                            for (const point of children(line, 'point')) {
                                const y = num(point, 'y');
                                if (y !== null) {
                                    ys.push(y);
                                }
                            }
                        }
                    }
                    if (ys.length === 0) {
                        continue;
                    }
                    const ids = (children(staff, 'barlines')[0]?.textContent ?? '')
                        .trim()
                        .split(/\s+/)
                        .map(Number)
                        .filter((n) => Number.isFinite(n));
                    staves.push({
                        top: Math.min(...ys),
                        bottom: Math.max(...ys),
                        left: num(staff, 'left') ?? 0,
                        right: num(staff, 'right') ?? width,
                        bars: ids.map((id) => barlineX.get(id)).filter((x): x is number => x !== undefined),
                    });
                }
            }
            if (staves.length === 0) {
                continue;
            }
            const first = staves[0]!;
            const left = Math.min(...staves.map((s) => s.left));
            const right = Math.max(...staves.map((s) => s.right));
            const xs = collapse([...first.bars].sort((a, b) => a - b), interline * 1.1);
            if (xs.length === 0 || xs[0]! > left + interline * 1.5) {
                xs.unshift(left);
            }
            if (xs[xs.length - 1]! < right - interline * 1.5) {
                xs.push(right);
            }
            const stacks = [];
            for (let i = 1; i < xs.length; i++) {
                const x0 = xs[i - 1]!;
                const x1 = xs[i]!;
                if (x1 - x0 < interline * 2.5) {
                    continue;
                }
                stacks.push({ x0: x0 / width, x1: x1 / width, slots: [], columns: [] });
            }
            const top = Math.min(...staves.map((s) => s.top));
            const bottom = Math.max(...staves.map((s) => s.bottom));
            const staffH = (first.bottom - first.top) || interline * 4;
            systems.push({
                y0: Math.max(0, (top - staffH) / height),
                y1: Math.min(1, (bottom + staffH) / height),
                staves: staves.map((s) => ({ y0: s.top / height, y1: s.bottom / height })),
                stacks,
            });
        }
    }
    return { pageIndex, widthPx: width, heightPx: height, systems };
};

/** Merge x positions closer than tol (double/final barlines, repeat signs). */
const collapse = (xs: number[], tol: number): number[] => {
    const out: number[] = [];
    for (const x of xs) {
        const last = out[out.length - 1];
        if (last !== undefined && x - last <= tol) {
            out[out.length - 1] = (last + x) / 2;
        } else {
            out.push(x);
        }
    }
    return out;
};
