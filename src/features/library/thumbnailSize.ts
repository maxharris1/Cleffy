/**
 * Longest side of a library thumbnail, in device-independent pixels.
 *
 * This lives in its own module rather than beside the renderer that uses it,
 * because thumbnailService needs the number to decide whether a cached render
 * is too small — and thumbnailRender statically imports pdf.js, so a static
 * import from the service would pull the ~1 MB pdf chunk into the shell bundle
 * and undo the dynamic-import boundary that module documents.
 *
 * 512 is sized for a ~208px-wide shelf cover on a 2x display. Raising it again
 * invalidates every cached render (see `CachedThumbnail.maxSide`), which is
 * exactly what should happen.
 */
export const THUMB_MAX_SIDE = 512;
