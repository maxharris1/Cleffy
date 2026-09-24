import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);

const DRAW_OPS = {
    moveTo: 0,
    lineTo: 1,
    curveTo: 2,
    quadraticCurveTo: 3,
    closePath: 4,
} as const;

let workerReady = false;

const ensureWorker = (): void => {
    if (workerReady) {
        return;
    }
    GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    workerReady = true;
};

export const openPdfDocument = async (pdfBytes: Uint8Array): Promise<Awaited<ReturnType<typeof getDocument>['promise']>> => {
    ensureWorker();
    // pdf.js transfers TypedArrays to the worker; copy so callers keep their buffer.
    const data = Uint8Array.from(pdfBytes);
    return getDocument({
        data,
        verbosity: 0,
        useSystemFonts: true,
    }).promise;
};

export { DRAW_OPS, OPS };
