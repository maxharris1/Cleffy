import { useSyncExternalStore, type ReactNode } from 'react';

import type { AnnotationStore } from '@/sync/annotationStore';
import { STROKE_COLORS, useViewerStore } from '@/state/store';
import type { StrokeWidthKey, Tool } from '@/types/models';

const TOOLS: Array<{ tool: Tool; label: string; short: string; icon: ReactNode }> = [
    { tool: 'pan', label: 'Pan', short: 'Pan', icon: <PanIcon /> },
    { tool: 'pen', label: 'Pen', short: 'Pen', icon: <PenIcon /> },
    { tool: 'highlighter', label: 'Highlighter', short: 'Mark', icon: <HighlighterIcon /> },
    { tool: 'eraser', label: 'Eraser', short: 'Erase', icon: <EraserIcon /> },
    { tool: 'text', label: 'Text note', short: 'Text', icon: <TextIcon /> },
];

const WIDTHS: Array<{ key: StrokeWidthKey; label: string; preview: number }> = [
    { key: 'thin', label: 'Thin', preview: 2 },
    { key: 'medium', label: 'Medium', preview: 4 },
    { key: 'thick', label: 'Thick', preview: 7 },
];

export interface ToolbarProps {
    store: AnnotationStore;
}

/**
 * Floating tool palette. Desktop: top-center. Phones: bottom (thumb-reachable),
 * above the safe area. Hidden entirely for view-only roles (M3).
 */
export const Toolbar = ({ store }: ToolbarProps) => {
    const tool = useViewerStore((s) => s.tool);
    const color = useViewerStore((s) => s.color);
    const widthKey = useViewerStore((s) => s.widthKey);
    const { setTool, setColor, setWidthKey } = useViewerStore.getState();

    const undoState = useSyncExternalStore(
        (cb) => store.subscribeMeta(cb),
        () => `${store.canUndo}|${store.canRedo}`,
    );
    const [canUndo, canRedo] = undoState.split('|').map((v) => v === 'true');

    const showColors = tool === 'pen' || tool === 'highlighter' || tool === 'text';
    const showSize = tool === 'pen' || tool === 'highlighter' || tool === 'eraser';
    const sizeCaption = tool === 'eraser' ? 'Eraser size' : tool === 'highlighter' ? 'Marker size' : 'Pen size';

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:bottom-auto sm:top-3"
        >
            <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] flex-wrap items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
                {TOOLS.map(({ tool: t, label, short, icon }) => (
                    <button
                        key={t}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={tool === t}
                        onClick={() => setTool(t)}
                        className={`flex h-10 items-center justify-center gap-1 rounded-xl px-2 text-stone-600 sm:min-w-[3.25rem] sm:flex-col sm:gap-0 sm:px-1.5 sm:py-1 ${
                            tool === t ? 'bg-indigo-100 text-indigo-700' : 'hover:bg-stone-100'
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
                                    color === c ? 'ring-2 ring-indigo-500 ring-offset-1' : ''
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
                                className={`flex h-8 w-8 items-center justify-center rounded-xl ${
                                    widthKey === key ? 'bg-indigo-100' : 'hover:bg-stone-100'
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
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                >
                    ↩
                </button>
                <button
                    type="button"
                    title="Redo"
                    aria-label="Redo"
                    disabled={!canRedo}
                    onClick={() => void store.redoLast()}
                    className="flex h-10 w-10 items-center justify-center rounded-xl text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                >
                    ↪
                </button>
            </div>
        </div>
    );
};

function PanIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 11V6a1.5 1.5 0 0 1 3 0v5M12 11V4.5a1.5 1.5 0 0 1 3 0V11M15 11V6.5a1.5 1.5 0 0 1 3 0V14a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-5-5v-2.5a1.5 1.5 0 0 1 3 0V11" />
        </svg>
    );
}

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
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 19h14M8 15l-2 2v2h4l7-7-4-4-5 5zM15 8l2-2 3 3-2 2" />
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
