import { create } from 'zustand';

import type { PageColumns } from '@/features/viewer/geometry';
import {
    readConcertDim,
    readPageColumns,
    readPrintHandwriting,
    readSpreadCover,
    writeConcertDim,
    writePageColumns,
    writePrintHandwriting,
    writeSpreadCover,
} from '@/features/viewer/viewerPrefs';
import { DEFAULT_LAYER_AUDIENCE, type LayerAudience } from '@/features/viewer/layerAudience';
import type { AnnotationLayer, PinchPreview, StrokeWidthKey, Tool, ViewState } from '@/types/models';

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

export type PlaybackStatus = 'idle' | 'loading' | 'counting' | 'playing' | 'paused' | 'ended';

/** Auto-follow: on (playhead drives scroll), suspended (user panned mid-play), off. */
export type FollowMode = 'on' | 'suspended' | 'off';

/** Inclusive measure-index range for the A-B practice loop. */
export interface LoopRange {
    a: number;
    b: number;
}

export const BPM_MIN = 40;
export const BPM_MAX = 240;
export const DEFAULT_BPM = 100;

interface PlaybackSlice {
    playbackStatus: PlaybackStatus;
    bpm: number;
    /** Index into ScoreData.measures (not the printed number), null before playback. */
    currentMeasureIndex: number | null;
    muteRH: boolean;
    muteLH: boolean;
    /** Per-hand volume 0–1 (independent of mute). */
    volRH: number;
    volLH: number;
    metronomeOn: boolean;
    countInOn: boolean;
    loopRange: LoopRange | null;
    followMode: FollowMode;
    setPlaybackStatus: (playbackStatus: PlaybackStatus) => void;
    setBpm: (bpm: number) => void;
    setCurrentMeasureIndex: (currentMeasureIndex: number | null) => void;
    setHandMuted: (hand: 0 | 1, muted: boolean) => void;
    setHandVolume: (hand: 0 | 1, volume: number) => void;
    setMetronomeOn: (metronomeOn: boolean) => void;
    setCountInOn: (countInOn: boolean) => void;
    setLoopRange: (loopRange: LoopRange | null) => void;
    setFollowMode: (followMode: FollowMode) => void;
    /** Back to defaults when the viewer switches documents. */
    resetPlayback: () => void;
}

interface ViewerStore extends PlaybackSlice {
    view: ViewState;
    pinch: PinchPreview | null;
    tool: Tool;
    color: string;
    widthKey: StrokeWidthKey;
    /** 0-based page most centered in the viewport (for page share/export). */
    focusedPageIndex: number;
    /** Accessibility: let a finger draw (no Apple Pencil / stylus available). */
    fingerDraws: boolean;
    /**
     * Opt-in: convert this writer's committed pen strokes to print (digits,
     * dynamics, text notes). Per-user viewer setting, persisted per device —
     * never a document flag, so a teacher cannot rewrite a pupil's handwriting.
     */
    printHandwriting: boolean;
    /** Reading vs markup. A score opens in reading; Annotate reveals the ink tools. */
    markupMode: boolean;
    /** While reading, hide invite, history, and presence. One toggle. */
    concertDim: boolean;
    /** Stamped onto new strokes, text, print, and hairpins. */
    markLayer: AnnotationLayer;
    /** Who is looking, so paint and sync can apply the layer rule. */
    layerAudience: LayerAudience;
    /** Owner's share-student-layer control. Null until a cloud score is open. */
    shareStudentLayerToggle: ((shared: boolean) => void) | null;
    /** Pages per row: 1 (stack) or 2 (facing pages). Persisted per device. */
    pageColumns: PageColumns;
    /** Two-page spreads open on a cover: page 1 alone, then 2|3. Persisted per device. */
    spreadCover: boolean;
    setView: (view: ViewState) => void;
    setPinch: (pinch: PinchPreview | null) => void;
    resetView: (view?: Partial<ViewState>) => void;
    setTool: (tool: Tool) => void;
    setColor: (color: string) => void;
    setWidthKey: (widthKey: StrokeWidthKey) => void;
    setFocusedPageIndex: (focusedPageIndex: number) => void;
    setFingerDraws: (fingerDraws: boolean) => void;
    setPrintHandwriting: (printHandwriting: boolean) => void;
    setMarkupMode: (markupMode: boolean) => void;
    setConcertDim: (concertDim: boolean) => void;
    setMarkLayer: (markLayer: AnnotationLayer) => void;
    setShareStudentLayerToggle: (shareStudentLayerToggle: ((shared: boolean) => void) | null) => void;
    setPageColumns: (pageColumns: PageColumns) => void;
    setSpreadCover: (spreadCover: boolean) => void;
    /** Text note selected with the text tool, or null. Not annotation data — chrome only. */
    selectedTextId: string | null;
    setSelectedTextId: (selectedTextId: string | null) => void;
}

