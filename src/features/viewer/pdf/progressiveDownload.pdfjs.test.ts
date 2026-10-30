// @vitest-environment node
/**
 * ProgressiveDownload driving real pdf.js (the legacy build, run in-thread),
 * wired as PdfProvider wires them: what it hands over must be what pdf.js
 * accepts (whole units, at the offset it asked for), and opening a score must
 * cost one small request per page dictionary the stream has not reached, plus
 * one for the end of the file.
 */
// Sets globalThis.pdfjsWorker, with which pdf.js runs its worker code on this thread.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    MIN_RANGE_FETCH,
    PDF_RANGE_CHUNK,
    ProgressiveDownload,
    TAIL_FETCH,
} from '@/features/viewer/pdf/progressiveDownload';

const PAGES = 40;

/**
 * A score laid out like a scan: catalog and a flat page tree up front, then
 * per page its dictionary and its content (padded as an image would be), and
 * the cross-reference table at the end. Page `n` is `n * 10` points wider.
 */
const makePdf = (): Uint8Array => {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    let size = 0;
    const offsets: number[] = [];
    const write = (text: string) => {
        const bytes = enc.encode(text);
        parts.push(bytes);
        size += bytes.byteLength;
    };
    const object = (n: number, body: string) => {
        offsets[n] = size;
        write(`${n} 0 obj\n${body}\nendobj\n`);
    };
    write('%PDF-1.7\n');
    const kids = Array.from({ length: PAGES }, (_, p) => `${3 + 2 * p} 0 R`).join(' ');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, `<< /Type /Pages /Count ${PAGES} /Kids [${kids}] >>`);
    for (let p = 0; p < PAGES; p++) {
        const content = `0 0 m 100 100 l S\n%${'x'.repeat(7000 + p)}\n`;
        object(
            3 + 2 * p,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${600 + p * 10} 800] /Contents ${4 + 2 * p} 0 R >>`,
        );
        object(4 + 2 * p, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    const count = 3 + 2 * PAGES;
    const xref = size;
    write(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) {
        write(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    }
    write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const file = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        file.set(part, at);
        at += part.byteLength;
    }
    return file;
};

const FILE = makePdf();

/**
 * Storage: Range GETs answered 206; the full GET streams 2 KiB every few
 * milliseconds (a slow link, next to requests answered at once), or is held.
 */
const storage = () => {
    let push: (chunk: Uint8Array) => void = () => undefined;
    let close: () => void = () => undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ranges: Array<[number, number]> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const range = new Headers(init?.headers).get('Range');
        if (range) {
            const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!;
            ranges.push([Number(from), Number(to) + 1]);
            return new Response(FILE.slice(Number(from), Number(to) + 1), { status: 206 });
        }
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                push = (chunk) => controller.enqueue(chunk);
                close = () => controller.close();
            },
        });
        return new Response(body, { status: 200, headers: { 'Content-Length': String(FILE.length) } });
    });
    let at = 0;
    return {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ranges,
        trickle: () => {
            timer = setInterval(() => {
                push(FILE.slice(at, at + 2048));
                at += 2048;
                if (at >= FILE.length) {
                    clearInterval(timer);
                    close();
                }
            }, 3);
        },
        stop: () => clearInterval(timer),
    };
};

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
    await Promise.all(cleanup.map((fn) => fn()));
    cleanup = [];
});

const start = async (host: ReturnType<typeof storage>) => {
    const download = await ProgressiveDownload.start('https://storage.example/s', host.fetchImpl);
    if (!(download instanceof ProgressiveDownload)) {
        throw new Error('expected a streamed download');
    }
    cleanup.push(
        () => host.stop(),
        () => download.abort(),
    );
    return download;
};

/** What PdfProvider does: a transport over the download, and getDocument on it. */
const openWithPdfjs = async (download: ProgressiveDownload) => {
    class Transport extends pdfjs.PDFDataRangeTransport {
        constructor() {
            super(download.length, null);
            download.attach({
                onProgressive: (chunk) => this.onDataProgressiveRead(chunk),
                onRange: (begin, chunk) => this.onDataRange(begin, chunk),
            });
        }
        override requestDataRange(begin: number, end: number): void {
            download.requestRange(begin, end);
        }
    }
    const task = pdfjs.getDocument({ range: new Transport(), rangeChunkSize: PDF_RANGE_CHUNK, verbosity: 0 });
    cleanup.push(() => task.destroy());
    return task.promise;
};

describe('ProgressiveDownload under pdf.js', () => {
    it('opens a flat-tree score with one small request per page dictionary ahead of the stream, and one for the end', async () => {
        expect(FILE.length).toBeGreaterThan(4 * TAIL_FETCH);
        const host = storage();
        const download = await start(host);
        host.trickle();

        const doc = await openWithPdfjs(download);
        expect(doc.numPages).toBe(PAGES);
        const last = await doc.getPage(PAGES);
        expect(last.getViewport({ scale: 1 }).width).toBe(600 + (PAGES - 1) * 10);

        const [tail, ...rest] = host.ranges;
        // The end of the file: asked for once, before pdf.js did.
        expect(tail).toEqual([FILE.length - TAIL_FETCH, FILE.length]);
        expect(rest.filter(([, end]) => end > FILE.length - TAIL_FETCH)).toEqual([]);
        // The page dictionaries: small requests, none twice.
        expect(rest.length).toBeGreaterThan(PAGES / 4);
        expect(rest.length).toBeLessThanOrEqual(PAGES);
        expect(rest.every(([from, to]) => to - from <= MIN_RANGE_FETCH)).toBe(true);
        expect(new Set(rest.map(([from]) => from)).size).toBe(rest.length);
    });

    it('draws a page from what the requests and the stream brought, and hands over the whole file', async () => {
        const host = storage();
        const download = await start(host);
        host.trickle();
        const doc = await openWithPdfjs(download);

        // A page deep in the file: its content stream comes by Range.
        const page = await doc.getPage(PAGES - 2);
        const ops = await page.getOperatorList();
        expect(ops.fnArray.length).toBeGreaterThan(0);

        expect(new Uint8Array(await download.complete)).toEqual(FILE);
    });
});
