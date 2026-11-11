import { getDocument, PDFDataRangeTransport, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { pdfDocumentOptions } from '@/features/viewer/pdf/pdfDocumentOptions';
import { LOADING_VALUE, PdfContext, type PdfContextValue } from '@/features/viewer/pdf/pdfContext';
import { createPdfWorker } from '@/features/viewer/pdf/pdfWorker';
import { PDF_RANGE_CHUNK, ProgressiveDownload } from '@/features/viewer/pdf/progressiveDownload';
import type { PageSize } from '@/types/models';

/**
 * A score still on the server: pdf.js renders from it while it downloads
 * (see progressiveDownload.ts). The URL must answer GET and byte Range
 * requests without credentials — a Storage signed URL does.
 */
export interface StreamedPdfSource {
    url: string;
}

/** Raw PDF bytes, or a score to stream. */
export type PdfSource = ArrayBuffer | StreamedPdfSource;

export interface PdfProviderProps {
    /**
     * What to show. The provider copies bytes — pdf.js transfers (neuters)
     * its input buffer. A new value (identity) reloads the document.
     */
    data: PdfSource;
    /** A streamed source finished downloading: the whole file, for the offline cache and export. */
    onStreamComplete?: (source: StreamedPdfSource, bytes: ArrayBuffer) => void;
    /**
     * A streamed source failed, before or after page 1 showed. Without this
     * the viewer shows the load error; with it, the caller is expected to
     * hand over another source (typically the bytes, downloaded whole).
     */
    onStreamError?: (source: StreamedPdfSource, err: unknown) => void;
    /**
     * The provider is closing (unmount, or another source) while a streamed
     * source is still downloading. With this, the download is not aborted:
     * pdf.js lets go of it and the caller gets it to finish (onStreamComplete
     * will not be called). Without it, the download is aborted.
     */
    onStreamAbandoned?: (source: StreamedPdfSource, download: ProgressiveDownload) => void;
    children: ReactNode;
}

/** Feeds a ProgressiveDownload to pdf.js. */
class DownloadTransport extends PDFDataRangeTransport {
    /** Handed on (onStreamAbandoned): pdf.js closing must not stop it. */
    released = false;

    constructor(private download: ProgressiveDownload) {
        super(download.length, null);
        download.attach({
            onProgressive: (chunk) => this.onDataProgressiveRead(chunk),
            onRange: (begin, chunk) => this.onDataRange(begin, chunk),
        });
    }

    override requestDataRange(begin: number, end: number): void {
        this.download.requestRange(begin, end);
    }

    override abort(): void {
        if (!this.released) {
            this.download.abort();
        }
    }
}

/** Viewport at scale 1 applies the page's inherent /Rotate — the space annotations are normalized against. */
const pageSize = async (doc: PDFDocumentProxy, pageNumber: number): Promise<PageSize> => {
    const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
};

const allPageSizes = async (doc: PDFDocumentProxy): Promise<PageSize[]> => {
    const sizes: PageSize[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
        sizes.push(await pageSize(doc, i));
    }
    return sizes;
};

/** Shortest gap between two page-size corrections while a streamed score's sizes come in. */
const SIZE_FLUSH_MS = 250;

const errorValue = (err: unknown): PdfContextValue => ({
    doc: null,
    pageSizes: [],
    status: 'error',
    error: err instanceof Error ? err.message : 'Failed to load PDF',
});

export const PdfProvider = ({
    data,
    onStreamComplete,
    onStreamError,
    onStreamAbandoned,
    children,
}: PdfProviderProps) => {
    // Keyed by source: while `source !== data` the derived value is "loading",
    // so no synchronous setState is needed when the input changes.
    const [loaded, setLoaded] = useState<{ source: PdfSource; value: PdfContextValue } | null>(null);
    const callbacks = useRef({ onStreamComplete, onStreamError, onStreamAbandoned });
    useEffect(() => {
        callbacks.current = { onStreamComplete, onStreamError, onStreamAbandoned };
    }, [onStreamComplete, onStreamError, onStreamAbandoned]);

    useEffect(() => {
        let cancelled = false;
        const worker = createPdfWorker();
        let loadingTask: PDFDocumentLoadingTask | null = null;
        let download: ProgressiveDownload | null = null;
        let transport: DownloadTransport | null = null;
        /** The download ended, or failed: there is nothing left to hand on. */
        let settled = false;
        const streamed = data instanceof ArrayBuffer ? null : data;

        let failed = false;
        const fail = (err: unknown) => {
            if (cancelled || failed) {
                return;
            }
            failed = true;
            const report = streamed ? callbacks.current.onStreamError : undefined;
            if (streamed && report) {
                report(streamed, err);
                return;
            }
            setLoaded({ source: data, value: errorValue(err) });
        };

        (async () => {
            try {
                if (!streamed) {
                    // Copy: getDocument transfers the underlying buffer to the
                    // worker, and the caller still owns `data` (export, cache).
                    loadingTask = getDocument({ data: (data as ArrayBuffer).slice(0), worker, ...pdfDocumentOptions });
                } else {
                    const started = await ProgressiveDownload.start(streamed.url);
                    if (cancelled) {
                        if (started instanceof ProgressiveDownload) {
                            started.abort();
                        }
                        return;
                    }
                    if (started instanceof ProgressiveDownload) {
                        download = started;
                        transport = new DownloadTransport(started);
                        loadingTask = getDocument({
                            range: transport,
                            rangeChunkSize: PDF_RANGE_CHUNK,
                            worker,
                            ...pdfDocumentOptions,
                        });
                        started.complete.then(
                            (bytes) => {
                                if (!cancelled) {
                                    settled = true;
                                    callbacks.current.onStreamComplete?.(streamed, bytes);
                                }
                            },
                            (err: unknown) => {
                                settled = true;
                                fail(err);
                            },
                        );
                    } else {
                        // No length to stream against: the whole file it is.
                        loadingTask = getDocument({ data: started.slice(0), worker, ...pdfDocumentOptions });
                        callbacks.current.onStreamComplete?.(streamed, started);
                    }
                }

                const doc = await loadingTask.promise;
                if (!download) {
                    const sizes = await allPageSizes(doc);
                    if (!cancelled) {
                        setLoaded({ source: data, value: { doc, pageSizes: sizes, status: 'ready', error: null } });
                    }
                    return;
                }

                // Streaming: show the score as soon as page 1 is known. Every
                // page takes page 1's size until pdf.js has read its own —
                // reading all the sizes first can cost a round trip per page
                // (any part of the page tree pdf.js has not fetched yet),
                // which is the wait this is avoiding. Scores are almost always
                // one size throughout; the pages that differ are corrected as
                // their sizes come in, not when the download ends, so a page
                // is drawn stretched to page 1's box for as short a time as
                // possible. On a flat page tree pdf.js fetched every page
                // dictionary to open, so that is at once. PdfViewport keeps
                // the reader's place across each correction.
                const first = await pageSize(doc, 1);
                if (cancelled) {
                    return;
                }
                const sizes = Array.from({ length: doc.numPages }, () => first);
                setLoaded({ source: data, value: { doc, pageSizes: [...sizes], status: 'ready', error: null } });

                let dirty = false;
                let flushedAt = performance.now();
                const flush = () => {
                    dirty = false;
                    flushedAt = performance.now();
                    setLoaded({ source: data, value: { doc, pageSizes: [...sizes], status: 'ready', error: null } });
                };
                for (let i = 2; i <= doc.numPages; i++) {
                    const size = await pageSize(doc, i);
                    if (cancelled) {
                        return;
                    }
                    if (size.width !== first.width || size.height !== first.height) {
                        sizes[i - 1] = size;
                        dirty = true;
                    }
                    // One relayout per batch, not per page, when pages trickle in.
                    if (dirty && performance.now() - flushedAt >= SIZE_FLUSH_MS) {
                        flush();
                    }
                }
                if (dirty) {
                    flush();
                }
            } catch (err) {
                fail(err);
            }
        })();

        return () => {
            cancelled = true;
            const handOn = callbacks.current.onStreamAbandoned;
            if (download && transport && streamed && handOn && !settled) {
                // Closed mid-download: the caller finishes it (the offline copy).
                transport.released = true;
                download.release();
                handOn(streamed, download);
            } else {
                download?.abort();
            }
            const task = loadingTask as PDFDocumentLoadingTask | null;
            if (!task) {
                worker.destroy();
                return;
            }
            void task
                .destroy()
                .catch(() => undefined)
                .finally(() => worker.destroy());
        };
    }, [data]);

    const value = loaded && loaded.source === data ? loaded.value : LOADING_VALUE;

    return <PdfContext.Provider value={value}>{children}</PdfContext.Provider>;
};
