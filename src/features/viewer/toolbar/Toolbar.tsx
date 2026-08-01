import { useSyncExternalStore } from 'react';

import type { AnnotationStore } from '@/sync/annotationStore';
import { STROKE_COLORS, useViewerStore } from '@/state/store';
import type { StrokeWidthKey, Tool } from '@/types/models';

const TOOLS: Array<{ tool: Tool; label: string; icon: string }> = [
    { tool: 'pan', label: 'Pan / select', icon: '✋' },
    { tool: 'pen', label: 'Pen', icon: '✒️' },
    { tool: 'highlighter', label: 'Highlighter', icon: '🖍️' },
    { tool: 'eraser', label: 'Eraser', icon: '⌫' },
    { tool: 'text', label: 'Text note', icon: 'T' },
];

const WIDTHS: Array<{ key: StrokeWidthKey; label: string; dot: string }> = [
    { key: 'thin', label: 'Thin', dot: 'h-1 w-1' },
    { key: 'medium', label: 'Medium', dot: 'h-2 w-2' },
    { key: 'thick', label: 'Thick', dot: 'h-3 w-3' },
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

    const showInkOptions = tool === 'pen' || tool === 'highlighter' || tool === 'text';

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:bottom-auto sm:top-3"
        >
            <div className="pointer-events-auto flex max-w-[calc(100vw-1rem)] flex-wrap items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white/95 px-2 py-1.5 shadow-lg backdrop-blur">
                {TOOLS.map(({ tool: t, label, icon }) => (
                    <button
                        key={t}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={tool === t}
                        onClick={() => setTool(t)}
                        className={`flex h-10 w-10 items-center justify-center rounded-xl text-base ${
                            tool === t ? 'bg-indigo-100 text-indigo-700' : 'text-stone-600 hover:bg-stone-100'
                        }`}
                    >
                        <span className={t === 'text' ? 'font-serif text-lg font-bold' : ''}>{icon}</span>
                    </button>
                ))}

                {showInkOptions ? (
                    <>
                        <div className="mx-1 h-6 w-px bg-stone-200" />
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
                                <span className="h-5 w-5 rounded-full" style={{ backgroundColor: c }} />
                            </button>
                        ))}
                        <div className="mx-1 h-6 w-px bg-stone-200" />
                        {WIDTHS.map(({ key, label, dot }) => (
                            <button
                                key={key}
                                type="button"
                                title={label}
                                aria-label={`Width ${label}`}
                                aria-pressed={widthKey === key}
                                onClick={() => setWidthKey(key)}
                                className={`flex h-8 w-8 items-center justify-center rounded-xl ${
                                    widthKey === key ? 'bg-indigo-100' : 'hover:bg-stone-100'
                                }`}
                            >
                                <span className={`rounded-full bg-stone-700 ${dot}`} />
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
