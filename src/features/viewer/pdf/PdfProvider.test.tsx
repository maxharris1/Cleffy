import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePdf } from '@/features/viewer/pdf/pdfContext';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import type { ProgressiveDownload } from '@/features/viewer/pdf/progressiveDownload';

/** A 3-page document whose last page is landscape; records which pages were asked for. */
const pdfjs = vi.hoisted(() => ({
    getPageCalls: [] as number[],
    params: [] as Array<Record<string, unknown>>,
    /** When set, pages after the first resolve only once it does (pdf.js still reading them). */
    laterPages: null as Promise<void> | null,
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
            if (n > 1 && pdfjs.laterPages) {
                await pdfjs.laterPages;
            }
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
    pdfjs.laterPages = null;
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('PdfProvider streaming a score', () => {
    it('is ready after page 1 and corrects page sizes as pdf.js reads them, before the download ends', async () => {
        const storage = host();
        const onStreamComplete = vi.fn();
        const source = { url: 'https://storage.example/signed' };
        let readLaterPages: () => void = () => undefined;
        pdfjs.laterPages = new Promise((resolve) => {
            readLaterPages = resolve;
        });
        render(
            <PdfProvider data={source} onStreamComplete={onStreamComplete}>
                <Probe />
            </PdfProvider>,
        );

        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));
        // Ready on page 1 alone: the others take its size for now.
        expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,600x800');
        expect(pdfjs.params[0]).toHaveProperty('range');
        expect(pdfjs.params[0]).not.toHaveProperty('data');

        // The landscape page is corrected as soon as pdf.js has read it,
        // while the score still downloads, not stretched into page 1's box
        // until the end.
        act(() => readLaterPages());
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,800x600'));
        expect(onStreamComplete).not.toHaveBeenCalled();
        expect(pdfjs.getPageCalls).toEqual([1, 2, 3]);

        act(() => storage.finish(true));

        await waitFor(() => expect(onStreamComplete).toHaveBeenCalledTimes(1));
        const [calledWith, bytes] = onStreamComplete.mock.calls[0] as [unknown, ArrayBuffer];
        expect(calledWith).toBe(source);
        expect(new Uint8Array(bytes)).toEqual(FILE);
        expect(screen.getByTestId('probe')).toHaveTextContent('600x800,600x800,800x600');
        expect(storage.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('hands a download still running at unmount to the caller, which can let it finish', async () => {
        const storage = host();
        const onStreamComplete = vi.fn();
        const onStreamAbandoned = vi.fn();
        const source = { url: 'https://storage.example/signed' };
        const view = render(
            <PdfProvider data={source} onStreamComplete={onStreamComplete} onStreamAbandoned={onStreamAbandoned}>
                <Probe />
            </PdfProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));

        // The reader leaves on page 1, long before the file is in.
        view.unmount();

        expect(onStreamAbandoned).toHaveBeenCalledTimes(1);
        const [calledWith, download] = onStreamAbandoned.mock.calls[0] as [unknown, ProgressiveDownload];
        expect(calledWith).toBe(source);
        act(() => storage.finish(true));
        expect(new Uint8Array(await download.complete)).toEqual(FILE);
        expect(onStreamComplete).not.toHaveBeenCalled();
    });

    it('aborts a download still running at unmount when nobody takes it', async () => {
        host();
        const view = render(
            <PdfProvider data={{ url: 'https://storage.example/signed' }}>
                <Probe />
            </PdfProvider>,
        );
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveAttribute('data-status', 'ready'));
        const transport = pdfjs.params[0]?.['range'] as { abort: () => void } & Record<string, unknown>;
        const download = transport['download'] as ProgressiveDownload;

        view.unmount();

        await expect(download.complete).rejects.toThrow(/aborted/);
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
