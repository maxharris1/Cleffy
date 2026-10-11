import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const terminate = vi.hoisted(() => vi.fn());
const pdfWorkerDestroy = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn(() => ({ destroy: pdfWorkerDestroy })));
vi.mock('pdfjs-dist', () => ({ PDFWorker: { create } }));

beforeEach(() => {
    terminate.mockClear();
    pdfWorkerDestroy.mockClear();
    create.mockClear();
    // jsdom implements neither Worker nor module workers.
    vi.stubGlobal(
        'Worker',
        class {
            terminate = terminate;
        },
    );
});

/**
 * Fresh copy per test: the module holds the warmed worker, and this keeps the
 * mock's call counts honest.
 */
const loadModule = async () => {
    vi.resetModules();
    return import('@/features/viewer/pdf/pdfWorker');
};

describe('createPdfWorker', () => {
    it('terminates the thread it spawned, which PDFWorker.destroy() leaves running for a port it was handed', async () => {
        const { createPdfWorker } = await loadModule();
        const worker = createPdfWorker();
        expect(create).toHaveBeenCalledTimes(1);

        worker.destroy();

        expect(pdfWorkerDestroy).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledTimes(1);
    });
});

describe('warmPdfWorker', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts the worker early, and the next createPdfWorker takes it instead of starting another', async () => {
        const { createPdfWorker, warmPdfWorker } = await loadModule();
        warmPdfWorker();
        warmPdfWorker();
        expect(create).toHaveBeenCalledTimes(1);

        const worker = createPdfWorker();
        expect(create).toHaveBeenCalledTimes(1);
        expect(worker).toBe(create.mock.results[0]!.value);

        // Taken: the one after that is a new worker.
        createPdfWorker();
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('shuts a warmed worker down when nothing takes it', async () => {
        vi.useFakeTimers();
        const { createPdfWorker, warmPdfWorker, SPARE_WORKER_TTL_MS } = await loadModule();
        warmPdfWorker();

        vi.advanceTimersByTime(SPARE_WORKER_TTL_MS);

        expect(terminate).toHaveBeenCalledTimes(1);
        createPdfWorker();
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('leaves a taken worker running past the expiry', async () => {
        vi.useFakeTimers();
        const { createPdfWorker, warmPdfWorker, SPARE_WORKER_TTL_MS } = await loadModule();
        warmPdfWorker();
        createPdfWorker();

        vi.advanceTimersByTime(SPARE_WORKER_TTL_MS);

        expect(terminate).not.toHaveBeenCalled();
    });
});
