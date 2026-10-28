import { DEMO_DOC_ID, DEMO_PDF_REQUEST_URL } from '@/features/demo/demoScore';
import { getLocalDoc, putLocalDoc } from '@/lib/localDocs';

/**
 * The score itself is missing or wrong (an HTTP error, or not a PDF): a fault
 * of the deploy, not of the visitor's connection. A network failure rejects
 * with fetch's own TypeError instead.
 */
export class DemoScoreUnavailableError extends Error {
    override name = 'DemoScoreUnavailableError';
}

/** `%PDF-`: every PDF opens with it. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

const isPdf = (bytes: ArrayBuffer): boolean => {
    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PDF_MAGIC.length));
    return head.length === PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b);
};

/** One download however many callers ask at once (a StrictMode remount, a quick Try again). */
let inflight: Promise<ArrayBuffer> | null = null;

/**
 * The demo PDF's bytes, registered in the in-memory local-doc registry under
 * DEMO_DOC_ID. Skips the download when the registry already has them — a
 * return to /try within the same page load.
 *
 * The bytes are checked, not only the status: vercel.json rewrites every path
 * to index.html, so a missing file comes back as a 200 of HTML, which pdf.js
 * would report as a broken score rather than the demo's own error state.
 */
export const loadDemoScore = (): Promise<ArrayBuffer> => {
    const cached = getLocalDoc(DEMO_DOC_ID);
    if (cached) {
        return Promise.resolve(cached);
    }
    inflight ??= (async () => {
        const response = await fetch(DEMO_PDF_REQUEST_URL);
        if (!response.ok) {
            throw new DemoScoreUnavailableError(`The demo score could not be fetched (HTTP ${response.status}).`);
        }
        const bytes = await response.arrayBuffer();
        if (!isPdf(bytes)) {
            throw new DemoScoreUnavailableError('The demo score is not a PDF.');
        }
        putLocalDoc(DEMO_DOC_ID, bytes);
        return bytes;
    })().finally(() => {
        inflight = null;
    });
    return inflight;
};
