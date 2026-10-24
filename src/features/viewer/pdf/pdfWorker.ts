import { PDFWorker } from 'pdfjs-dist';

/** How long a worker started ahead of need (warmPdfWorker) waits to be used before it is shut down. */
export const SPARE_WORKER_TTL_MS = 60_000;

/** The worker warmPdfWorker started, until createPdfWorker takes it or it expires. */
let spare: { worker: PDFWorker; expiry: ReturnType<typeof setTimeout> } | null = null;

const spawnPdfWorker = (): PDFWorker => {
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

/**
 * One pdf.js worker per loaded document (NOT a shared GlobalWorkerOptions
 * port: destroying a loading task destroys the attached worker, which would
 * kill every other consumer — StrictMode's double-mount surfaces this
 * immediately). We spawn our own module worker via Vite's `new URL` syntax so
 * polyfills load inside the worker scope first — see pdfWorkerEntry.ts.
 * Takes the worker warmPdfWorker started, if there is one.
 */
export const createPdfWorker = (): PDFWorker => {
    if (spare) {
        const { worker, expiry } = spare;
        spare = null;
        clearTimeout(expiry);
        return worker;
    }
    return spawnPdfWorker();
};

/**
 * Start the next createPdfWorker's worker now: the viewer calls this while it
 * is still finding out where the score is. Until its script (about 370 KB
 * compressed) has loaded and run, pdf.js cannot ask for a single byte of the
 * score — on a slow link that is seconds, spent after the score's URL is
 * known unless the worker was started before. Unused, it is shut down after
 * SPARE_WORKER_TTL_MS. Never throws: it only saves time, so a worker that
 * cannot start here (a SecurityError, say) leaves the open as it was, and
 * createPdfWorker meets the same error where it did before warming existed.
 */
export const warmPdfWorker = (): void => {
    if (spare) {
        return;
    }
    let worker: PDFWorker;
    try {
        worker = spawnPdfWorker();
    } catch (err) {
        console.warn('Could not start the pdf.js worker early', err);
        return;
    }
    const expiry = setTimeout(() => {
        if (spare?.worker === worker) {
            spare = null;
            worker.destroy();
        }
    }, SPARE_WORKER_TTL_MS);
    spare = { worker, expiry };
};
