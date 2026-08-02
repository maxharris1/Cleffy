import { create } from 'zustand';

import type { PinchPreview, StrokeWidthKey, Tool, ViewState } from '@/types/models';

/** Ink palette (StyleGuide equivalent): black, red, blue, green, yellow, orange, purple. */
export const STROKE_COLORS = ['#1f2937', '#dc2626', '#2563eb', '#16a34a', '#eab308', '#ea580c', '#9333ea'] as const;

/** Stroke widths as a fraction of page width (plan: all scalars / page width). */
export const STROKE_WIDTHS: Record<StrokeWidthKey, number> = {
    thin: 0.0025,
    medium: 0.005,
    thick: 0.01,
};

/** Eraser hit radius in CSS px at current zoom (wired to Size control). */
export const ERASER_RADIUS_CSS: Record<StrokeWidthKey, number> = {
    thin: 8,
    medium: 14,
    thick: 24,
};

/** Highlighter is a fat translucent pen. */
export const HIGHLIGHT_WIDTH_FACTOR = 3.5;

interface ViewerStore {
    view: ViewState;
    pinch: PinchPreview | null;
    tool: Tool;
    color: string;
    widthKey: StrokeWidthKey;
    /** 0-based page most centered in the viewport (for page share/export). */
    focusedPageIndex: number;
    /** Accessibility: let a finger draw (no Apple Pencil / stylus available). */
    fingerDraws: boolean;
    setView: (view: ViewState) => void;
    setPinch: (pinch: PinchPreview | null) => void;
    resetView: (view?: Partial<ViewState>) => void;
    setTool: (tool: Tool) => void;
    setColor: (color: string) => void;
    setWidthKey: (widthKey: StrokeWidthKey) => void;
    setFocusedPageIndex: (focusedPageIndex: number) => void;
    setFingerDraws: (fingerDraws: boolean) => void;
}

const INITIAL_VIEW: ViewState = { scale: 1, scrollX: 0, scrollY: 0 };

/**
 * Viewer UI state (zoom/pan, active tool, transient gesture preview).
 * Deliberately holds NO annotation data — annotations live in the
 * AnnotationStore's in-memory map (plan §sync). Usable outside React via
 * useViewerStore.getState() from high-frequency pointer handlers.
 */
export const useViewerStore = create<ViewerStore>((set) => ({
    view: INITIAL_VIEW,
    pinch: null,
    tool: 'pen',
    color: STROKE_COLORS[0],
    widthKey: 'medium',
    focusedPageIndex: 0,
    fingerDraws: false,
    setView: (view) => set({ view }),
    setPinch: (pinch) => set({ pinch }),
    resetView: (view) => set({ view: { ...INITIAL_VIEW, ...view }, pinch: null, focusedPageIndex: 0 }),
    setTool: (tool) => set({ tool }),
    setColor: (color) => set({ color }),
    setWidthKey: (widthKey) => set({ widthKey }),
    setFocusedPageIndex: (focusedPageIndex) => set({ focusedPageIndex }),
    setFingerDraws: (fingerDraws) => set({ fingerDraws }),
}));
