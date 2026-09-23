import { useSyncExternalStore, type ReactNode } from 'react';

import { warmPrintPipeline } from '@/features/viewer/ink/handwriting/warmup';
import { ignoresProseFont, SERIF_FONT_FAMILY, styledTextPayload, textDrawSpec } from '@/features/viewer/ink/musicFont';
import type { AnnotationStore } from '@/sync/annotationStore';
import { STROKE_COLORS, useViewerStore } from '@/state/store';
import { isTextPayload, type Annotation, type StrokeWidthKey, type TextFont, type Tool } from '@/types/models';
import { PointerIcon, RedoIcon, UndoIcon } from '@/ui/icons';

const TOOLS: Array<{ tool: Tool; label: string; short: string; icon: ReactNode }> = [
    { tool: 'pen', label: 'Pen', short: 'Pen', icon: <PenIcon /> },
    { tool: 'highlighter', label: 'Highlighter', short: 'Mark', icon: <HighlighterIcon /> },
    { tool: 'eraser', label: 'Eraser', short: 'Erase', icon: <EraserIcon /> },
    { tool: 'hairpin', label: 'Hairpin — drag a crescendo or diminuendo', short: 'Hairpin', icon: <HairpinIcon /> },
    { tool: 'text', label: 'Text note', short: 'Text', icon: <TextIcon /> },
    { tool: 'fingering', label: 'Fingering — drag over a chord or phrase', short: 'Hands', icon: <FingeringIcon /> },
];

const WIDTHS: Array<{ key: StrokeWidthKey; label: string; preview: number }> = [
    { key: 'thin', label: 'Thin', preview: 2 },
    { key: 'medium', label: 'Medium', preview: 4 },
    { key: 'thick', label: 'Thick', preview: 7 },
];

export interface ToolbarProps {
    store: AnnotationStore;
}

/** The text note the text tool has selected, or null. */
const useSelectedText = (store: AnnotationStore): Annotation | null => {
    const selectedTextId = useViewerStore((s) => s.selectedTextId);
    const tool = useViewerStore((s) => s.tool);
    return useSyncExternalStore(
        (cb) => store.subscribe(() => cb()),
        () => {
            if (tool !== 'text' || !selectedTextId) {
                return null;
            }
            const annotation = store.get(selectedTextId);
            if (!annotation || annotation.deletedAt || !isTextPayload(annotation.payload)) {
                return null;
            }
            return annotation;
        },
    );
};

/**
 * Floating tool palette. Desktop: top-center. Phones: bottom (thumb-reachable),
 * above the safe area. Hidden entirely for view-only roles (M3).
 */
