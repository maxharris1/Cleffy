/** Intrinsic size of a PDF page at pdf.js scale 1 (PDF points ≈ CSS px), after page rotation. */
export interface PageSize {
    width: number;
    height: number;
}

/** Committed viewer state. Scroll offsets are in scaled CSS px; scale multiplies base page units. */
export interface ViewState {
    scale: number;
    scrollX: number;
    scrollY: number;
}

/**
 * Transient pinch/zoom preview applied as a CSS transform while a gesture is in
 * flight; committed into ViewState (and re-rendered crisply) on gesture end.
 */
export interface PinchPreview {
    /** Gesture anchor in viewport CSS coordinates. */
    originX: number;
    originY: number;
    /** Scale factor relative to the committed scale. */
    factor: number;
}
