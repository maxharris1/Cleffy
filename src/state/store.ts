import { create } from 'zustand';

import type { PinchPreview, ViewState } from '@/types/models';

interface ViewerStore {
    view: ViewState;
    pinch: PinchPreview | null;
    setView: (view: ViewState) => void;
    setPinch: (pinch: PinchPreview | null) => void;
    resetView: (view?: Partial<ViewState>) => void;
}

const INITIAL_VIEW: ViewState = { scale: 1, scrollX: 0, scrollY: 0 };

/**
 * Viewer UI state (zoom/pan + transient gesture preview). Deliberately holds NO
 * annotation data — annotations live in the annotationStore's in-memory map
 * (see plan §sync). Usable outside React via useViewerStore.getState() from
 * high-frequency pointer handlers.
 */
export const useViewerStore = create<ViewerStore>((set) => ({
    view: INITIAL_VIEW,
    pinch: null,
    setView: (view) => set({ view }),
    setPinch: (pinch) => set({ pinch }),
    resetView: (view) => set({ view: { ...INITIAL_VIEW, ...view }, pinch: null }),
}));
