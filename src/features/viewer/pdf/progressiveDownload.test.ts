import { describe, expect, it, vi } from 'vitest';

import {
    MIN_RANGE_FETCH,
    PDF_RANGE_CHUNK,
    ProgressiveDownload,
    TAIL_FETCH,
    type DownloadSink,
} from '@/features/viewer/pdf/progressiveDownload';

const FILE = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);

/** The request made for the end of the file as soon as its length is known. */
const TAIL_RANGE = `bytes=${FILE.length - TAIL_FETCH}-${FILE.length - 1}`;

/** Where pdf.js unit `n` starts (it asks in whole units). */
const unit = (n: number) => n * PDF_RANGE_CHUNK;

/**
 * A storage host: the full GET is a stream the test feeds by hand (so it can
 * be held at any point); a Range GET answers 206 with the slice, or 200 with
 * the whole file when `honourRange` is off.
 */
const storage = ({ honourRange = true, contentLength = String(FILE.length) } = {}) => {
    let push: (chunk: Uint8Array) => void = () => undefined;
    let close: () => void = () => undefined;
    let fail: (err: unknown) => void = () => undefined;
    const ranges: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const range = new Headers(init?.headers).get('Range');
        if (range) {
            ranges.push(range);
            const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!;
            if (!honourRange) {
                return new Response(FILE.slice(), { status: 200 });
            }
            return new Response(FILE.slice(Number(from), Number(to) + 1), { status: 206 });
        }
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                push = (chunk) => controller.enqueue(chunk);
                close = () => controller.close();
                fail = (err) => controller.error(err);
            },
        });
        const headers = contentLength ? { 'Content-Length': contentLength } : undefined;
        return new Response(body, { status: 200, headers });
    });
    return {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ranges,
        /** Stream the file up to byte `end`, from wherever it got to. */
        streamTo: (() => {
            let at = 0;
            return (end: number) => {
                push(FILE.slice(at, end));
                at = end;
            };
        })(),
        close: () => close(),
        fail: (err: unknown) => fail(err),
    };
};

