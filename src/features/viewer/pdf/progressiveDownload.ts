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
 *   be exposed. A server that ignores Range (200) is not asked again; a
 *   failed request (an error status, offline) leaves its range to the stream
 *   — slower, never wrong — and later ranges are still asked for; a read that
 *   only counted on it for some bytes asks for them again. Bytes a
 *   Range request brings only ever go where the stream has not been yet, so
 *   the finished file is exactly what the stream sent, even if the object
 *   was replaced in between. Opening a document
 *   needs the cross-reference table (at the very end of a non-linearized PDF)
 *   and, because pdf.js checks the last page on open, every page dictionary
 *   of a flat page tree — one small object per page, spread through the file.
 *   Those requests are many and tiny (MIN_RANGE_FETCH), and ask for high
 *   priority; the stream asks for low, so on HTTP/2 they go first. They are
 *   the only bytes fetched twice. What a request brings beyond what pdf.js
 *   asked for (the end of the file, a read-ahead) is kept in the same buffer
 *   and answers pdf.js's next request for it without the network.
 *
 * Content-Length must be readable (it is CORS-safelisted). Without it there is
 * nothing to tell pdf.js the file size, and `start` reads the whole file
 * instead, which is what every open did before.
 */

/**
 * pdf.js range granularity, in bytes: the unit it asks for and marks as
 * loaded. Opening a scan costs one request per page dictionary (see above),
 * and each asks for at least one unit, so the unit sets what that costs: at
 * pdf.js's default (64 KiB) a 150-page scan fetched the whole file again
 * before page 1; at 4 KiB, 600 KiB of mostly unused bytes, 3.5 s of Fast 3G.
 * A small unit would cost a round trip each for anything read in sequence
 * (the cross-reference table), so how much one request fetches is decided
 * here, not by pdf.js (`window`).
 */
export const PDF_RANGE_CHUNK = 512;

/**
 * The least one Range request fetches: two units. A page dictionary is a few
 * hundred bytes; one that starts near the end of its unit still arrives
 * whole, instead of costing a second round trip for the next unit.
 */
export const MIN_RANGE_FETCH = 2 * PDF_RANGE_CHUNK;

/**
 * The first request near the end of the file fetches this much of it: the
 * cross-reference table (about 20 bytes per object; 9 KiB for a 150-page
 * scan) and the trailer, which pdf.js otherwise reads one unit, and one
 * round trip, at a time.
 */
export const TAIL_FETCH = 64 * 1024;

/**
 * pdf.js reading on from where a request ended gets the next one twice as
 * big, up to this: a long run (a big cross-reference table) takes a few
 * round trips, not one per unit.
 */
export const MAX_RANGE_FETCH = 256 * 1024;

/**
 * Ranges starting less than this far past the stream are left to it: on a
 * slow link they arrive sooner than a request's round trip would bring them.
 */
const STREAM_LOOKAHEAD = 64 * 1024;

/**
 * How often a read is asked for again because a request it waited on, sent
 * for another read, failed. Bounded so a host that keeps refusing is not
 * asked in a loop; past it, the read waits for the stream.
 */
const MAX_RANGE_RETRIES = 2;

/** Said once per page load: every later Range request would be ignored too. */
let warnedNoRange = false;
/** Said once per page load: a host that refuses one likely refuses more. */
let warnedRangeFailed = false;

/** Where the bytes go: PdfProvider's PDFDataRangeTransport. */
export interface DownloadSink {
    /** The next bytes of the front-to-back stream. */
    onProgressive(chunk: Uint8Array): void;
    /**
     * Bytes from `begin`, for a `requestRange(begin, …)`: at least what it
     * asked for, and possibly more, ending on a PDF_RANGE_CHUNK boundary or
     * at the end of the file (pdf.js takes whole units only).
     */
    onRange(begin: number, chunk: Uint8Array): void;
}

/** What pdf.js asked for and has not been given yet. */
interface PendingRange {
    begin: number;
    end: number;
    done: boolean;
    /** Requests sent for this read itself (not ones it waited on that another read started). */
    own: Set<RangeFetch>;
    /** Times it was asked for again after a request it waited on failed (MAX_RANGE_RETRIES). */
    retries: number;
}

/** A Range request in flight, for bytes [begin, end). */
interface RangeFetch {
    begin: number;
    end: number;
    controller: AbortController;
    /** Refused, cut short or lost (not aborted because it was no longer needed). */
    failed: boolean;
}

/** Bytes [begin, end) that Range requests brought, kept in `buffer`. */
interface Span {
    begin: number;
    end: number;
}

