import { getLocalDoc, putLocalDoc } from '@/lib/localDocs';

/** The demo's score: Für Elise, a US public-domain edition, served from public/demo. */
export const DEMO_PDF_URL = '/demo/fur-elise.pdf';

/**
 * Fixed rather than content-hashed (localDocId), so ink a visitor kept always
 * finds its score, and a non-UUID so isCloudDocId is false and the viewer
 * treats it as a local doc: no sync, nothing leaves the device.
 *
 * Bump the version suffix whenever the PDF changes. Ink is keyed by this id
 * and placed by page coordinates, so marks kept from an old edition would land
 * on the wrong bars of a new one.
 */
export const DEMO_DOC_ID = 'local-demo-v1';

export const DEMO_TITLE = 'Für Elise — demo';

/**
 * What is actually requested: the file, versioned by the doc id. The service
 * worker keeps the demo score CacheFirst (vite.config.ts), so the same URL
 * would serve an old edition forever; bumping DEMO_DOC_ID busts that cache
 * along with the ink.
 */
export const DEMO_PDF_REQUEST_URL = `${DEMO_PDF_URL}?v=${DEMO_DOC_ID}`;

/** `%PDF-`: every PDF opens with it. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

const isPdf = (bytes: ArrayBuffer): boolean => {
    const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PDF_MAGIC.length));
    return head.length === PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b);
};

/**
 * The server answered, but not with the score: a 404, or the SPA rewrite's
 * index.html. A deploy fault the visitor cannot fix, so the demo does not
 * tell them to check their connection (DemoPage).
 */
export class DemoScoreMissingError extends Error {
    override name = 'DemoScoreMissingError';
}

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
            throw new DemoScoreMissingError(`The demo score could not be fetched (HTTP ${response.status}).`);
        }
        const bytes = await response.arrayBuffer();
        if (!isPdf(bytes)) {
            throw new DemoScoreMissingError('The demo score is not a PDF.');
        }
        putLocalDoc(DEMO_DOC_ID, bytes);
        return bytes;
    })().finally(() => {
        inflight = null;
    });
    return inflight;
};
