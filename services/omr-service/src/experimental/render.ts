import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RenderedPage {
    /** 0-based page index in the PDF. */
    pageIndex: number;
    path: string;
}

/**
 * Rasterise a PDF with poppler's pdftoppm (grayscale PNG). 150 dpi is enough
 * for staff-line CV and is what the LLM receives too (Anthropic downsizes the
 * long edge to ~1568 px anyway).
 */
export const renderPdfPages = async (
    pdfPath: string,
    outDir: string,
    options: { dpi?: number; first?: number; last?: number; gray?: boolean } = {},
): Promise<RenderedPage[]> => {
    const args = ['-r', String(options.dpi ?? 150), '-png'];
    if (options.gray ?? true) {
        args.push('-gray');
    }
    if (options.first) {
        args.push('-f', String(options.first));
    }
    if (options.last) {
        args.push('-l', String(options.last));
    }
    await run('pdftoppm', [...args, pdfPath, join(outDir, 'page')], { timeout: 600_000 });
    const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f));
    return files
        .map((f) => ({ pageIndex: Number(/(\d+)/.exec(f)?.[1] ?? '1') - 1, path: join(outDir, f) }))
        .sort((a, b) => a.pageIndex - b.pageIndex);
};

export const pdfPageCount = async (pdfPath: string): Promise<number> => {
    const { stdout } = await run('pdfinfo', [pdfPath]);
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    return m ? Number(m[1]) : 0;
};
