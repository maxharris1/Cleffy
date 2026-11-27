import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { features } from '@/lib/features';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { showFingerSwitch } from '@/features/viewer/ink/inputPolicy';
import type { ObscuredEdges } from '@/features/viewer/geometry';
import { useReportToolbarPopup } from '@/features/viewer/toolbar/toolbarPopup';
import { settleEdit, type AnnotationStore } from '@/sync/annotationStore';
import { STROKE_COLORS, useViewerStore } from '@/state/store';
import type { StrokeWidthKey, Tool } from '@/types/models';
import { PointerIcon, RedoIcon, ScrollIcon, UndoIcon } from '@/ui/icons';
import { Segmented, type SegmentedOption } from '@/ui/Segmented';

const TOOLS: Array<{ tool: Tool; label: string; short: string; icon: ReactNode }> = [
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
    { key: 'thin', label: 'Thin', preview: 3 },
    { key: 'medium', label: 'Medium', preview: 5 },
    { key: 'thick', label: 'Thick', preview: 8 },
];

type FingerMode = 'scroll' | 'draw';

const FINGER_MODES = [
    { value: 'scroll', label: 'Finger scrolls', icon: <FingerModeKey icon={<ScrollIcon size={20} />} text="Scroll" /> },
    { value: 'draw', label: 'Finger draws', icon: <FingerModeKey icon={<PointerIcon size={20} />} text="Draw" /> },
] as const satisfies readonly SegmentedOption<FingerMode>[];

/**
 * Every control is a 44px square on a phone, where the row scrolls sideways
 * rather than shrinking them. From `sm` up the tools grow to 54 × 50 with a
 * label under the icon.
 */
const BAR_BUTTON =
    'flex h-11 min-w-11 shrink-0 items-center justify-center text-ink-soft active:bg-ink/10 touch-ui:hit-44-y';

const TOOL_BUTTON = `${BAR_BUTTON} rounded-xl sm:h-[50px] sm:w-[54px] sm:flex-col sm:gap-[3px]`;

const DIVIDER = 'mx-1.5 h-7 w-px shrink-0 bg-hairline max-sm:hidden';

const BAR_SHADOW = 'shadow-[0_0_0_1px_rgba(28,25,23,0.08),0_16px_34px_-18px_rgba(28,25,23,0.45)]';

const DIMMED = 'opacity-[0.45]';

const CURRENT_RING = 'shadow-[0_0_0_2px_#fff,0_0_0_4px_#1c1917]';

const CAPTION = 'text-[11px] font-semibold uppercase tracking-[0.08em]';

type ScrollFade = { start: boolean; end: boolean };

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
 * the top with labels; the colours and sizes stay behind the style button
 * until `lg`, where they fit inline, one tap each (inline, a portrait iPad's
 * bar wrapped to a mostly empty second row). Where the bar still wraps, the
 * viewer lets the first page scroll clear of it (onObscuredChange). Hidden
 * entirely for view-only roles (M3).
 */
