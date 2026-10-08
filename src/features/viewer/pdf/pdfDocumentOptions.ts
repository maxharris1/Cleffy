import { PDFJS_ASSET_DIRS } from '@/features/viewer/pdf/pdfjsAssets';

/**
 * Shared pdf.js document-open options — every getDocument call spreads these.
 *
 * Data URLs (all same-origin, all with the trailing slash pdf.js requires; see
 * pdfjsAssets.ts for what each directory is for):
 * - wasmUrl: JBIG2 / OpenJPEG / qcms decoders. IMSLP scans are often JBIG2 —
 *   without this, pages render as blank white canvases.
 * - cMapUrl / standardFontDataUrl / iccUrl: non-embedded CID fonts, the 14
 *   standard fonts, and the CMYK profile.
 * - useWorkerFetch: true — the worker fetches those files itself. It is what
 *   pdf.js would decide anyway for same-origin http(s) URLs, but left unset it
 *   decides by probing each URL with URL.parse at getDocument time, which is
 *   one more place an older browser can fail before the first page (the
 *   polyfill in src/lib/polyfills.ts covers it too; this skips the probe).
 *
 * Hardening. Every PDF this app opens is untrusted input — uploaded by any user,
 * or fetched from IMSLP — and the viewer only ever paints pages to a canvas:
 * - enableXfa: false — never build XFA form HTML out of document data. It is
 *   pdf.js's default; spelled out so a future "render forms" change has to
 *   delete a line that says why it is there.
 * - Document JavaScript is never run: scripting is a viewer-layer option
 *   (`enableScripting` on the annotation layer / PDFScriptingManager), and
 *   Cleffy renders neither, nor loads pdf.sandbox. GHSA-hq66-cqwq-w95j needs
 *   scripting on; we do not rely on that alone — the pdf.js upgrade
 *   (>= 6.2.108) and the script-src CSP in vercel.json are the actual fixes.
 * - `isEvalSupported` no longer exists: current pdf.js draws glyphs without
 *   compiling `new Function` code, which is also why the CSP needs no
 *   'unsafe-eval' (only 'wasm-unsafe-eval' for the decoders above).
 */
export const PDFJS_WASM_URL = PDFJS_ASSET_DIRS.wasm.publicPath;

export const pdfDocumentOptions = {
    wasmUrl: PDFJS_WASM_URL,
    cMapUrl: PDFJS_ASSET_DIRS.cmaps.publicPath,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_ASSET_DIRS.standardFonts.publicPath,
    iccUrl: PDFJS_ASSET_DIRS.iccs.publicPath,
    enableXfa: false,
    useWorkerFetch: true,
} as const;
