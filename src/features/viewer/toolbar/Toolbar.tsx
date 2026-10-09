import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { features } from '@/lib/features';
import type { ObscuredEdges } from '@/features/viewer/geometry';
import type { AnnotationStore } from '@/sync/annotationStore';
import { STROKE_COLORS, useViewerStore } from '@/state/store';
import type { StrokeWidthKey, Tool } from '@/types/models';
import { PointerIcon, RedoIcon, UndoIcon } from '@/ui/icons';

const TOOLS: Array<{ tool: Tool; label: string; short: string; icon: ReactNode }> = [
    { tool: 'pan', label: 'Pan', short: 'Pan', icon: <PanIcon /> },
    { tool: 'pen', label: 'Pen', short: 'Pen', icon: <PenIcon /> },
    { tool: 'highlighter', label: 'Highlighter', short: 'Mark', icon: <HighlighterIcon /> },
    { tool: 'eraser', label: 'Eraser', short: 'Erase', icon: <EraserIcon /> },
    { tool: 'text', label: 'Text note', short: 'Text', icon: <TextIcon /> },
    ...(features.fingering
        ? [
              {
                  tool: 'fingering' as const,
                  label: 'Fingering — drag over a chord or phrase',
                  short: 'Hands',
                  icon: <FingeringIcon />,
              },
          ]
        : []),
];

const WIDTHS: Array<{ key: StrokeWidthKey; label: string; preview: number }> = [
    { key: 'thin', label: 'Thin', preview: 2 },
    { key: 'medium', label: 'Medium', preview: 4 },
    { key: 'thick', label: 'Thick', preview: 7 },
];

/**
 * Phone buttons share one row: each may shrink to fit a 320px screen and
 * stops growing at 44px; from `sm` up they keep their natural labelled size.
 */
const BAR_BUTTON =
    'flex h-10 min-w-0 max-w-11 flex-1 basis-0 items-center justify-center rounded-xl text-stone-600 transition sm:max-w-none sm:flex-none sm:basis-auto';

const DIVIDER = 'mx-0.5 h-6 w-px shrink-0 bg-stone-200 sm:mx-1';

export interface ToolbarProps {
    store: AnnotationStore;
    /**
     * How many px of the viewport's top or bottom edge the toolbar covers, so
     * the viewer can let the first and last page scroll clear of it.
     */
    onObscuredChange?: (edges: ObscuredEdges) => void;
}

/**
 * Floating tool palette. Phones: one row at the bottom (thumb-reachable),
 * above the safe area, icon buttons only, with the colours and sizes behind a
 * single style button — inline they wrapped the bar to three rows over the
 * page. From `sm` (tablets, a portrait iPad included): production's bar, at
 * the top with labels and the colours and sizes inline, one tap each; where
 * that wraps to two rows, the viewer lets the first page scroll clear of it
 * (onObscuredChange). Hidden entirely for view-only roles (M3).
 */
