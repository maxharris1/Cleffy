/**
 * One download of a score that pdf.js can render from before it finishes.
 *
 * A cold open used to wait for the whole file before page 1 (QA: 27.5 s for a
 * 150-page scan on Fast 3G). pdf.js can open a document from a partial file,
 * but its own URL loader cannot be used here: it needs `Accept-Ranges` and
 * `Content-Range` to be readable, and cross-origin those are hidden unless the
 * storage host exposes them. So the app does the fetching and hands pdf.js the
 * bytes through a PDFDataRangeTransport (see PdfProvider):
 *
 * - one plain GET streams the whole file front to back. Its bytes go to pdf.js
 *   as they arrive and into one buffer, which becomes the offline copy and
 *   the export source when the stream ends — the file is downloaded once;
 * - when pdf.js needs bytes the stream has not reached, they are fetched with
 *   a Range request. A 206 is answered by status alone, so no header needs to
 *   be exposed. A server that ignores Range (200), or any failure, just waits
 *   for the stream to get there — slower, never wrong. Opening a document
 *   needs the cross-reference table (at the very end of a non-linearized PDF)
 *   and, because pdf.js checks the last page on open, every page dictionary
 *   of a flat page tree — one small object per page, spread through the file.
 *   Those requests are many and tiny (PDF_RANGE_CHUNK), and ask for high
 *   priority; the stream asks for low, so on HTTP/2 they go first. They are
 *   the only bytes fetched twice.
 *
 * Content-Length must be readable (it is CORS-safelisted). Without it there is
 * nothing to tell pdf.js the file size, and `start` reads the whole file
 * instead, which is what every open did before.
 */

/**
 * pdf.js range granularity, in bytes. Its default (64 KiB) made every page
 * dictionary of a 150-page scan cost a 64 KiB request — the whole file again
 * before page 1. At 4 KiB the same open fetches about a sixth of that.
 */
export const PDF_RANGE_CHUNK = 4096;

/**
 * Ranges starting less than this far past the stream are left to it: on a
 * slow link they arrive sooner than a request's round trip would bring them.
 */
const STREAM_LOOKAHEAD = 64 * 1024;

/** Said once per page load: every later Range request would be ignored too. */
let warnedNoRange = false;

/** Where the bytes go: PdfProvider's PDFDataRangeTransport. */
export interface DownloadSink {
    /** The next bytes of the front-to-back stream. */
    onProgressive(chunk: Uint8Array): void;
    /** Bytes `begin`…`begin + chunk.length` that `requestRange` asked for. */
    onRange(begin: number, chunk: Uint8Array): void;
}

interface PendingRange {
    begin: number;
    end: number;
    controller: AbortController | null;
    done: boolean;
}

export class ProgressiveDownload {
    /** The whole file, once the stream ends; rejects if it fails. */
    readonly complete: Promise<ArrayBuffer>;
    private buffer: Uint8Array;
    private loaded = 0;
    private sink: DownloadSink | null = null;
    private pending: PendingRange[] = [];
    private aborted = false;
    private resolveComplete!: (bytes: ArrayBuffer) => void;
    private rejectComplete!: (err: unknown) => void;

    private constructor(
        private url: string,
        readonly length: number,
        private fetchImpl: typeof fetch,
        private streamAbort: AbortController,
        reader: ReadableStreamDefaultReader<Uint8Array>,
    ) {
        this.buffer = new Uint8Array(length);
        this.complete = new Promise<ArrayBuffer>((resolve, reject) => {
            this.resolveComplete = resolve;
            this.rejectComplete = reject;
        });
        // Nobody may be listening yet (the transport needs `length` first);
        // a rejection is still reported through `complete` to whoever is.
        this.complete.catch(() => undefined);
        void this.pump(reader);
    }

