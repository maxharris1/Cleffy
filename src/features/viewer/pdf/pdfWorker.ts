import { PDFWorker } from 'pdfjs-dist';

/**
 * One pdf.js worker per loaded document (NOT a shared GlobalWorkerOptions
 * port: destroying a loading task destroys the attached worker, which would
 * kill every other consumer — StrictMode's double-mount surfaces this
 * immediately). We spawn our own module worker via Vite's `new URL` syntax so
 * polyfills load inside the worker scope first — see pdfWorkerEntry.ts.
 */
export const createPdfWorker = (): PDFWorker => {
    const port = new Worker(new URL('./pdfWorkerEntry.ts', import.meta.url), { type: 'module' });
    // PDFWorker.create, not `new PDFWorker(...)`: the constructor's generated
    // .d.ts mistypes `port` as `null`, while the factory takes PDFWorkerParameters.
    return PDFWorker.create({ port });
};