export const Toolbar = ({ store, onObscuredChange }: ToolbarProps) => {
    const tool = useViewerStore((s) => s.tool);
    const color = useViewerStore((s) => s.color);
    const widthKey = useViewerStore((s) => s.widthKey);
    const fingerDraws = useViewerStore((s) => s.fingerDraws);
    const penSeen = useViewerStore((s) => s.penSeen);
    const touchSeen = useViewerStore((s) => s.touchSeen);
    const touchScreen = useMediaQuery('(pointer: coarse)');
    const { setTool, setColor, setWidthKey, setFingerDraws } = useViewerStore.getState();
    const [styleOpen, setStyleOpen] = useState(false);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const safeBottomProbeRef = useRef<HTMLDivElement | null>(null);
    const styleButtonRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const popoverId = useId();
    useReportToolbarPopup(styleOpen);

    const undoState = useSyncExternalStore(
        (cb) => store.subscribeMeta(cb),
        () => `${store.canUndo}|${store.canRedo}`,
    );
    const [canUndo, canRedo] = undoState.split('|').map((v) => v === 'true');

    const idle = tool === null;
    const showColors = idle || tool === 'pen' || tool === 'highlighter' || tool === 'text';
    const showSize = idle || tool === 'pen' || tool === 'highlighter' || tool === 'eraser';
    const sizeCaption = tool === 'eraser' ? 'Eraser size' : tool === 'highlighter' ? 'Marker size' : 'Pen size';
    const colorCaption = tool === 'highlighter' ? 'Marker colour' : tool === 'text' ? 'Text colour' : 'Pen colour';
    const styleLabel = showColors && showSize ? `${colorCaption} and size` : showColors ? colorCaption : sizeCaption;
    const preview = WIDTHS.find((w) => w.key === widthKey)?.preview ?? 5;

    const rowRef = useRef<HTMLDivElement | null>(null);
    const [fade, setFade] = useState<ScrollFade>({ start: false, end: false });
    const updateFade = () => {
        const row = rowRef.current;
        if (!row) {
            return;
        }
        const start = row.scrollLeft > 0;
        const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
        setFade((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    useLayoutEffect(updateFade);
    useEffect(() => {
        const row = rowRef.current;
        if (!row || typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(updateFade);
        observer.observe(row);
        return () => observer.disconnect();
    }, []);

    const fingerSwitch = showFingerSwitch({ touchScreen, touchSeen, penSeen });
    const fingerScrolls = fingerSwitch && !fingerDraws;

    const selectTool = (next: Tool) => {
        setStyleOpen(false);
        if (fingerScrolls) {
            setTool(next);
            setFingerDraws(true);
            return;
        }
        setTool(next === tool ? null : next);
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
    // (rotation, a tool that adds the style button) or the bottom safe area
    // moves the bar without resizing anything (the probe's height tracks it).
    useEffect(() => {
        const overlay = overlayRef.current;
        const viewport = overlay?.parentElement;
        if (!overlay || !viewport || !onObscuredChange) {
            return;
        }
        const root = document.documentElement;
        const measure = () => {
            const bar = overlay.getBoundingClientRect();
            const box = viewport.getBoundingClientRect();
            const atBottom = bar.height > 0 && bar.top > box.top + box.height / 2;
            // App-wide bars pinned to the window's bottom edge (SignedOutInkNotice)
            // sit above a bottom toolbar rather than over its buttons.
            root.style.setProperty(
                '--toolbar-bottom-clearance',
                atBottom ? `${Math.max(0, Math.round(window.innerHeight - bar.top))}px` : '0px',
            );
            if (bar.height === 0) {
                onObscuredChange({ top: 0, bottom: 0 });
            } else if (atBottom) {
                onObscuredChange({ top: 0, bottom: Math.max(0, Math.round(box.bottom - bar.top)) });
            } else {
                onObscuredChange({ top: Math.max(0, Math.round(bar.bottom - box.top)), bottom: 0 });
            }
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        observer?.observe(overlay);
        observer?.observe(viewport);
        if (safeBottomProbeRef.current) {
            observer?.observe(safeBottomProbeRef.current);
        }
        window.addEventListener('resize', measure);
        measure();
        return () => {
            observer?.disconnect();
            window.removeEventListener('resize', measure);
            root.style.removeProperty('--toolbar-bottom-clearance');
            onObscuredChange({ top: 0, bottom: 0 });
        };
    }, [onObscuredChange]);

    const colorButtons = (className: string) =>
        STROKE_COLORS.map((c) => (
            <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                disabled={idle}
                onClick={() => setColor(c)}
                className={`flex h-11 min-w-11 shrink-0 items-center justify-center ${className}`}
            >
                <span
                    className={`h-[22px] w-[22px] rounded-full ${tool === 'highlighter' ? 'opacity-55' : ''} ${
                        color === c ? CURRENT_RING : ''
                    }`}
                    style={{ backgroundColor: c }}
                />
            </button>
        ));

    const sizeButtons = (className: string) =>
        WIDTHS.map(({ key, label, preview: dot }) => (
            <button
                key={key}
                type="button"
                title={`${sizeCaption}: ${label}`}
                aria-label={`${sizeCaption} ${label}`}
                aria-pressed={widthKey === key}
                disabled={idle}
                onClick={() => setWidthKey(key)}
                className={`flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[10px] active:bg-ink/10 ${className} ${
                    widthKey === key ? 'bg-ink/[0.07]' : idle ? '' : 'hover:bg-ink/5'
                }`}
            >
                <SizeDot tool={tool} size={dot} />
            </button>
        ));

    return (
        <div
            ref={overlayRef}
            data-ui-overlay
            className="pointer-events-none absolute bottom-[calc(0.75rem+var(--safe-bottom))] left-[max(0.5rem,var(--safe-left))] right-[max(0.5rem,var(--safe-right))] z-20 flex justify-center sm:inset-x-0 sm:bottom-auto sm:top-3"
        >
            <div
                ref={safeBottomProbeRef}
                aria-hidden
                className="invisible absolute bottom-0 h-[var(--safe-bottom)] w-0"
            />
            <div
                data-touch-ui={touchSeen ? '' : undefined}
                className={`pointer-events-auto relative w-full rounded-[18px] bg-white ${BAR_SHADOW} sm:w-auto sm:max-w-[calc(100vw-1rem)]`}
            >
                <div
                    ref={rowRef}
                    onScroll={updateFade}
                    className="flex flex-nowrap items-center justify-between gap-0.5 rounded-[18px] px-1.5 py-[5px] max-sm:overflow-x-auto max-sm:[scrollbar-width:none] sm:flex-wrap sm:justify-center sm:px-2.5 sm:py-1.5"
                >
                    {fingerSwitch ? (
                        <>
                            <Segmented
                                label="What a finger does"
                                size="md"
                                value={fingerDraws ? 'draw' : 'scroll'}
                                options={FINGER_MODES}
                                onChange={(mode) => setFingerDraws(mode === 'draw')}
                            />
                            <div className={DIVIDER} />
                        </>
                    ) : null}
                    {TOOLS.map(({ tool: t, label, short, icon }) => (
                        <button
                            key={t}
                            type="button"
                            title={label}
                            aria-label={label}
                            aria-pressed={tool === t}
                            onClick={() => selectTool(t)}
                            className={`${TOOL_BUTTON} ${
                                tool === t ? 'bg-accent-tint font-bold text-accent' : 'font-semibold hover:bg-ink/5'
                            } ${fingerScrolls ? DIMMED : ''}`}
                        >
                            {icon}
                            <span className="hidden text-[11px] leading-none sm:block">{short}</span>
                        </button>
                    ))}

                    {showColors || showSize ? (
                        <>
                            {/* Below lg: one button that opens the colours and sizes. */}
                            <div className={`${DIVIDER} lg:hidden`} />
                            <button
                                ref={styleButtonRef}
                                type="button"
                                title={styleLabel}
                                aria-label={styleLabel}
                                // A disclosure, not a menu: aria-haspopup would promise menu
                                // keys the swatches do not have. Expanded + controls says it.
                                aria-expanded={styleOpen}
                                aria-controls={styleOpen ? popoverId : undefined}
                                disabled={idle}
                                onClick={() => setStyleOpen((open) => !open)}
                                className={`${BAR_BUTTON} rounded-xl lg:hidden ${
                                    styleOpen ? 'bg-ink/[0.07]' : idle ? DIMMED : 'hover:bg-ink/5'
                                }`}
                            >
                                {showColors ? (
                                    <span
                                        className={`flex h-6 w-6 items-center justify-center rounded-full ${CURRENT_RING} ${
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
                                    // Lifts the viewer frame over floating UI while open (LocalViewerFrame).
                                    data-toolbar-popup
                                    // Above the phone's bottom bar; below the bar docked at the top from sm.
                                    className={`ui-menu-pop absolute inset-x-0 bottom-full mx-auto mb-2 w-fit max-w-full rounded-[18px] bg-white px-3 py-2 ${BAR_SHADOW} [--transform-origin:bottom_center] sm:bottom-auto sm:[--transform-origin:top_center] sm:top-full sm:mb-0 sm:mt-2 lg:hidden`}
                                >
                                    {showColors ? (
                                        <>
                                            <p className={`${CAPTION} text-ink-muted`}>{colorCaption}</p>
                                            <div className="mt-1 flex flex-wrap items-center">{colorButtons('')}</div>
                                        </>
                                    ) : null}
                                    {showSize ? (
                                        <>
                                            <p className={`${CAPTION} text-ink-muted ${showColors ? 'mt-2' : ''}`}>
                                                {sizeCaption}
                                            </p>
                                            <div className="mt-1 flex items-center">{sizeButtons('')}</div>
                                        </>
                                    ) : null}
                                </div>
                            ) : null}
                        </>
                    ) : null}

                    {/* From lg up: colours and sizes inline, as in production. */}
                    {showColors ? (
                        <div className="hidden lg:contents">
                            <div className={DIVIDER} />
                            {tool === 'highlighter' ? (
                                <span className={`mr-1.5 ${CAPTION} text-amber-700`}>Marker</span>
                            ) : null}
                            {colorButtons(`-mx-[5px] first-of-type:ml-0 last-of-type:mr-0 ${idle ? DIMMED : ''}`)}
                        </div>
                    ) : null}

                    {showSize ? (
                        <div className="hidden lg:contents">
                            <div className={DIVIDER} />
                            <span className={`mr-1.5 ${CAPTION} text-ink-muted ${idle ? DIMMED : ''}`}>
                                {sizeCaption}
                            </span>
                            {sizeButtons(`-mx-1 ${idle ? DIMMED : ''}`)}
                        </div>
                    ) : null}

                    <div className={DIVIDER} />
                    <button
                        type="button"
                        title="Undo"
                        aria-label="Undo"
                        disabled={!canUndo}
                        onClick={() => settleEdit(store.undoLast())}
                        className={`${BAR_BUTTON} rounded-[10px] hover:bg-ink/5 disabled:text-on-ink-faint disabled:hover:bg-transparent`}
                    >
                        <UndoIcon size={19} />
                    </button>
                    <button
                        type="button"
                        title="Redo"
                        aria-label="Redo"
                        disabled={!canRedo}
                        onClick={() => settleEdit(store.redoLast())}
                        className={`${BAR_BUTTON} rounded-[10px] hover:bg-ink/5 disabled:text-on-ink-faint disabled:hover:bg-transparent`}
                    >
                        <RedoIcon size={19} />
                    </button>
                </div>
                {fade.start ? (
                    <div
                        aria-hidden="true"
                        data-scroll-fade="start"
                        className="pointer-events-none absolute inset-y-0 left-0 w-6 rounded-l-[18px] bg-linear-to-r from-white to-transparent sm:hidden"
                    />
                ) : null}
                {fade.end ? (
                    <div
                        aria-hidden="true"
                        data-scroll-fade="end"
                        className="pointer-events-none absolute inset-y-0 right-0 w-6 rounded-r-[18px] bg-linear-to-l from-white to-transparent sm:hidden"
                    />
                ) : null}
            </div>
        </div>
    );
};

function FingerModeKey({ icon, text }: { icon: ReactNode; text: string }) {
    return (
        <span className="flex items-center gap-1 sm:px-1.5">
            {icon}
            <span className="hidden text-[13px] sm:inline">{text}</span>
        </span>
    );
}

/** A stroke-width preview: an ink dot, a marker dot, or the eraser's ring. */
function SizeDot({ tool, size }: { tool: Tool | null; size: number }) {
    return (
        <span
            className={`rounded-full ${tool === 'highlighter' ? 'bg-amber-400/70' : 'bg-ink'} ${
                tool === 'eraser' ? 'border-2 border-stone-500 bg-transparent' : ''
            }`}
            style={{ width: size, height: size }}
        />
    );
}

function PenIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            className="h-[19px] w-[19px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden
        >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.5 4.5 19.5 8.5 9 19H5v-4L15.5 4.5z" />
        </svg>
    );
}

function HighlighterIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            className="h-[19px] w-[19px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden
        >
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
        <svg
            viewBox="0 0 24 24"
            className="h-[19px] w-[19px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden
        >
            <path strokeLinecap="round" strokeLinejoin="round" d="m7 17-3-3 8-8 6 6-8 8H7zM6 20h12" />
        </svg>
    );
}

function TextIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            className="h-[19px] w-[19px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden
        >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 7V5h14v2M12 5v14M9 19h6" />
        </svg>
    );
}

function FingeringIcon() {
    // Three white keys, two black keys straddling the dividers (piano octave slice).
    return (
        <svg
            viewBox="0 0 24 24"
            className="h-[19px] w-[19px] shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden
        >
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
            <path strokeLinecap="round" strokeWidth="2.5" d="M9.33 5.5v6M14.67 5.5v6" />
            <path strokeLinecap="round" d="M9.33 13.5v5M14.67 13.5v5" className="opacity-50" />
        </svg>
    );
}
