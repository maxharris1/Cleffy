import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * Fresh copy per test: the module holds no state today, but the import is
 * cheap and this keeps the mock's call counts honest.
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
