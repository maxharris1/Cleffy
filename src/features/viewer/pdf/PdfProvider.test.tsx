import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePdf } from '@/features/viewer/pdf/pdfContext';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';

/** A 3-page document whose last page is landscape; records which pages were asked for. */
const pdfjs = vi.hoisted(() => ({
    getPageCalls: [] as number[],
    params: [] as Array<Record<string, unknown>>,
}));

vi.mock('pdfjs-dist', () => {
    class PDFDataRangeTransport {
        constructor(
            readonly length: number,
            readonly initialData: unknown,
        ) {}
        onDataProgressiveRead(): void {}
        onDataRange(): void {}
        requestDataRange(): void {}
        abort(): void {}
    }
    const doc = {
        numPages: 3,
        getPage: async (n: number) => {
            pdfjs.getPageCalls.push(n);
            return { getViewport: () => (n === 3 ? { width: 800, height: 600 } : { width: 600, height: 800 }) };
        },
    };
    return {
        PDFDataRangeTransport,
        getDocument: (params: Record<string, unknown>) => {
            pdfjs.params.push(params);
            return { promise: Promise.resolve(doc), destroy: () => Promise.resolve() };
        },
    };
});
vi.mock('@/features/viewer/pdf/pdfWorker', () => ({ createPdfWorker: () => ({ destroy: () => undefined }) }));

const FILE = new Uint8Array(50_000).fill(7);

/** The storage host: a full GET whose body the test releases. */
const host = () => {
    let finish: (ok: boolean) => void = () => undefined;
    const fetchMock = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(FILE.slice(0, 1000));
                finish = (ok) => {
                    if (ok) {
                        controller.enqueue(FILE.slice(1000));
                        controller.close();
                    } else {
                        controller.error(new TypeError('network error'));
                    }
                };
            },
        });
        return new Response(body, { status: 200, headers: { 'Content-Length': String(FILE.length) } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { finish: (ok: boolean) => finish(ok), fetchMock };
};

const Probe = () => {
    const { status, pageSizes, error } = usePdf();
    return (
        <p data-testid="probe" data-status={status} data-error={error ?? ''}>
            {pageSizes.map((s) => `${s.width}x${s.height}`).join(',')}
        </p>
    );
};

beforeEach(() => {
    pdfjs.getPageCalls = [];
    pdfjs.params = [];
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('PdfProvider streaming a score', () => {
    it('is ready after page 1, before the download ends, then corrects page sizes once it has', async () => {
        const storage = host();
        const onStreamComplete = vi.fn();
        const source = { url: 'https://storage.example/signed' };
        render(
            <PdfProvider data={source} onStreamComplete={onStreamComplete}>
                <Probe />
            </PdfProvider>,
        );

        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));
        // Only page 1 was asked for; the others take its size for now.
        expect(pdfjs.getPageCalls).toEqual([1]);
        expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,600x800');
        expect(pdfjs.params[0]).toHaveProperty('range');
        expect(pdfjs.params[0]).not.toHaveProperty('data');
        expect(onStreamComplete).not.toHaveBeenCalled();

        act(() => storage.finish(true));

        await waitFor(() => expect(onStreamComplete).toHaveBeenCalledTimes(1));
        const [calledWith, bytes] = onStreamComplete.mock.calls[0] as [unknown, ArrayBuffer];
        expect(calledWith).toBe(source);
        expect(new Uint8Array(bytes)).toEqual(FILE);
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,800x600'));
        expect(storage.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('hands a failed stream to the caller instead of showing an error', async () => {
        const storage = host();
        const onStreamError = vi.fn();
        render(
            <PdfProvider data={{ url: 'https://storage.example/signed' }} onStreamError={onStreamError}>
                <Probe />
            </PdfProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));

        act(() => storage.finish(false));

        await waitFor(() => expect(onStreamError).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready');
    });

    it('shows the error when nobody takes a failed stream', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('gone', { status: 400 })),
        );
        render(
            <PdfProvider data={{ url: 'https://storage.example/signed' }}>
                <Probe />
            </PdfProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'error'));
        expect(screen.getByTestId('probe')).toHaveAttribute('data-error', expect.stringMatching(/HTTP 400/));
    });
});

describe('PdfProvider with bytes', () => {
    it('knows every page size before it is ready, as before', async () => {
        render(
            <PdfProvider data={FILE.slice().buffer}>
                <Probe />
            </PdfProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));
        expect(pdfjs.getPageCalls).toEqual([1, 2, 3]);
        expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,800x600');
        expect(pdfjs.params[0]).toHaveProperty('data');
    });
});