const recorder = () => {
    const progressive: number[] = [];
    const ranges: Array<{ begin: number; bytes: Uint8Array }> = [];
    const sink: DownloadSink = {
        onProgressive: (chunk) => progressive.push(chunk.byteLength),
        onRange: (begin, bytes) => ranges.push({ begin, bytes }),
    };
    return { sink, progressive, ranges };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const open = async (host: ReturnType<typeof storage>) => {
    const started = await ProgressiveDownload.start('https://storage.example/signed', host.fetchImpl);
    if (!(started instanceof ProgressiveDownload)) {
        throw new Error('expected a streamed download');
    }
    return started;
};

/** Open, attach, and let the request for the end of the file land. */
const openWithTail = async (host: ReturnType<typeof storage>) => {
    const download = await open(host);
    const out = recorder();
    download.attach(out.sink);
    await vi.waitFor(() => expect(host.ranges).toEqual([TAIL_RANGE]));
    await tick();
    return { download, out };
};

describe('ProgressiveDownload', () => {
    it('streams the file to pdf.js front to back and hands over the whole file at the end', async () => {
        const host = storage();
        const download = await open(host);
        expect(download.length).toBe(FILE.length);
        host.streamTo(1000);
        await tick();
        const out = recorder();
        // Attached late: what already arrived is replayed first.
        download.attach(out.sink);
        expect(out.progressive).toEqual([1000]);
        host.streamTo(FILE.length);
        host.close();
        const whole = new Uint8Array(await download.complete);
        expect(whole).toEqual(FILE);
        expect(out.progressive.reduce((a, b) => a + b, 0)).toBe(FILE.length);
        // The end of the file was asked for up front; nothing else was.
        expect(host.ranges).toEqual([TAIL_RANGE]);
    });

    it('fetches the end of the file before pdf.js asks, and answers its reads there without the network', async () => {
        const host = storage();
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);
        // Asked as soon as the length is known: pdf.js starts at the end.
        expect(host.ranges).toEqual([TAIL_RANGE]);

        // pdf.js's first read (the last unit): answered by the request
        // already on its way, not a second one.
        const last = Math.floor((FILE.length - 1) / PDF_RANGE_CHUNK);
        download.requestRange(unit(last), FILE.length);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(out.ranges[0]!.begin).toBe(unit(last));
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(unit(last)));

        // The cross-reference table, read on from where startxref points:
        // already here, and handed over up to the end of what was fetched,
        // so the next units cost pdf.js nothing either.
        const xref = Math.ceil((FILE.length - TAIL_FETCH) / PDF_RANGE_CHUNK) + 3;
        download.requestRange(unit(xref), unit(xref + 1));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(out.ranges[1]!.begin).toBe(unit(xref));
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(unit(xref)));
        expect(host.ranges).toEqual([TAIL_RANGE]);
        download.abort();
    });

    it('fetches a page dictionary far ahead of the stream in one small request, answered by the 206 alone', async () => {
        const host = storage();
        const { download, out } = await openWithTail(host);

        // One unit asked for; the next comes along, so a dictionary that runs
        // over the unit's end needs no second round trip.
        download.requestRange(unit(200), unit(201));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(host.ranges).toEqual([TAIL_RANGE, `bytes=${unit(200)}-${unit(200) + MIN_RANGE_FETCH - 1}`]);
        expect(out.ranges[0]!.begin).toBe(unit(200));
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(unit(200), unit(200) + MIN_RANGE_FETCH));

        download.requestRange(unit(201), unit(202));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(unit(201), unit(202)));
        expect(host.ranges).toHaveLength(2);
        download.abort();
    });

    it('asks once for units requested together that one request covers', async () => {
        const host = storage();
        const { download, out } = await openWithTail(host);

        download.requestRange(unit(300), unit(301));
        download.requestRange(unit(301), unit(302));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(host.ranges).toEqual([TAIL_RANGE, `bytes=${unit(300)}-${unit(302) - 1}`]);
        expect(out.ranges.map((r) => r.begin)).toEqual([unit(300), unit(301)]);
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(unit(301), unit(302)));
        download.abort();
    });

    it('fetches only the part of a read that the end-of-file request did not bring', async () => {
        const host = storage();
        const { download, out } = await openWithTail(host);
        const tail = FILE.length - TAIL_FETCH;

        download.requestRange(tail - 512, tail + 512);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(host.ranges).toEqual([TAIL_RANGE, `bytes=${tail - 512}-${tail - 1}`]);
        expect(out.ranges[0]!.bytes.subarray(0, 1024)).toEqual(FILE.slice(tail - 512, tail + 512));
        download.abort();
    });

    it('fetches more at a time while pdf.js reads on in sequence', async () => {
        const host = storage();
        const { download, out } = await openWithTail(host);

        let at = unit(250);
        const sizes: number[] = [];
        for (let i = 0; i < 4; i++) {
            download.requestRange(at, at + PDF_RANGE_CHUNK);
            await vi.waitFor(() => expect(out.ranges).toHaveLength(i + 1));
            const delivered = out.ranges[i]!;
            expect(delivered.bytes).toEqual(FILE.slice(at, at + delivered.bytes.byteLength));
            at += delivered.bytes.byteLength;
        }
        for (const range of host.ranges.slice(1)) {
            const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!;
            sizes.push(Number(to) + 1 - Number(from));
        }
        expect(sizes).toEqual([MIN_RANGE_FETCH, 2 * MIN_RANGE_FETCH, 4 * MIN_RANGE_FETCH, 8 * MIN_RANGE_FETCH]);
        download.abort();
    });

    it('leaves bytes just ahead of the stream to the stream', async () => {
        const host = storage();
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);
        host.streamTo(10_000);
        await tick();

        download.requestRange(12_288, 16_384);
        await tick();
        expect(host.ranges).toEqual([TAIL_RANGE]);
        expect(out.ranges).toEqual([]);

        host.streamTo(20_000);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(12_288, 16_384));

        // Already here: answered from the buffer, no request.
        download.requestRange(0, 4096);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(0, 4096));
        expect(host.ranges).toEqual([TAIL_RANGE]);
        download.abort();
    });

    it('once released, stops feeding pdf.js and drops its ranges, but still finishes the file', async () => {
        const host = storage();
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);
        host.streamTo(1000);
        await tick();
        download.requestRange(500, 600);
        download.requestRange(200_000, 204_096);

        download.release();
        await tick();
        host.streamTo(FILE.length);
        host.close();

        expect(new Uint8Array(await download.complete)).toEqual(FILE);
        // Nothing after the release: the range answered from the buffer was
        // still queued, and the stream's later chunks went nowhere.
        expect(out.progressive).toEqual([1000]);
        expect(out.ranges).toEqual([]);
    });

    it('waits for the stream, and stops asking, when the server ignores Range', async () => {
        const host = storage({ honourRange: false });
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);
        await vi.waitFor(() => expect(host.ranges).toEqual([TAIL_RANGE]));
        await tick();

        download.requestRange(FILE.length - 4096, FILE.length);
        download.requestRange(unit(200), unit(201));
        await tick();
        expect(out.ranges).toEqual([]);
        // The whole file again for every request would only compete with
        // the stream that is already bringing it.
        expect(host.ranges).toEqual([TAIL_RANGE]);

        host.streamTo(FILE.length);
        host.close();
        await download.complete;
        expect(out.ranges).toHaveLength(2);
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(FILE.length - 4096));
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(unit(200), unit(201)));
    });

    it('asks nothing up front for a file the stream brings in moments', async () => {
        const small = FILE.length - 200_000;
        const host = storage({ contentLength: String(small) });
        const download = await open(host);
        await tick();
        expect(host.ranges).toEqual([]);
        download.abort();
    });

    it('reads the whole file when the response says no length', async () => {
        const host = storage({ contentLength: '' });
        const started = ProgressiveDownload.start('https://storage.example/signed', host.fetchImpl);
        await tick();
        host.streamTo(FILE.length);
        host.close();
        const result = await started;
        expect(result).toBeInstanceOf(ArrayBuffer);
        expect(new Uint8Array(result as ArrayBuffer)).toEqual(FILE);
    });

    it('fails, rather than caching a short file, when the stream ends early or breaks', async () => {
        const short = storage();
        const a = await open(short);
        short.streamTo(5000);
        short.close();
        await expect(a.complete).rejects.toThrow(/ended early/);

        const broken = storage();
        const b = await open(broken);
        broken.streamTo(5000);
        broken.fail(new TypeError('network error'));
        await expect(b.complete).rejects.toThrow('network error');
    });

    it('refuses a non-OK response up front', async () => {
        const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
        await expect(ProgressiveDownload.start('https://storage.example/signed', fetchImpl)).rejects.toThrow(
            /HTTP 400/,
        );
    });
});