export const Toolbar = ({ store }: ToolbarProps) => {
    const tool = useViewerStore((s) => s.tool);
    const color = useViewerStore((s) => s.color);
    const widthKey = useViewerStore((s) => s.widthKey);
    const fingerDraws = useViewerStore((s) => s.fingerDraws);
    const printHandwriting = useViewerStore((s) => s.printHandwriting);
    const markupMode = useViewerStore((s) => s.markupMode);
    const concertDim = useViewerStore((s) => s.concertDim);
    const markLayer = useViewerStore((s) => s.markLayer);
    const layerAudience = useViewerStore((s) => s.layerAudience);
    const shareStudentLayerToggle = useViewerStore((s) => s.shareStudentLayerToggle);
    const {
        setTool,
        setColor,
        setWidthKey,
        setFingerDraws,
        setPrintHandwriting,
        setMarkupMode,
        setConcertDim,
        setMarkLayer,
    } = useViewerStore.getState();

    const undoState = useSyncExternalStore(
        (cb) => store.subscribeMeta(cb),
        () => `${store.canUndo}|${store.canRedo}`,
    );
    const [canUndo, canRedo] = undoState.split('|').map((v) => v === 'true');

    const selectedText = useSelectedText(store);
    const selectedPayload = selectedText && isTextPayload(selectedText.payload) ? selectedText.payload : null;
    const musicFace = selectedPayload !== null && ignoresProseFont(selectedPayload);
    const showType = markupMode && printHandwriting && selectedPayload !== null;
    const face: TextFont = selectedPayload?.font === 'serif' ? 'serif' : 'sans';
    const boldOn = selectedPayload?.bold === 1;
    const italicOn =
        selectedPayload !== null &&
        textDrawSpec(selectedPayload.text, selectedPayload.hw === 1, selectedPayload).style === 'italic';

    const applyStyle = (patch: { font?: TextFont; bold?: boolean; italic?: boolean }) => {
        if (!selectedText || !selectedPayload) {
            return;
        }
        const next = styledTextPayload(selectedPayload, patch);
        if (next !== selectedPayload) {
            void store.update(selectedText.id, { payload: next });
        }
    };

    const layerWord = markLayer === 'teacher' ? 'Teacher' : 'Student';
    const showColors = tool === 'pen' || tool === 'highlighter' || tool === 'text' || tool === 'hairpin';
    const showSize = tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'hairpin';
    const sizeCaption =
        tool === 'eraser'
            ? 'Eraser size'
            : tool === 'highlighter'
              ? 'Marker size'
              : tool === 'hairpin'
                ? 'Hairpin spread'
                : 'Pen size';

    if (!markupMode) {
        return (
            <div
                data-ui-overlay
                className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:bottom-auto sm:top-3"
            >
                <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] flex-wrap items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
                    <button
                        type="button"
                        title="Annotate — pen, text, and hairpins"
                        aria-label="Annotate"
                        onClick={() => {
                            setMarkupMode(true);
                            if (useViewerStore.getState().tool === 'pan') {
                                setTool('pen');
                            }
                        }}
                        className="flex h-10 items-center justify-center rounded-xl px-3 text-sm font-medium text-stone-700 transition hover:bg-ink/5"
                    >
                        Annotate
                    </button>
                    <button
                        type="button"
                        title="Concert dim — hide share, history, and who's here"
                        aria-label="Concert dim"
                        aria-pressed={concertDim}
                        onClick={() => setConcertDim(!concertDim)}
                        className={`flex h-10 items-center justify-center rounded-xl px-3 text-sm font-medium transition ${
                            concertDim ? 'bg-accent-soft text-accent' : 'text-stone-700 hover:bg-ink/5'
                        }`}
                    >
                        Dim
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:bottom-auto sm:top-3"
        >
            <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] flex-wrap items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
                <button
                    type="button"
                    title="Done — back to reading"
                    aria-label="Done"
                    onClick={() => {
                        setMarkupMode(false);
                        setTool('pan');
                    }}
                    className="flex h-10 items-center justify-center rounded-xl px-3 text-sm font-medium text-accent transition hover:bg-accent-soft"
                >
                    Done
                </button>
                {TOOLS.map(({ tool: t, label, short, icon }) => (
                    <button
                        key={t}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={tool === t}
                        onClick={() => setTool(t)}
                        className={`flex h-10 items-center justify-center gap-1 rounded-xl px-2 text-stone-600 transition sm:min-w-[3.25rem] sm:flex-col sm:gap-0 sm:px-1.5 sm:py-1 ${
                            tool === t ? 'bg-accent-soft text-accent' : 'hover:bg-ink/5'
                        }`}
                    >
                        <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
                        <span className="hidden text-[10px] font-medium leading-none sm:block">{short}</span>
                    </button>
                ))}

                {showColors ? (
                    <>
                        <div className="mx-1 h-6 w-px bg-stone-200" />
                        {tool === 'highlighter' ? (
                            <span className="hidden px-1 text-[10px] font-medium uppercase tracking-wide text-amber-700 sm:inline">
                                Marker
                            </span>
                        ) : null}
                        {STROKE_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                aria-label={`Color ${c}`}
                                aria-pressed={color === c}
                                onClick={() => setColor(c)}
                                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                                    color === c ? 'ring-2 ring-accent ring-offset-1' : ''
                                }`}
                            >
                                <span
                                    className={`h-5 w-5 rounded-full ${tool === 'highlighter' ? 'opacity-55' : ''}`}
                                    style={{ backgroundColor: c }}
                                />
                            </button>
                        ))}
                    </>
                ) : null}

                {showSize ? (
                    <>
                        <div className="mx-1 h-6 w-px bg-stone-200" />
                        <span className="hidden px-1 text-[10px] font-medium uppercase tracking-wide text-stone-500 sm:inline">
                            {sizeCaption}
                        </span>
                        {WIDTHS.map(({ key, label, preview }) => (
                            <button
                                key={key}
                                type="button"
                                title={`${sizeCaption}: ${label}`}
                                aria-label={`${sizeCaption} ${label}`}
                                aria-pressed={widthKey === key}
                                onClick={() => setWidthKey(key)}
                                className={`flex h-8 w-8 items-center justify-center rounded-xl transition ${
                                    widthKey === key ? 'bg-accent-soft' : 'hover:bg-ink/5'
                                }`}
                            >
                                <span
                                    className={`rounded-full ${tool === 'highlighter' ? 'bg-amber-400/70' : 'bg-stone-700'} ${
                                        tool === 'eraser' ? 'border-2 border-stone-500 bg-transparent' : ''
                                    }`}
                                    style={{ width: preview, height: preview }}
                                />
                            </button>
                        ))}
                    </>
                ) : null}

                <div className="mx-1 h-6 w-px bg-stone-200" />
                <button
                    type="button"
                    title="Undo"
                    aria-label="Undo"
                    disabled={!canUndo}
                    onClick={() => void store.undoLast()}
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-600 transition hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                    <UndoIcon size={20} />
                </button>
                <button
                    type="button"
                    title="Redo"
                    aria-label="Redo"
                    disabled={!canRedo}
                    onClick={() => void store.redoLast()}
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-600 transition hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                    <RedoIcon size={20} />
                </button>
                <button
                    type="button"
                    title={fingerDraws ? 'Finger drawing on — a finger draws ink' : 'Finger drawing off — a finger pans'}
                    aria-label="Draw with finger"
                    aria-pressed={fingerDraws}
                    onClick={() => setFingerDraws(!fingerDraws)}
                    className={`flex h-10 items-center justify-center gap-1 rounded-xl px-2 text-stone-600 transition sm:min-w-[3.25rem] sm:flex-col sm:gap-0 sm:px-1.5 sm:py-1 ${
                        fingerDraws ? 'bg-accent-soft text-accent' : 'hover:bg-ink/5'
                    }`}
                >
                    <span className="flex h-5 w-5 items-center justify-center">
                        <PointerIcon size={20} />
                    </span>
                    <span className="hidden text-[10px] font-medium leading-none sm:block">Finger</span>
                </button>

                {showType && selectedPayload ? (
                    <>
                        <div className="mx-1 h-6 w-px bg-stone-200" />
                        {(['sans', 'serif'] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                title={
                                    musicFace
                                        ? 'Music symbols stay on the music font'
                                        : option === 'serif'
                                          ? 'Serif'
                                          : 'Sans'
                                }
                                aria-label={option === 'serif' ? 'Font Serif' : 'Font Sans'}
                                aria-pressed={face === option}
                                disabled={musicFace}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => applyStyle({ font: option })}
                                style={option === 'serif' ? { fontFamily: SERIF_FONT_FAMILY } : undefined}
                                className={`flex h-8 items-center justify-center rounded-xl px-2 text-xs transition disabled:opacity-40 ${
                                    face === option ? 'bg-accent-soft text-accent' : 'text-stone-700 hover:bg-ink/5'
                                }`}
                            >
                                {option === 'serif' ? 'Serif' : 'Sans'}
                            </button>
                        ))}
                        <button
                            type="button"
                            title={musicFace ? 'Music symbols stay on the music font' : 'Bold'}
                            aria-label="Bold"
                            aria-pressed={boldOn}
                            disabled={musicFace}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyStyle({ bold: !boldOn })}
                            className={`flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold transition disabled:opacity-40 ${
                                boldOn ? 'bg-accent-soft text-accent' : 'text-stone-700 hover:bg-ink/5'
                            }`}
                        >
                            B
                        </button>
                        <button
                            type="button"
                            title={musicFace ? 'Music symbols stay on the music font' : 'Italic'}
                            aria-label="Italic"
                            aria-pressed={italicOn}
                            disabled={musicFace}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applyStyle({ italic: !italicOn })}
                            className={`flex h-8 w-8 items-center justify-center rounded-xl text-sm italic transition disabled:opacity-40 ${
                                italicOn ? 'bg-accent-soft text-accent' : 'text-stone-700 hover:bg-ink/5'
                            }`}
                        >
                            I
                        </button>
                    </>
                ) : null}

                <div
                    className="ml-1 inline-flex h-8 items-stretch overflow-hidden rounded-full border border-stone-200 bg-stone-50 text-xs text-stone-700"
                    role="group"
                    aria-label="Mark layer"
                >
                    <button
                        type="button"
                        title={
                            layerAudience.canUseTeacherLayer
                                ? `Marking on the ${layerWord.toLowerCase()} layer`
                                : 'Students mark on their own layer'
                        }
                        aria-label={markLayer === 'teacher' ? 'Teacher layer' : 'Student layer'}
                        disabled={!layerAudience.canUseTeacherLayer}
                        onClick={() => setMarkLayer(markLayer === 'teacher' ? 'student' : 'teacher')}
                        className="px-2.5 font-medium transition hover:bg-ink/5 disabled:hover:bg-transparent"
                    >
                        {layerWord}
                    </button>
                    {layerAudience.canShareStudentLayer && shareStudentLayerToggle ? (
                        <button
                            type="button"
                            title="Let other members see the student layer"
                            aria-label="Share student marks"
                            aria-pressed={layerAudience.shareStudentLayer}
                            onClick={() => shareStudentLayerToggle(!layerAudience.shareStudentLayer)}
                            className={`border-l border-stone-200 px-2.5 transition ${
                                layerAudience.shareStudentLayer
                                    ? 'bg-accent-soft text-accent'
                                    : 'text-stone-600 hover:bg-ink/5'
                            }`}
                        >
                            {layerAudience.shareStudentLayer ? 'Marks shared' : 'Share marks'}
                        </button>
                    ) : null}
                </div>
                <button
                    type="button"
                    role="switch"
                    title={
                        printHandwriting
                            ? 'Print on — digits and symbols convert on this device. Letters stay ink.'
                            : 'Print off — handwriting stays ink'
                    }
                    aria-label="Print"
                    aria-checked={printHandwriting}
                    onClick={() => {
                        const next = !printHandwriting;
                        setPrintHandwriting(next);
                        if (next) {
                            warmPrintPipeline();
                        }
                    }}
                    className={`flex h-8 items-center gap-1.5 rounded-full border px-2 text-xs ${
                        printHandwriting
                            ? 'border-accent/30 bg-accent-soft text-accent'
                            : 'border-stone-200 bg-stone-50 text-stone-600'
                    }`}
                >
                    <span
                        aria-hidden
                        className={`relative h-4 w-7 rounded-full transition ${printHandwriting ? 'bg-accent' : 'bg-stone-300'}`}
                    >
                        <span
                            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow ${
                                printHandwriting ? 'left-3.5' : 'left-0.5'
                            }`}
                        />
                    </span>
                    Print
                </button>
            </div>
        </div>
    );
};

function PenIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z" />
        </svg>
    );
}

function HighlighterIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 19h14M8 15l-2 2v2h4l7-7-4-4-5 5zM15 8l2-2 3 3-2 2"
            />
            <path strokeLinecap="round" d="M7 17h6" className="opacity-50" />
        </svg>
    );
}

function EraserIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="m7 17-3-3 8-8 6 6-8 8H7zM6 20h12" />
        </svg>
    );
}

function TextIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 7V5h14v2M12 5v14M9 19h6" />
        </svg>
    );
}

function HairpinIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 12 20 6M4 12 20 18" />
        </svg>
    );
}

function FingeringIcon() {
    // Three white keys, two black keys straddling the dividers (piano octave slice).
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
            <path strokeLinecap="round" strokeWidth="2.5" d="M9.33 5.5v6M14.67 5.5v6" />
            <path strokeLinecap="round" d="M9.33 13.5v5M14.67 13.5v5" className="opacity-50" />
        </svg>
    );
}
