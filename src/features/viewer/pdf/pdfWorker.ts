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
    const worker = PDFWorker.create({ port });

    // pdf.js only terminates threads it spawned itself. Handed a `port` it takes
    // the #initializeFromPort branch, which leaves its internal #webWorker null,
    // so destroy() — `this.#webWorker?.terminate()` — terminates nothing. Its
    // "Terminate" message tears down the worker's pdfManager but never calls
    // self.close(), and getDocument only adopts a worker it created itself
    // (`if (!worker) { ... task._worker = worker }`), so loadingTask.destroy()
    // is no help either. We are the only holder of the handle, and a thread left
    // running keeps its isolate, the pdf.js module graph and the loaded wasm
    // decoders resident for the life of the tab — the library shelf now opens
    // one document per score, so that is a leak per row, not per user action.
    const destroyPdfWorker = worker.destroy.bind(worker);
    worker.destroy = () => {
        destroyPdfWorker();
        port.terminate();
    };
    return worker;
};