export class ProgressiveDownload {
    /** The whole file, once the stream ends; rejects if it fails. */
    readonly complete: Promise<ArrayBuffer>;
    private buffer: Uint8Array;
    private loaded = 0;
    private sink: DownloadSink | null = null;
    private pending: PendingRange[] = [];
    private fetches = new Set<RangeFetch>();
    /** Sorted, disjoint and never touching (neighbours are merged). */
    private fetched: Span[] = [];
    /** The size of each request, by where it ended: reading on from there fetches more. */
    private sizeEndingAt = new Map<number, number>();
    /**
     * The host answered a Range request with the whole file: it will do so
     * again, so everything waits for the stream rather than starting more
     * whole-file responses.
     */
    private rangesIgnored = false;
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
        // pdf.js's first question is always the end of the file (where the
        // cross-reference table starts). Asked now, the answer is on its way
        // while the pdf.js worker is still starting up.
        if (length - TAIL_FETCH >= STREAM_LOOKAHEAD) {
            this.fetchRange(...this.window(length - 1, length));
        }
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
        const range: PendingRange = {
            begin,
            end: Math.min(end, this.length),
            done: false,
            own: new Set(),
            retries: 0,
        };
        if (this.aborted) {
            return;
        }
        if (this.has(range.begin, range.end)) {
            // Already here; answered asynchronously, as a network reply would be.
            queueMicrotask(() => this.deliver(range));
            return;
        }
        this.pending.push(range);
        this.dispatch(range);
    }

    /** Ask the network for a pending range, unless the stream or a request on its way brings it. */
    private dispatch(range: PendingRange): void {
        const from = this.missingFrom(range.begin, range.end);
        // Bytes just ahead of the stream are its very next ones; a second
        // request for them would only split the bandwidth.
        if (from < this.loaded + STREAM_LOOKAHEAD || this.rangesIgnored) {
            return;
        }
        for (const inFlight of this.fetches) {
            if (inFlight.begin <= from && range.end <= inFlight.end) {
                return;
            }
        }
        range.own.add(this.fetchRange(...this.window(from, range.end)));
    }

    /**
     * pdf.js is done with this download (the viewer closed) but the file is
     * still wanted, for the offline copy: drop pdf.js and the Range requests
     * it asked for, and let the stream run to the end.
     */
    release(): void {
        this.sink = null;
        this.pending = [];
        this.cancelFetches();
    }

    /** Stop every request (the document was closed). */
    abort(): void {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        this.streamAbort.abort();
        this.pending = [];
        this.cancelFetches();
        this.rejectComplete(new DOMException('Download aborted', 'AbortError'));
    }

    private cancelFetches(): void {
        for (const inFlight of this.fetches) {
            inFlight.controller.abort();
        }
        this.fetches.clear();
    }

    /** Whether [begin, end) is in the buffer: from the stream, a Range request, or both. */
    private has(begin: number, end: number): boolean {
        return this.missingFrom(begin, end) >= end;
    }

    /** The first byte of [begin, end) not in the buffer, or `end` if all of it is. */
    private missingFrom(begin: number, end: number): number {
        const from = Math.max(begin, this.loaded);
        // Spans never touch, so the byte after one is missing.
        return Math.min(this.spanAt(from)?.end ?? from, end);
    }

    private spanAt(position: number): Span | undefined {
        return this.fetched.find((span) => span.begin <= position && position < span.end);
    }

    /** What to fetch so that [begin, end) arrives, and what pdf.js will likely ask for next. */
    private window(begin: number, end: number): [number, number] {
        const known = [...this.fetched, ...this.fetches];
        const tail = Math.max(0, this.length - TAIL_FETCH);
        if (end > tail && !known.some((span) => span.end === this.length)) {
            return [Math.max(Math.min(begin, tail), this.loaded), this.length];
        }
        const previous = this.sizeEndingAt.get(begin) ?? 0;
        const size = Math.max(MIN_RANGE_FETCH, Math.min(2 * previous, MAX_RANGE_FETCH));
        let to = Math.max(end, Math.min(begin + size, this.length));
        // Not again what is here or on its way: stop where that starts, if
        // it brings the rest of what was asked for.
        for (const span of known) {
            if (span.begin > begin && span.begin < to && (span.begin >= end || span.end >= end)) {
                // If it is a request that then fails, the rest is asked for again (retryWaitingOn).
                to = span.begin;
            }
        }
        return [begin, to];
    }

    /** Send a Range request for [begin, end); what it brings answers the reads waiting on it. */
    private fetchRange(begin: number, end: number): RangeFetch {
        const inFlight: RangeFetch = { begin, end, controller: new AbortController(), failed: false };
        this.fetches.add(inFlight);
        this.sizeEndingAt.set(end, end - begin);
        void this.receive(inFlight);
        return inFlight;
    }

    private async receive(inFlight: RangeFetch): Promise<void> {
        const { begin, end } = inFlight;
        let failed = false;
        try {
            const response = await this.fetchImpl(this.url, {
                headers: { Range: `bytes=${begin}-${end - 1}` },
                signal: inFlight.controller.signal,
                priority: 'high',
            });
            if (response.status === 200) {
                // The server sent the whole file instead, and will for every
                // Range request: the stream already is bringing it.
                this.rangesIgnored = true;
                if (!warnedNoRange) {
                    warnedNoRange = true;
                    console.warn('Score host ignored a Range request (HTTP 200); waiting for the stream');
                }
                inFlight.controller.abort();
                return;
            }
            if (response.status !== 206) {
                // Refused this once (a 429, a 503): the stream brings these
                // bytes; the next range is asked for as usual.
                if (!warnedRangeFailed) {
                    warnedRangeFailed = true;
                    console.warn(`Score host refused a Range request (HTTP ${response.status}); trying the next`);
                }
                failed = true;
                inFlight.controller.abort();
                return;
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (this.aborted || !this.fetches.has(inFlight)) {
                return;
            }
            if (bytes.byteLength !== end - begin) {
                failed = true;
                return;
            }
            this.keep(begin, bytes);
            for (const range of [...this.pending]) {
                if (this.has(range.begin, range.end)) {
                    this.deliver(range);
                }
            }
        } catch {
            // Aborted (the stream got there, or the viewer closed), offline,
            // refused: the stream covers it, or fails itself.
            failed = !inFlight.controller.signal.aborted;
        } finally {
            this.fetches.delete(inFlight);
            inFlight.failed = failed;
            if (failed && !this.aborted) {
                this.retryWaitingOn(inFlight);
            }
        }
    }

    /**
     * A request failed. A read it was sent for waits for the stream, as any
     * read whose own request failed does. Reads that only waited on it for
     * some of their bytes get a request for what they still lack, rather
     * than wait for the whole file: pdf.js's first read, on the end-of-file
     * request sent before pdf.js asked, or a read whose own request was cut
     * short where this one started (`window`). At most MAX_RANGE_RETRIES
     * times each.
     */
    private retryWaitingOn(failed: RangeFetch): void {
        for (const range of [...this.pending]) {
            if (range.retries >= MAX_RANGE_RETRIES || [...range.own].some((own) => own.failed)) {
                continue;
            }
            const from = Math.max(range.begin, failed.begin);
            const to = Math.min(range.end, failed.end);
            if (from < to && this.missingFrom(from, to) < to) {
                range.retries++;
                this.dispatch(range);
            }
        }
    }

    /**
     * Store what a Range request brought, merging it with its neighbours.
     * Only the part the stream has not reached goes into the buffer, which
     * the stream later writes over: the finished file (the offline copy, the
     * export) is then the stream's bytes alone, one consistent version even
     * if the object was replaced while this request was on its way. What the
     * stream already wrote stays; `has` reads it from there.
     */
    private keep(begin: number, bytes: Uint8Array): void {
        if (this.loaded >= this.length) {
            // The buffer is the finished file now, and already holds these bytes.
            return;
        }
        const skip = Math.min(bytes.byteLength, Math.max(0, this.loaded - begin));
        this.buffer.set(bytes.subarray(skip), begin + skip);
        const merged: Span = { begin, end: begin + bytes.byteLength };
        const rest: Span[] = [];
        for (const span of this.fetched) {
            if (span.end < merged.begin || span.begin > merged.end) {
                rest.push(span);
            } else {
                merged.begin = Math.min(merged.begin, span.begin);
                merged.end = Math.max(merged.end, span.end);
            }
        }
        rest.push(merged);
        this.fetched = rest.sort((a, b) => a.begin - b.begin);
    }

    private deliver(range: PendingRange): void {
        if (range.done || this.aborted) {
            return;
        }
        range.done = true;
        this.pending = this.pending.filter((other) => other !== range);
        // The rest of a fetched span goes along (up to MAX_RANGE_FETCH), in
        // whole units: pdf.js reading on (the cross-reference table) then
        // needs no request at all.
        let end = range.end;
        const span = range.begin >= this.loaded ? this.spanAt(range.begin) : undefined;
        if (span && span.end > end) {
            const upTo = Math.min(span.end, range.begin + MAX_RANGE_FETCH);
            end = upTo === this.length ? upTo : Math.max(end, upTo - (upTo % PDF_RANGE_CHUNK));
        }
        this.sink?.onRange(range.begin, this.buffer.slice(range.begin, end));
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
                        this.deliver(range);
                    }
                }
                for (const inFlight of this.fetches) {
                    if (inFlight.end <= this.loaded) {
                        inFlight.controller.abort();
                        this.fetches.delete(inFlight);
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
