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
 * the whole file when `honourRange` is off. `answer` may answer the n-th
 * Range request itself (0 is the end-of-file request sent on open).
 */
type RangeAnswer = (n: number, from: number, to: number) => Response | Promise<Response> | undefined;
const storage = ({
    honourRange = true,
    contentLength = String(FILE.length),
    answer,
}: { honourRange?: boolean; contentLength?: string; answer?: RangeAnswer } = {}) => {
    let push: (chunk: Uint8Array) => void = () => undefined;
    let close: () => void = () => undefined;
    let fail: (err: unknown) => void = () => undefined;
    const ranges: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const range = new Headers(init?.headers).get('Range');
        if (range) {
            ranges.push(range);
            const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!;
            const answered = answer?.(ranges.length - 1, Number(from), Number(to) + 1);
            if (answered) {
                return answered;
            }
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

    it('keeps asking for ranges after the host refuses one, and re-asks for a read that only waited on it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        // The end-of-file request, sent before pdf.js asks, is refused once.
        let refuse: (response: Response) => void = () => undefined;
        const host = storage({
            answer: (n) => (n === 0 ? new Promise<Response>((resolve) => (refuse = resolve)) : undefined),
        });
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);
        await vi.waitFor(() => expect(host.ranges).toEqual([TAIL_RANGE]));

        // pdf.js's first read waits on that request rather than sending its own.
        const last = Math.floor((FILE.length - 1) / PDF_RANGE_CHUNK);
        download.requestRange(unit(last), FILE.length);
        await tick();
        expect(host.ranges).toEqual([TAIL_RANGE]);

        refuse(new Response('busy', { status: 503 }));
        // The read it waited on now has its own request (for the end of the
        // file again, as pdf.js's own first read would), not the whole file's wait.
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(host.ranges).toEqual([TAIL_RANGE, TAIL_RANGE]);
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(unit(last)));

        // And a page dictionary later is still fetched by Range.
        download.requestRange(unit(200), unit(201));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(host.ranges[2]).toBe(`bytes=${unit(200)}-${unit(200) + MIN_RANGE_FETCH - 1}`);
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(unit(200), unit(200) + MIN_RANGE_FETCH));
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refused a Range request \(HTTP 503\)/));
        expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/ignored/));
        download.abort();
        warn.mockRestore();
    });

    it('leaves a read that a failed request was sent for to the stream, as before', async () => {
        const host = storage({ answer: (n) => (n === 1 ? new Response('busy', { status: 503 }) : undefined) });
        const { download, out } = await openWithTail(host);

        download.requestRange(unit(200), unit(201));
        await vi.waitFor(() => expect(host.ranges).toHaveLength(2));
        await tick();
        await tick();
        // Not asked for again (a host that keeps refusing would be asked forever).
        expect(host.ranges).toHaveLength(2);
        expect(out.ranges).toEqual([]);

        host.streamTo(unit(201));
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(unit(200), unit(201)));
        download.abort();
    });

    it('re-asks for the rest of a read whose own request stopped where a failed one started', async () => {
        // The request for the second read is held, then refused.
        let refuse: (response: Response) => void = () => undefined;
        const host = storage({
            answer: (n) => (n === 1 ? new Promise<Response>((resolve) => (refuse = resolve)) : undefined),
        });
        const { download, out } = await openWithTail(host);

        download.requestRange(unit(201), unit(202));
        await vi.waitFor(() => expect(host.ranges).toHaveLength(2));
        expect(host.ranges[1]).toBe(`bytes=${unit(201)}-${unit(201) + MIN_RANGE_FETCH - 1}`);
        // This read's own request stops where that one starts: it brings the rest.
        download.requestRange(unit(200), unit(202));
        await vi.waitFor(() => expect(host.ranges).toHaveLength(3));
        expect(host.ranges[2]).toBe(`bytes=${unit(200)}-${unit(201) - 1}`);
        await tick();
        expect(out.ranges).toEqual([]);

        refuse(new Response('busy', { status: 503 }));
        // Its own request succeeded, so the rest is asked for again rather
        // than left to the whole file's stream; that answers both reads.
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(host.ranges).toHaveLength(4);
        expect(host.ranges[3]).toMatch(new RegExp(`^bytes=${unit(201)}-`));
        const second = out.ranges.find((r) => r.begin === unit(200))!;
        expect(second.bytes.subarray(0, unit(2))).toEqual(FILE.slice(unit(200), unit(202)));
        const first = out.ranges.find((r) => r.begin === unit(201))!;
        expect(first.bytes.subarray(0, unit(1))).toEqual(FILE.slice(unit(201), unit(202)));
        download.abort();
    });

    it('re-asks a read a bounded number of times when the requests it waits on keep failing', async () => {
        // Every request after the end-of-file one is held until refused by hand.
        const refusals: Array<(response: Response) => void> = [];
        const host = storage({
            answer: (n) => (n === 0 ? undefined : new Promise<Response>((resolve) => refusals.push(resolve))),
        });
        const { download, out } = await openWithTail(host);
        const refuseNext = async () => {
            const count = host.ranges.length;
            refusals.shift()!(new Response('busy', { status: 503 }));
            await tick();
            await tick();
            return host.ranges.length - count;
        };

        // Four reads of the same unit: the first sends a request, the
        // others wait on it.
        download.requestRange(unit(400), unit(401));
        await vi.waitFor(() => expect(host.ranges).toHaveLength(2));
        for (let i = 0; i < 3; i++) {
            download.requestRange(unit(400), unit(401));
        }
        await tick();
        expect(host.ranges).toHaveLength(2);

        // Refused: the second read sends its own; the last two wait on it.
        expect(await refuseNext()).toBe(1);
        // Refused: the third sends its own; the last waits on it, asked twice now.
        expect(await refuseNext()).toBe(1);
        // Refused: the last is past MAX_RANGE_RETRIES and waits for the stream.
        expect(await refuseNext()).toBe(0);
        expect(out.ranges).toEqual([]);
        download.abort();
    });

    it('keeps the offline copy the stream alone, even when a Range reply lands behind it', async () => {
        // The object is replaced while the file streams: Range replies carry
        // the new version (all 0xEE here), the stream the old one.
        let landTail: () => void = () => undefined;
        const host = storage({
            answer: (_n, from, to) =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            landTail = () => {
                                controller.enqueue(new Uint8Array(to - from).fill(0xee));
                                controller.close();
                            };
                        },
                    }),
                    { status: 206 },
                ),
        });
        const download = await open(host);
        download.attach(recorder().sink);
        await vi.waitFor(() => expect(host.ranges).toEqual([TAIL_RANGE]));

        // The stream passes most of what the end-of-file request asked for,
        // then its body lands.
        host.streamTo(FILE.length - 1000);
        await tick();
        landTail();
        await tick();
        await tick();
        host.streamTo(FILE.length);
        host.close();

        const whole = new Uint8Array(await download.complete);
        // Where it first differs (-1: nowhere); a whole-array diff is unreadable.
        expect(whole.findIndex((byte, i) => byte !== FILE[i])).toBe(-1);
        expect(whole.byteLength).toBe(FILE.length);
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
