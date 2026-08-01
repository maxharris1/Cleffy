/** Intrinsic size of a PDF page at pdf.js scale 1 (PDF points ≈ CSS px), after page rotation. */
export interface PageSize {
    width: number;
    height: number;
}

export type AnnotationKind = 'stroke' | 'highlight' | 'text';

/**
 * Ink payload. Coordinates are normalized 0–1 against the ROTATED page
 * viewport; ALL scalar sizes (`w`, text `size`) are normalized against the
 * page WIDTH — the same denominator as x (plan §data-model).
 */
export interface StrokePayload {
    /** Flat [x0, y0, p0, x1, y1, p1, …] triplets; p = pressure 0–1. */
    pts: number[];
    /** Base stroke width / page width. */
    w: number;
    /** 1 when pressure was simulated (mouse/finger input without real pressure). */
    sp?: 1;
}

export interface TextPayload {
    x: number;
    y: number;
    text: string;
    /** Font size / page width. */
    size: number;
}

export type AnnotationPayload = StrokePayload | TextPayload;

export interface Annotation {
    /** Client-generated UUID — also the server primary key. */
    id: string;
    docId: string;
    /** 0-based page index. */
    page: number;
    kind: AnnotationKind;
    color: string;
    payload: AnnotationPayload;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    /** Tombstone (soft delete only — required for offline sync + undo-restore). */
    deletedAt: string | null;
    /** Server-assigned monotonic sequence (sync watermark); 0 while local-only. */
    seq: number;
}

export const isTextPayload = (payload: AnnotationPayload): payload is TextPayload => {
    return 'text' in payload;
};

export type Tool = 'pan' | 'pen' | 'highlighter' | 'eraser' | 'text';

export type StrokeWidthKey = 'thin' | 'medium' | 'thick';

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
