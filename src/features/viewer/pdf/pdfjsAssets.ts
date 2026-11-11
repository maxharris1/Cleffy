/**
 * The pdf.js data files the app serves from its own origin, and where.
 *
 * Shared by vite.config.ts (which serves them in dev and copies them into the
 * build) and pdfDocumentOptions.ts (which hands the URLs to getDocument), so a
 * renamed directory cannot leave the worker fetching a path nothing serves.
 * Same-origin on purpose: the Content-Security-Policy in vercel.json allows
 * `connect-src 'self'` and nothing CDN-shaped, and these are fetched by the
 * pdf.js worker.
 *
 * - wasm: JBIG2 / OpenJPEG / qcms decoders. IMSLP scans are very often JBIG2 —
 *   without these, pages render as blank white canvases.
 * - cmaps: predefined CMaps for CID-keyed (mostly CJK) fonts that are not
 *   embedded. Without them that text renders as nothing at all.
 * - standard_fonts: metrics + outlines for the 14 standard PDF fonts, used when
 *   a PDF names Times / Helvetica / Symbol without embedding it — common in older
 *   engravings' titles and tempo marks.
 * - iccs: the CMYK profile pdf.js uses to convert print-oriented scans.
 */
export interface PdfjsAssetDir {
    /** Directory under node_modules/pdfjs-dist. */
    source: string;
    /** Public URL prefix, with the trailing slash pdf.js requires. */
    publicPath: string;
    /** File names never copied or served from this directory. */
    exclude: readonly string[];
}

export const PDFJS_ASSET_DIRS = {
    wasm: {
        source: 'wasm',
        publicPath: '/pdfjs-wasm/',
        // The QuickJS interpreter behind pdf.js's document-JavaScript sandbox.
        // Cleffy never enables scripting (no annotation layer, no pdf.sandbox
        // import), so shipping it would only put an unused JavaScript engine on
        // our origin — and a document-JS sandbox is exactly the code path behind
        // GHSA-hq66-cqwq-w95j.
        exclude: ['quickjs-eval.js', 'quickjs-eval.wasm'],
    },
    cmaps: { source: 'cmaps', publicPath: '/pdfjs-cmaps/', exclude: [] },
    standardFonts: { source: 'standard_fonts', publicPath: '/pdfjs-standard-fonts/', exclude: [] },
    iccs: { source: 'iccs', publicPath: '/pdfjs-iccs/', exclude: [] },
} as const satisfies Record<string, PdfjsAssetDir>;
