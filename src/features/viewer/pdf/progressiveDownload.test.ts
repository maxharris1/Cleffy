import { describe, expect, it, vi } from 'vitest';

import { ProgressiveDownload, type DownloadSink } from '@/features/viewer/pdf/progressiveDownload';

const FILE = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251);

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
        expect(host.ranges).toEqual([]);
    });

    it('fetches bytes far ahead of the stream with a Range request, answered by the 206 alone', async () => {
        const host = storage();
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);

        // The cross-reference table, at the end of the file.
        download.requestRange(FILE.length - 4096, FILE.length);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(host.ranges).toEqual([`bytes=${FILE.length - 4096}-${FILE.length - 1}`]);
        expect(out.ranges[0]!.begin).toBe(FILE.length - 4096);
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(FILE.length - 4096));
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
        expect(host.ranges).toEqual([]);
        expect(out.ranges).toEqual([]);

        host.streamTo(20_000);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(1));
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(12_288, 16_384));

        // Already here: answered from the buffer, no request.
        download.requestRange(0, 4096);
        await vi.waitFor(() => expect(out.ranges).toHaveLength(2));
        expect(out.ranges[1]!.bytes).toEqual(FILE.slice(0, 4096));
        expect(host.ranges).toEqual([]);
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

    it('waits for the stream when the server ignores Range', async () => {
        const host = storage({ honourRange: false });
        const download = await open(host);
        const out = recorder();
        download.attach(out.sink);

        download.requestRange(FILE.length - 4096, FILE.length);
        await vi.waitFor(() => expect(host.ranges).toHaveLength(1));
        await tick();
        expect(out.ranges).toEqual([]);

        host.streamTo(FILE.length);
        host.close();
        await download.complete;
        expect(out.ranges).toHaveLength(1);
        expect(out.ranges[0]!.bytes).toEqual(FILE.slice(FILE.length - 4096));
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
