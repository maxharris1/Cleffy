import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { renderPdfPages } from '../render.js';
import type { CheapGeometry, CheapSheet } from './types.js';

const run = promisify(execFile);

/** dist/experimental/geometry → src/experimental/geometry (the .py is not compiled). */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'cv_geometry.py').replace(
    `${join('dist', 'experimental')}`,
    `${join('src', 'experimental')}`,
);

interface CvPage {
    index: number;
    width: number;
    height: number;
    interline: number | null;
    systems: Array<{
        y0: number;
        y1: number;
        staves: Array<{ y0: number; y1: number; x0: number; x1: number }>;
        barlines: number[];
        measures: Array<{ x0: number; x1: number; columns: number[] }>;
    }>;
}

/**
 * Track A, variant 1: OpenCV staff/system/barline detection. Renders the PDF
 * and runs cv_geometry.py once for all pages.
 */
export const extractCvGeometry = async (pdfPath: string, workDir: string): Promise<CheapGeometry> => {
    const t0 = Date.now();
    const pages = await renderPdfPages(pdfPath, workDir, { dpi: 150, gray: true });
    const renderMs = Date.now() - t0;
    const t1 = Date.now();
    const { stdout } = await run(process.env.PYTHON_BIN ?? 'python3', [SCRIPT, ...pages.map((p) => p.path)], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600_000,
    });
    const parsed = JSON.parse(stdout) as { pages: CvPage[] };
    const detectMs = Date.now() - t1;
    const sheets: CheapSheet[] = parsed.pages.map((page, i) => ({
        pageIndex: pages[i]?.pageIndex ?? i,
        widthPx: page.width,
        heightPx: page.height,
        systems: page.systems.map((s) => ({
            y0: s.y0,
            y1: s.y1,
            staves: s.staves.map((st) => ({ y0: st.y0, y1: st.y1 })),
            stacks: s.measures.map((m) => ({ x0: m.x0, x1: m.x1, slots: [], columns: m.columns })),
        })),
    }));
    return { sheets, source: 'cv', timings: { renderMs, detectMs, totalMs: Date.now() - t0 } };
};