export const Toolbar = ({ store, onObscuredChange }: ToolbarProps) => {
    const tool = useViewerStore((s) => s.tool);
    const color = useViewerStore((s) => s.color);
    const widthKey = useViewerStore((s) => s.widthKey);
    const fingerDraws = useViewerStore((s) => s.fingerDraws);
    const { setTool, setColor, setWidthKey, setFingerDraws } = useViewerStore.getState();
    const [styleOpen, setStyleOpen] = useState(false);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const styleButtonRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const popoverId = useId();

    const undoState = useSyncExternalStore(
        (cb) => store.subscribeMeta(cb),
        () => `${store.canUndo}|${store.canRedo}`,
    );
    const [canUndo, canRedo] = undoState.split('|').map((v) => v === 'true');

    const showColors = tool === 'pen' || tool === 'highlighter' || tool === 'text';
    const showSize = tool === 'pen' || tool === 'highlighter' || tool === 'eraser';
    const sizeCaption = tool === 'eraser' ? 'Eraser size' : tool === 'highlighter' ? 'Marker size' : 'Pen size';
    const colorCaption = tool === 'highlighter' ? 'Marker colour' : tool === 'text' ? 'Text colour' : 'Pen colour';
    const styleLabel = showColors && showSize ? `${colorCaption} and size` : showColors ? colorCaption : sizeCaption;
    const preview = WIDTHS.find((w) => w.key === widthKey)?.preview ?? 4;

    const selectTool = (next: Tool) => {
        setStyleOpen(false);
        setTool(next);
    };

    // A tap outside the style popover (or Escape) puts it away.
    useEffect(() => {
        if (!styleOpen) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node | null;
            if (popoverRef.current?.contains(target) || styleButtonRef.current?.contains(target)) {
                return;
            }
            setStyleOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setStyleOpen(false);
                styleButtonRef.current?.focus();
            }
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [styleOpen]);

    // Report the strip of viewport the bar covers whenever either one resizes
    // (rotation, a tool that adds the style button, the safe area).
    useEffect(() => {
        const overlay = overlayRef.current;
        const viewport = overlay?.parentElement;
        if (!overlay || !viewport || !onObscuredChange) {
            return;
        }
        const measure = () => {
            const bar = overlay.getBoundingClientRect();
            const box = viewport.getBoundingClientRect();
            if (bar.height === 0) {
                onObscuredChange({ top: 0, bottom: 0 });
            } else if (bar.top > box.top + box.height / 2) {
                onObscuredChange({ top: 0, bottom: Math.max(0, Math.round(box.bottom - bar.top)) });
            } else {
                onObscuredChange({ top: Math.max(0, Math.round(bar.bottom - box.top)), bottom: 0 });
            }
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(overlay);
        observer?.observe(viewport);
        window.addEventListener('resize', measure);
        measure();
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            onObscuredChange({ top: 0, bottom: 0 });
        };
    }, [onObscuredChange]);

    const colorButtons = STROKE_COLORS.map((c) => (
        <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            onClick={() => setColor(c)}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                color === c ? 'ring-2 ring-accent ring-offset-1' : ''
            }`}
        >
            <span
                className={`h-5 w-5 rounded-full ${tool === 'highlighter' ? 'opacity-55' : ''}`}
                style={{ backgroundColor: c }}
            />
        </button>
    ));

    const sizeButtons = WIDTHS.map(({ key, label, preview: dot }) => (
        <button
            key={key}
            type="button"
            title={`${sizeCaption}: ${label}`}
            aria-label={`${sizeCaption} ${label}`}
            aria-pressed={widthKey === key}
            onClick={() => setWidthKey(key)}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${
                widthKey === key ? 'bg-accent-soft' : 'hover:bg-ink/5'
            }`}
        >
            <SizeDot tool={tool} size={dot} />
        </button>
    ));

    return (
        <div
            ref={overlayRef}
            data-ui-overlay
            className="pointer-events-none absolute inset-x-2 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:inset-x-0 sm:bottom-auto sm:top-3"
        >
            <div className="pointer-events-auto relative flex w-full flex-nowrap items-center justify-between rounded-2xl border border-stone-200 bg-white/95 px-1 py-1.5 shadow-lg backdrop-blur sm:w-auto sm:max-w-[calc(100vw-1rem)] sm:flex-wrap sm:justify-center sm:gap-1 sm:px-2">
                {TOOLS.map(({ tool: t, label, short, icon }) => (
                    <button
                        key={t}
                        type="button"
                        title={label}
                        aria-label={label}
                        aria-pressed={tool === t}
                        onClick={() => selectTool(t)}
                        className={`${BAR_BUTTON} gap-1 sm:min-w-[3.25rem] sm:flex-col sm:gap-0 sm:px-1.5 sm:py-1 ${
                            tool === t ? 'bg-accent-soft text-accent' : 'hover:bg-ink/5'
                        }`}
                    >
                        <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
                        <span className="hidden text-[10px] font-medium leading-none sm:block">{short}</span>
                    </button>
                ))}

                {showColors || showSize ? (
                    <>
                        {/* Phones: one button that opens the colours and sizes. */}
                        <div className={`${DIVIDER} sm:hidden`} />
                        <button
                            ref={styleButtonRef}
                            type="button"
                            title={styleLabel}
                            aria-label={styleLabel}
                            aria-haspopup="true"
                            aria-expanded={styleOpen}
                            aria-controls={styleOpen ? popoverId : undefined}
                            onClick={() => setStyleOpen((open) => !open)}
                            className={`${BAR_BUTTON} sm:hidden ${styleOpen ? 'bg-accent-soft' : 'hover:bg-ink/5'}`}
                        >
                            {showColors ? (
                                <span
                                    className={`flex h-6 w-6 items-center justify-center rounded-full ${
                                        tool === 'highlighter' ? 'opacity-55' : ''
                                    }`}
                                    style={{ backgroundColor: color }}
                                >
                                    {showSize ? (
                                        <span
                                            className="rounded-full bg-white/90"
                                            style={{ width: preview, height: preview }}
                                        />
                                    ) : null}
                                </span>
                            ) : (
                                <SizeDot tool={tool} size={preview + 4} />
                            )}
                        </button>
                        {styleOpen ? (
                            <div
                                ref={popoverRef}
                                id={popoverId}
                                role="group"
                                aria-label={styleLabel}
                                className="absolute inset-x-0 bottom-full mx-auto mb-2 w-fit max-w-full rounded-2xl border border-stone-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur sm:hidden"
                            >
                                {showColors ? (
                                    <>
                                        <p className="text-[10px] font-medium uppercase tracking-wide text-stone-500">
                                            {colorCaption}
                                        </p>
                                        <div className="mt-1 flex flex-wrap items-center gap-1">{colorButtons}</div>
                                    </>
                                ) : null}
                                {showSize ? (
                                    <>
                                        <p
                                            className={`text-[10px] font-medium uppercase tracking-wide text-stone-500 ${
                                                showColors ? 'mt-2' : ''
                                            }`}
                                        >
                                            {sizeCaption}
                                        </p>
                                        <div className="mt-1 flex items-center gap-1">{sizeButtons}</div>
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </>
                ) : null}

                {/* From sm up: colours and sizes inline, as in production. */}
                {showColors ? (
                    <div className="hidden sm:contents">
                        <div className={DIVIDER} />
                        {tool === 'highlighter' ? (
                            <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                                Marker
                            </span>
                        ) : null}
                        {colorButtons}
                    </div>
                ) : null}

                {showSize ? (
                    <div className="hidden sm:contents">
                        <div className={DIVIDER} />
                        <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-stone-500">
                            {sizeCaption}
                        </span>
                        {sizeButtons}
                    </div>
                ) : null}

                <div className={DIVIDER} />
                <button
                    type="button"
                    title="Undo"
                    aria-label="Undo"
                    disabled={!canUndo}
                    onClick={() => void store.undoLast()}
                    className={`${BAR_BUTTON} hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent sm:w-10`}
                >
                    <UndoIcon size={20} />
                </button>
                <button
                    type="button"
                    title="Redo"
                    aria-label="Redo"
                    disabled={!canRedo}
                    onClick={() => void store.redoLast()}
                    className={`${BAR_BUTTON} hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent sm:w-10`}
                >
                    <RedoIcon size={20} />
                </button>

                <div className={DIVIDER} />
                <button
                    type="button"
                    title={
                        fingerDraws ? 'Finger drawing on — a finger draws ink' : 'Finger drawing off — a finger pans'
                    }
                    aria-label="Draw with finger"
                    aria-pressed={fingerDraws}
                    onClick={() => setFingerDraws(!fingerDraws)}
                    className={`${BAR_BUTTON} gap-1 sm:min-w-[3.25rem] sm:flex-col sm:gap-0 sm:px-1.5 sm:py-1 ${
                        fingerDraws ? 'bg-accent-soft text-accent' : 'hover:bg-ink/5'
                    }`}
                >
                    <span className="flex h-5 w-5 items-center justify-center">
                        <PointerIcon size={20} />
                    </span>
                    <span className="hidden text-[10px] font-medium leading-none sm:block">Finger</span>
                </button>
            </div>
        </div>
    );
};

/** A stroke-width preview: an ink dot, a marker dot, or the eraser's ring. */
function SizeDot({ tool, size }: { tool: Tool; size: number }) {
    return (
        <span
            className={`rounded-full ${tool === 'highlighter' ? 'bg-amber-400/70' : 'bg-stone-700'} ${
                tool === 'eraser' ? 'border-2 border-stone-500 bg-transparent' : ''
            }`}
            style={{ width: size, height: size }}
        />
    );
}

function PanIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 11V6a1.5 1.5 0 0 1 3 0v5M12 11V4.5a1.5 1.5 0 0 1 3 0V11M15 11V6.5a1.5 1.5 0 0 1 3 0V14a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-5-5v-2.5a1.5 1.5 0 0 1 3 0V11"
            />
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