const INITIAL_VIEW: ViewState = { scale: 1, scrollX: 0, scrollY: 0 };

const INITIAL_PLAYBACK = {
    playbackStatus: 'idle',
    bpm: DEFAULT_BPM,
    currentMeasureIndex: null,
    muteRH: false,
    muteLH: false,
    volRH: 1,
    volLH: 1,
    metronomeOn: false,
    countInOn: true,
    loopRange: null,
    followMode: 'on',
} satisfies Partial<ViewerStore>;

/**
 * Viewer UI state (zoom/pan, active tool, transient gesture preview).
 * Deliberately holds NO annotation data — annotations live in the
 * AnnotationStore's in-memory map (plan §sync). Usable outside React via
 * useViewerStore.getState() from high-frequency pointer handlers.
 */
export const useViewerStore = create<ViewerStore>((set, get) => ({
    view: INITIAL_VIEW,
    pinch: null,
    tool: 'pan',
    color: STROKE_COLORS[0],
    widthKey: 'medium',
    focusedPageIndex: 0,
    fingerDraws: false,
    printHandwriting: readPrintHandwriting(),
    markupMode: false,
    concertDim: readConcertDim(),
    markLayer: 'teacher',
    layerAudience: DEFAULT_LAYER_AUDIENCE,
    shareStudentLayerToggle: null,
    pageColumns: readPageColumns(),
    spreadCover: readSpreadCover(),
    setView: (view) => set({ view }),
    setPinch: (pinch) => set({ pinch }),
    resetView: (view) => set({ view: { ...INITIAL_VIEW, ...view }, pinch: null, focusedPageIndex: 0 }),
    setTool: (tool) => set({ tool }),
    setColor: (color) => set({ color }),
    setWidthKey: (widthKey) => set({ widthKey }),
    setFocusedPageIndex: (focusedPageIndex) => set({ focusedPageIndex }),
    setFingerDraws: (fingerDraws) => set({ fingerDraws }),
    setPrintHandwriting: (printHandwriting) => {
        writePrintHandwriting(printHandwriting);
        set({ printHandwriting });
    },
    setMarkupMode: (markupMode) => set({ markupMode }),
    setConcertDim: (concertDim) => {
        writeConcertDim(concertDim);
        set({ concertDim });
    },
    setMarkLayer: (markLayer) => {
        const { layerAudience } = get();
        set({ markLayer: markLayer === 'teacher' && !layerAudience.canUseTeacherLayer ? 'student' : markLayer });
    },
    setShareStudentLayerToggle: (shareStudentLayerToggle) => set({ shareStudentLayerToggle }),
    setPageColumns: (pageColumns) => {
        writePageColumns(pageColumns);
        set({ pageColumns });
    },
    setSpreadCover: (spreadCover) => {
        writeSpreadCover(spreadCover);
        set({ spreadCover });
    },
    selectedTextId: null,
    setSelectedTextId: (selectedTextId) => set({ selectedTextId }),
    ...INITIAL_PLAYBACK,
    setPlaybackStatus: (playbackStatus) => set({ playbackStatus }),
    setBpm: (bpm) => set({ bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm))) }),
    setCurrentMeasureIndex: (currentMeasureIndex) => set({ currentMeasureIndex }),
    setHandMuted: (hand, muted) => set(hand === 0 ? { muteRH: muted } : { muteLH: muted }),
    setHandVolume: (hand, volume) => {
        const clamped = Math.min(1, Math.max(0, volume));
        set(hand === 0 ? { volRH: clamped } : { volLH: clamped });
    },
    setMetronomeOn: (metronomeOn) => set({ metronomeOn }),
    setCountInOn: (countInOn) => set({ countInOn }),
    setLoopRange: (loopRange) => set({ loopRange }),
    setFollowMode: (followMode) => set({ followMode }),
    resetPlayback: () => set({ ...INITIAL_PLAYBACK }),
}));
