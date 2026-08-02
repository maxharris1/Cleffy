/**
 * Shared pdf.js document-open options.
 *
 * pdf.js 5.x needs an explicit `wasmUrl` (trailing slash) so auxiliary image
 * decoders (JBIG2, OpenJPEG, qcms) can load. IMSLP scans are often JBIG2 —
 * without this, pages render as blank white canvases.
 */
export const PDFJS_WASM_URL = '/pdfjs-wasm/';

export const pdfDocumentOptions = {
    wasmUrl: PDFJS_WASM_URL,
} as const;
