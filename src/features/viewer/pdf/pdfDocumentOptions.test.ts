import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pdfDocumentOptions, PDFJS_WASM_URL } from '@/features/viewer/pdf/pdfDocumentOptions';
import { PDFJS_ASSET_DIRS } from '@/features/viewer/pdf/pdfjsAssets';

const pdfjsDir = (...segments: string[]) => resolve(process.cwd(), 'node_modules/pdfjs-dist', ...segments);

describe('pdfDocumentOptions', () => {
    it('points every pdf.js data URL at a same-origin directory with the trailing slash pdf.js requires', () => {
        const urls = [
            pdfDocumentOptions.wasmUrl,
            pdfDocumentOptions.cMapUrl,
            pdfDocumentOptions.standardFontDataUrl,
            pdfDocumentOptions.iccUrl,
        ];
        for (const url of urls) {
            expect(url).toMatch(/^\/[a-z-]+\/$/);
        }
        expect(PDFJS_WASM_URL).toBe(PDFJS_ASSET_DIRS.wasm.publicPath);
        expect(pdfDocumentOptions.cMapPacked).toBe(true);
    });

    it('has the worker fetch its own data, without the URL.parse probe pdf.js would otherwise run', () => {
        expect(pdfDocumentOptions.useWorkerFetch).toBe(true);
    });

    it('keeps XFA form rendering off', () => {
        expect(pdfDocumentOptions.enableXfa).toBe(false);
    });

    it('does not pass options this pdf.js version no longer reads', () => {
        // isEvalSupported was removed from pdf.js; passing it would read as a
        // hardening that does nothing.
        expect(Object.keys(pdfDocumentOptions)).not.toContain('isEvalSupported');
    });
});

describe('PDFJS_ASSET_DIRS', () => {
    it('names directories the installed pdfjs-dist actually ships', () => {
        for (const dir of Object.values(PDFJS_ASSET_DIRS)) {
            expect(existsSync(pdfjsDir(dir.source)), dir.source).toBe(true);
        }
        // The decoders the viewer needs for IMSLP scans.
        expect(existsSync(pdfjsDir('wasm', 'jbig2.wasm'))).toBe(true);
        expect(existsSync(pdfjsDir('wasm', 'openjpeg.wasm'))).toBe(true);
    });

    it('excludes files that exist — an exclusion of a renamed file would silently ship it', () => {
        for (const dir of Object.values(PDFJS_ASSET_DIRS)) {
            for (const name of dir.exclude) {
                expect(existsSync(pdfjsDir(dir.source, name)), `${dir.source}/${name}`).toBe(true);
            }
        }
    });

    it('never ships the document-JavaScript interpreter', () => {
        expect(PDFJS_ASSET_DIRS.wasm.exclude).toEqual(expect.arrayContaining(['quickjs-eval.js', 'quickjs-eval.wasm']));
    });
});