    /**
     * Open `url`. Resolves to a download pdf.js can start on, or — when the
     * response has no usable length or body — to the whole file, read to the
     * end. Rejects when the request fails or the server says no.
     */
    static async start(url: string, fetchImpl: typeof fetch = fetch): Promise<ProgressiveDownload | ArrayBuffer> {
        const streamAbort = new AbortController();
        const response = await fetchImpl(url, { signal: streamAbort.signal, priority: 'low' });
        if (!response.ok) {
            throw new Error(`Could not download score: HTTP ${response.status}`);
        }
        const length = Number(response.headers.get('content-length'));
        if (!response.body || !Number.isInteger(length) || length <= 0) {
            // Visible in the field: page 1 now waits for the whole file again.
            console.warn('Score response has no readable Content-Length; reading it whole before page 1');
            return response.arrayBuffer();
        }
        // Called unbound later: window.fetch with another `this` throws.
        const fetchRange: typeof fetch = (input, init) => fetchImpl(input, init);
        return new ProgressiveDownload(url, length, fetchRange, streamAbort, response.body.getReader());
    }

    /** Bytes received so far, front to back. */
    get received(): number {
        return this.loaded;
    }

    /** Start delivering. What already arrived is handed over at once, as one chunk. */
    attach(sink: DownloadSink): void {
        this.sink = sink;
        if (this.loaded > 0) {
            sink.onProgressive(this.buffer.slice(0, this.loaded));
        }
    }

    /** pdf.js needs bytes [begin, end) now. */
    requestRange(begin: number, end: number): void {
        const range: PendingRange = { begin, end: Math.min(end, this.length), controller: null, done: false };
        if (this.aborted) {
            return;
        }
        if (range.end <= this.loaded) {
            // Already here; answered asynchronously, as a network reply would be.
            queueMicrotask(() => this.deliver(range, this.buffer.slice(range.begin, range.end)));
            return;
        }
        this.pending.push(range);
        // Bytes just ahead of the stream are its very next ones; a second
        // request for them would only split the bandwidth.
        if (range.begin >= this.loaded + STREAM_LOOKAHEAD) {
            void this.fetchRange(range);
        }
    }

    /**
     * pdf.js is done with this download (the viewer closed) but the file is
     * still wanted, for the offline copy: drop pdf.js and the Range requests
     * it asked for, and let the stream run to the end.
     */
    release(): void {
        this.sink = null;
        for (const range of this.pending) {
            range.controller?.abort();
        }
        this.pending = [];
    }

    /** Stop every request (the document was closed). */
    abort(): void {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.streamAbort.abort();
        for (const range of this.pending) {
            range.controller?.abort();
        }
        this.pending = [];
        this.rejectComplete(new DOMException('Download aborted', 'AbortError'));
    }

    private async fetchRange(range: PendingRange): Promise<void> {
        const controller = new AbortController();
        range.controller = controller;
        try {
            const response = await this.fetchImpl(this.url, {
                headers: { Range: `bytes=${range.begin}-${range.end - 1}` },
                signal: controller.signal,
                priority: 'high',
            });
            if (response.status !== 206) {
                // The server sent the whole file instead: the stream already is.
                if (!warnedNoRange) {
                    warnedNoRange = true;
                    console.warn(
                        `Score host ignored a Range request (HTTP ${response.status}); waiting for the stream`,
                    );
                }
                controller.abort();
                return;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength === range.end - range.begin) {
                this.deliver(range, bytes);
            }
        } catch {
            // Aborted, offline, refused: the stream covers it, or fails itself.
        }
    }

    private deliver(range: PendingRange, bytes: Uint8Array): void {
        if (range.done || this.aborted) {
            return;
        }
        range.done = true;
        range.controller?.abort();
        this.pending = this.pending.filter((other) => other !== range);
        this.sink?.onRange(range.begin, bytes);
    }

    private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (this.loaded + value.byteLength > this.length) {
                    // Longer than announced (a compressed response): the
                    // length pdf.js was given is wrong, so this load is too.
                    throw new Error('Score download is longer than its Content-Length');
                }
                this.buffer.set(value, this.loaded);
                this.loaded += value.byteLength;
                this.sink?.onProgressive(value);
                // Ranges the stream has now reached need no network reply.
                for (const range of [...this.pending]) {
                    if (range.end <= this.loaded) {
                        this.deliver(range, this.buffer.slice(range.begin, range.end));
                    }
                }
            }
            if (this.loaded !== this.length) {
                throw new Error('Score download ended early');
            }
            this.resolveComplete(this.buffer.buffer as ArrayBuffer);
        } catch (err) {
            // The real reason first; abort()'s own rejection is then a no-op.
            this.rejectComplete(err);
            this.abort();
        }
    }
}
