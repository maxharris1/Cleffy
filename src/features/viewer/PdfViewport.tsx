import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { LoopRangeOverlay } from '@/features/playback/LoopRangeOverlay';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { PlayheadController } from '@/features/playback/PlayheadController';
import { measureIndexAtPagePoint, measureStartTick } from '@/features/playback/scoreTime';
import {
    MAX_SCALE,
    MIN_SCALE,
    PAGE_GAP,
    bitmapBudgetFactor,
    clampScroll,
    computeDocumentLayout,
    fitPageWidthScale,
    focusedPageIndex,
    mountedPageIndices,
    pageTurnView,
    viewportToPagePoint,
    visiblePageRange,
    zoomAt,
    type DocumentLayout,
    type PageColumns,
} from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { GestureController } from '@/features/viewer/ink/GestureController';
import { HandwritingController } from '@/features/viewer/ink/handwriting/handwritingController';
import { recognizeOnDevice } from '@/features/viewer/ink/handwriting/recognizer';
import { warmPrintPipeline } from '@/features/viewer/ink/handwriting/warmup';
import { InkController, type FingeringSelection, type TextIntent } from '@/features/viewer/ink/InkController';
import { editedTextPayload } from '@/features/viewer/ink/musicFont';
import { TextEditorOverlay } from '@/features/viewer/ink/TextEditorOverlay';
import { PageView } from '@/features/viewer/pdf/PageView';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
import { annotationVisible, withActiveLayer } from '@/features/viewer/layers';
import { Toolbar } from '@/features/viewer/toolbar/Toolbar';
import { getSupabase } from '@/lib/supabase';
import { peerColor } from '@/lib/colors';
import { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { DocRealtimeChannel } from '@/sync/realtimeChannel';
import {
    createSupabaseAnnotationsApi,
    fetchStudentLayerRows,
    fromServerRow,
    SyncEngine,
    type SyncStatus,
} from '@/sync/syncEngine';
import type { PresencePeer, ScoreAnalysisBroadcast } from '@/sync/wire';
import { useViewerStore } from '@/state/store';
import { isTextPayload } from '@/types/models';
import type { ScoreData } from '@/types/scoreData';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ChevronLeftIcon, ChevronRightIcon, Columns2Icon, CoverPageIcon, ZoomInIcon, ZoomOutIcon } from '@/ui/icons';

/** Fingering feature loads on first use — keeps it out of the viewer bundle. */
const FingeringFlow = lazy(() =>
    import('@/features/fingering/FingeringFlow').then((m) => ({ default: m.FingeringFlow })),
);

/** Delay before re-rendering page bitmaps at a new zoom level (ms). */
const RENDER_SETTLE_MS = 200;

/** Default text-note size as a fraction of page width. */
const DEFAULT_TEXT_SIZE = 0.018;

/**
 * A tap in the left/right margin strip of the viewport turns the page (the
 * sheet-music-reader convention). Kept narrow so a tap on the first or last
 * bar of a system still seeks during play-along.
 */
const edgeTapStripPx = (viewportWidth: number): number => Math.min(64, Math.max(36, viewportWidth * 0.08));

/**
 * Keys that turn pages — every mode a Bluetooth page-turner pedal ships in
 * (arrows, PageUp/Down) plus Space, as on a keyboard.
 */
const pageTurnDirection = (e: KeyboardEvent): -1 | 1 | null => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
        return null;
    }
    switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
            return e.shiftKey ? null : 1;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
            return e.shiftKey ? null : -1;
        case ' ':
            return e.shiftKey ? -1 : 1;
        default:
            return null;
    }
};

/** Keys aimed at a control or a dialog belong to it, not to page turning. */
const keyTargetsControl = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest(
        'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"]',
    ) !== null;

interface ViewportSize {
    width: number;
    height: number;
}

/** Play-along wiring: ScoreData + a handle to the (lazily created) engine. */
export interface PlaybackFeature {
    score: ScoreData | null;
    getEngine: () => PlaybackEngine | null;
}

export interface PdfViewportProps {
    docId: string;
    /** View-only role: hides editing UI and blocks the ink delegate. */
    readOnly?: boolean;
    /** Expose the live AnnotationStore to the parent (share/history chrome). */
    onStoreReady?: (store: AnnotationStore) => void;
    /** Present when play-along is available: playhead + tap-to-seek + loop tint. */
    playback?: PlaybackFeature;
    /** Present for cloud documents: enables the sync engine + realtime channel. */
    sync?: {
        userId: string;
        name: string;
        isAnonymous: boolean;
        canWrite: boolean;
        /** Only the document owner may fire the metered text-note transcribe. */
        isOwner?: boolean;
        onStatus?: (status: SyncStatus) => void;
        onPeers?: (peers: PresencePeer[]) => void;
        /** Another member replaced the PDF bytes (smart-import cleanup). */
        onDocReplaced?: (contentRev: number) => void;
        /** The owner shared or hid the student layer. */
        onStudentLayerShare?: (shared: boolean) => void;
        /** Play-along analysis status changed. */
        onScoreAnalysis?: (msg: ScoreAnalysisBroadcast) => void;
    };
}

/**
 * The scrollable, zoomable, annotatable stack of PDF pages. Owns the gesture +
 * ink wiring and page virtualization. Remount (key) per document.
 */
export const PdfViewport = ({ docId, readOnly = false, onStoreReady, playback, sync }: PdfViewportProps) => {
    const { doc, pageSizes, status, error } = usePdf();
    const view = useViewerStore((s) => s.view);
    const pageColumns = useViewerStore((s) => s.pageColumns);
    const spreadCover = useViewerStore((s) => s.spreadCover);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const inkRef = useRef<InkController | null>(null);
    const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
    const [renderScale, setRenderScale] = useState(view.scale);
    const [textIntent, setTextIntent] = useState<TextIntent | null>(null);
    const [fingeringSel, setFingeringSel] = useState<FingeringSelection | null>(null);
    const textIntentHandled = useRef(false);
    const didFitRef = useRef(false);
    /** Viewport the current view was last fitted/re-fitted for. */
    const fittedViewportRef = useRef<ViewportSize | null>(null);

    const layout: DocumentLayout = useMemo(
        () => computeDocumentLayout(pageSizes, pageColumns, spreadCover),
        [pageSizes, pageColumns, spreadCover],
    );

    // Annotation store + canvas registry — stable per mounted document, safe to
    // create during render (neither touches refs).
    const [annotationStore] = useState(() => new AnnotationStore(getDb(), docId));
    const [registry] = useState(() => new CanvasRegistry());
    const overlayMode = useSyncExternalStore(
        (cb) => annotationStore.subscribeMeta(cb),
        () => annotationStore.overlayMode,
    );
    const effectiveReadOnly = readOnly || overlayMode !== null;

    // Live refs so the imperative controllers always see current geometry.
    const layoutRef = useRef(layout);
    const viewportSizeRef = useRef(viewportSize);
    const readOnlyRef = useRef(effectiveReadOnly);
    const renderScaleRef = useRef(renderScale);
    const playbackRef = useRef(playback);
    useEffect(() => {
        layoutRef.current = layout;
        viewportSizeRef.current = viewportSize;
        readOnlyRef.current = effectiveReadOnly;
        renderScaleRef.current = renderScale;
        playbackRef.current = playback;
    }, [layout, viewportSize, effectiveReadOnly, renderScale, playback]);

    // Playhead overlay elements (inside the transformed wrapper) + controller.
    // These live in state, not refs: the overlay divs only exist once the PDF
    // has rendered, which can happen AFTER the score analysis arrives (a warm
    // Dexie cache serves ScoreData almost immediately on reopen). A ref would
    // still be null when the controller effect first ran, and nothing would
    // re-run it — the playhead then never appeared for the rest of the
    // session. Callback refs re-fire the effect the moment the divs mount.
    const [playheadLineEl, setPlayheadLineEl] = useState<HTMLDivElement | null>(null);
    const [measureHighlightEl, setMeasureHighlightEl] = useState<HTMLDivElement | null>(null);
    const playheadControllerRef = useRef<PlayheadController | null>(null);

    useEffect(() => {
        void annotationStore.load();
    }, [annotationStore]);

    useEffect(() => {
        onStoreReady?.(annotationStore);
    }, [annotationStore, onStoreReady]);

    const syncUserId = sync?.userId;
    const syncName = sync?.name;
    const syncIsAnonymous = sync?.isAnonymous ?? false;
    const syncCanWrite = sync?.canWrite ?? false;
    const syncOnStatus = sync?.onStatus;
    const syncOnPeers = sync?.onPeers;
    const syncOnDocReplaced = sync?.onDocReplaced;
    const syncOnStudentLayerShare = sync?.onStudentLayerShare;
    const syncOnScoreAnalysis = sync?.onScoreAnalysis;
    const shareStudentLayer = useViewerStore((s) => s.layerAudience.shareStudentLayer);
    const audienceRole = useViewerStore((s) => s.layerAudience.role);
    const audienceUserId = useViewerStore((s) => s.layerAudience.userId);
    const channelRef = useRef<DocRealtimeChannel | null>(null);

    // The watermark pull skips student rows written while they were hidden.
    // Sharing them, or hiding them again, has to catch the local copy up.
    useEffect(() => {
        if (!syncUserId || audienceRole === 'owner' || audienceRole === 'local') {
            return;
        }
        let cancelled = false;
        void (async () => {
            const audience = useViewerStore.getState().layerAudience;
            if (!audience.shareStudentLayer) {
                await annotationStore.dropLocalWhere((annotation) => !annotationVisible(annotation, audience));
                return;
            }
            const rows = await fetchStudentLayerRows(docId);
            if (cancelled) {
                return;
            }
            const pendingIds = new Set(
                (await getDb().ops.where('docId').equals(docId).toArray()).map((op) => op.annotationId),
            );
            const visible = rows
                .map(fromServerRow)
                .filter((annotation) => annotationVisible(annotation, useViewerStore.getState().layerAudience));
            await annotationStore.applyRemoteBatch(visible, pendingIds);
        })();
        return () => {
            cancelled = true;
        };
    }, [annotationStore, docId, syncUserId, shareStudentLayer, audienceRole, audienceUserId]);

    // Track viewport size.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const measure = () => {
            const width = el.clientWidth;
            const height = el.clientHeight;
            setViewportSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
        };
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        measure();
        return () => observer.disconnect();
    }, []);

    // Fit the widest page to the viewport width once the document is ready.
    useEffect(() => {
        if (didFitRef.current || status !== 'ready' || viewportSize.width === 0 || layout.layouts.length === 0) {
            return;
        }
        didFitRef.current = true;
        fittedViewportRef.current = viewportSize;
        const scale = fitPageWidthScale(layout, viewportSize.width);
        const fitted = clampScroll({ scale, scrollX: 0, scrollY: 0 }, layout, viewportSize.width, viewportSize.height);
        useViewerStore.getState().resetView(fitted);
        setRenderScale(scale);
    }, [status, viewportSize, layout]);

    // Rotation (or any later resize): keep the zoom RELATIVE to fit-width, so a
    // spread fitted in landscape does not arrive in portrait 2× too large (and
    // mount twice the bitmaps), nor a portrait fit turn into a ribbon in
    // landscape. The content point under the old centre stays at the new
    // centre. Ratios compose, so iOS's transient sizes mid-rotation land right.
    useEffect(() => {
        const prev = fittedViewportRef.current;
        if (!didFitRef.current || !prev || viewportSize.width === 0 || viewportSize.height === 0) {
            return;
        }
        if (prev.width === viewportSize.width && prev.height === viewportSize.height) {
            return;
        }
        fittedViewportRef.current = viewportSize;
        const { view: v, setView } = useViewerStore.getState();
        const ratio = fitPageWidthScale(layout, viewportSize.width) / fitPageWidthScale(layout, prev.width);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * ratio));
        const cx = (v.scrollX + prev.width / 2) / v.scale;
        const cy = (v.scrollY + prev.height / 2) / v.scale;
        setView(
            clampScroll(
                { scale, scrollX: cx * scale - viewportSize.width / 2, scrollY: cy * scale - viewportSize.height / 2 },
                layout,
                viewportSize.width,
                viewportSize.height,
            ),
        );
        setRenderScale(scale);
    }, [viewportSize, layout]);

    /**
     * Turn one row of pages. Reads live refs so the once-bound gesture
     * controller and the keyboard listener always run the current geometry.
     * Counts as a user gesture for auto-follow, exactly like a manual pan.
     */
    const turnPage = useCallback((direction: -1 | 1) => {
        const { view: v, setView } = useViewerStore.getState();
        const { width, height } = viewportSizeRef.current;
        const current = focusedPageIndex(v, height, layoutRef.current.layouts);
        const next = pageTurnView(v, layoutRef.current, current, direction, width, height);
        if (!next) {
            return;
        }
        playheadControllerRef.current?.notifyUserGesture();
        setView(next.view);
    }, []);

    /**
     * Re-lay the document out, keeping the reader's place: the page nearest the
     * viewport centre lands at the top of the re-fitted view. Shared by both
     * layout switches — the page nearest the centre stays the page in view
     * whether its row changed shape or moved down by one.
     */
    const relayout = (columns: PageColumns, coverPage: boolean) => {
        const { view: v, setView, setPageColumns, setSpreadCover } = useViewerStore.getState();
        const { width, height } = viewportSize;
        const nextLayout = computeDocumentLayout(pageSizes, columns, coverPage);
        const focused = focusedPageIndex(v, height, layout.layouts);
        const scale = fitPageWidthScale(nextLayout, width);
        const top = nextLayout.layouts[focused]?.top ?? PAGE_GAP;
        fittedViewportRef.current = viewportSize;
        setPageColumns(columns);
        setSpreadCover(coverPage);
        setView(clampScroll({ scale, scrollX: 0, scrollY: (top - PAGE_GAP) * scale }, nextLayout, width, height));
        setRenderScale(scale);
    };

    /** Switch between one and two pages per row. */
    const togglePageColumns = () => relayout(pageColumns === 1 ? 2 : 1, spreadCover);

    /** Hold the first page back as a cover, so spreads pair 2|3 as printed music does. */
    const toggleSpreadCover = () => relayout(pageColumns, !spreadCover);

    // Crisp bitmap re-render shortly after zoom settles (canvases CSS-stretch meanwhile).
    useEffect(() => {
        if (view.scale === renderScale) {
            return;
        }
        const timer = setTimeout(() => setRenderScale(useViewerStore.getState().view.scale), RENDER_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [view.scale, renderScale]);

    // Gesture + ink controllers — imperative, constructed in effect scope where
    // reading refs is legal. Attach once: the container renders in every state.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const toLocal = (e: { clientX: number; clientY: number }) => {
            const rect = el.getBoundingClientRect();
            return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        };
        // Opt-in on-device print of THIS writer's committed pen strokes.
        // Digits and symbols only. Letters stay ink. No cloud convert.
        const handwriting = new HandwritingController({
            store: annotationStore,
            recognizer: recognizeOnDevice,
            isEnabled: () => useViewerStore.getState().printHandwriting && !readOnlyRef.current,
            getAspect: (pageIndex) => {
                const pageLayout = layoutRef.current.layouts[pageIndex];
                return pageLayout ? pageLayout.height / pageLayout.width : null;
            },
        });
        if (useViewerStore.getState().printHandwriting) {
            warmPrintPipeline();
        }
        const ink = new InkController({
            store: annotationStore,
            registry,
            isReadOnly: () => readOnlyRef.current,
            getView: () => useViewerStore.getState().view,
            getLayout: () => layoutRef.current,
            toLocal,
            onTextIntent: (intent) => {
                textIntentHandled.current = false;
                setTextIntent(intent);
            },
            onFingeringSelect: (selection) => setFingeringSel(selection),
            onStrokeCommitted: (annotation) => handwriting.onStrokeCommitted(annotation),
        });
        inkRef.current = ink;

        const clamp = (v: { scale: number; scrollX: number; scrollY: number }) =>
            clampScroll(v, layoutRef.current, viewportSizeRef.current.width, viewportSizeRef.current.height);

        const controller = new GestureController(el, {
            onPan: (dx, dy) => {
                playheadControllerRef.current?.notifyUserGesture();
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX - dx, scrollY: v.scrollY - dy }));
            },
            onZoomBy: (factor, cx, cy) => {
                playheadControllerRef.current?.notifyUserGesture();
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp(zoomAt(v, v.scale * factor, cx, cy)));
            },
            onWheelScroll: (dx, dy) => {
                playheadControllerRef.current?.notifyUserGesture();
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX + dx, scrollY: v.scrollY + dy }));
            },
            onGestureEnd: () => {
                // Bitmap refresh is handled by the settle timer on scale change.
            },
            onTap: (x, y) => {
                // A tap in the margin strip turns the page, whatever the tool:
                // only pointers the ink layer declined get here.
                const strip = edgeTapStripPx(viewportSizeRef.current.width);
                if (x < strip) {
                    turnPage(-1);
                    return;
                }
                if (x > viewportSizeRef.current.width - strip) {
                    turnPage(1);
                    return;
                }
                // Tap a measure to seek there — with the pan tool (or as a
                // read-only viewer, whose taps can't mean anything else).
                const feature = playbackRef.current;
                if (!feature?.score) {
                    return;
                }
                const state = useViewerStore.getState();
                if (!readOnlyRef.current && state.tool !== 'pan') {
                    return;
                }
                const point = viewportToPagePoint(state.view, layoutRef.current.layouts, x, y);
                if (!point) {
                    return;
                }
                // Bias to the pass being played, so tapping a repeated bar
                // mid-second-pass does not throw the playhead back to the first.
                const index = measureIndexAtPagePoint(
                    feature.score,
                    point.pageIndex,
                    point.nx,
                    point.ny,
                    feature.getEngine()?.getPositionTicks() ?? 0,
                );
                if (index < 0) {
                    return;
                }
                feature.getEngine()?.seek(measureStartTick(feature.score.measures, index));
            },
        });
        controller.setInkDelegate(ink.delegate);

        // Cloud documents additionally get the sync engine + realtime channel,
        // wired to the same store and ink controller (plan §realtime).
        let engine: SyncEngine | null = null;
        let channel: DocRealtimeChannel | null = null;
        if (syncUserId && syncName !== undefined) {
            engine = new SyncEngine({
                db: getDb(),
                store: annotationStore,
                api: createSupabaseAnnotationsApi(getSupabase()),
                docId,
                getUserId: () => syncUserId,
                onStatus: syncOnStatus,
                acceptsRemote: (annotation) => annotationVisible(annotation, useViewerStore.getState().layerAudience),
            });
            channel = new DocRealtimeChannel({
                supabase: getSupabase(),
                docId,
                self: {
                    userId: syncUserId,
                    name: syncName,
                    color: peerColor(syncUserId),
                    page: 0,
                    isAnonymous: syncIsAnonymous,
                },
                onRemoteInk: (msg) => ink.applyRemoteInk(msg),
                onDbChange: (row) => {
                    void engine?.applyServerRow(row);
                    ink.remoteInkCommitted(row.id);
                },
                onPeers: (peers) => syncOnPeers?.(peers),
                onReconnect: () => {
                    ink.clearRemoteInk();
                    void engine?.sync();
                },
                onDocReplaced: (contentRev) => syncOnDocReplaced?.(contentRev),
                onStudentLayerShare: (shared) => syncOnStudentLayerShare?.(shared),
                onScoreAnalysis: (msg) => syncOnScoreAnalysis?.(msg),
            });
            if (syncCanWrite) {
                ink.setLivePublisher(channel.publisher);
            }
            engine.start();
            channel.start();
            channelRef.current = channel;
        }

        return () => {
            channelRef.current = null;
            channel?.stop();
            engine?.stop();
            controller.destroy();
            ink.destroy();
            inkRef.current = null;
            handwriting.dispose();
        };
    }, [
        annotationStore,
        registry,
        docId,
        turnPage,
        syncUserId,
        syncName,
        syncIsAnonymous,
        syncCanWrite,
        syncOnStatus,
        syncOnPeers,
        syncOnDocReplaced,
        syncOnStudentLayerShare,
        syncOnScoreAnalysis,
    ]);

    // Playhead: imperative rAF controller over the two overlay divs below.
    const playbackScore = playback?.score ?? null;
    const playbackGetEngine = playback?.getEngine;
    useEffect(() => {
        if (!playbackScore || !playbackGetEngine || !playheadLineEl || !measureHighlightEl) {
            return;
        }
        const controller = new PlayheadController({
            getEngine: playbackGetEngine,
            getScore: () => playbackScore,
            lineEl: playheadLineEl,
            highlightEl: measureHighlightEl,
            getLayout: () => layoutRef.current,
            getRenderScale: () => renderScaleRef.current,
            getViewportSize: () => viewportSizeRef.current,
        });
        playheadControllerRef.current = controller;
        return () => {
            playheadControllerRef.current = null;
            controller.destroy();
        };
    }, [playbackScore, playbackGetEngine, playheadLineEl, measureHighlightEl]);

    // Presence: report the top visible page (debounced against scroll churn).
    useEffect(() => {
        const timer = setTimeout(() => {
            const range = visiblePageRange(view, viewportSize.height, layout.layouts, 0);
            channelRef.current?.setPage(Math.max(0, range.start));
            useViewerStore.getState().setFocusedPageIndex(focusedPageIndex(view, viewportSize.height, layout.layouts));
        }, 400);
        return () => clearTimeout(timer);
    }, [view, viewportSize.height, layout]);

    // Keyboard: page turns (any role — pedals send these keys) and undo/redo.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || keyTargetsControl(e.target)) {
                return;
            }
            const direction = pageTurnDirection(e);
            if (direction !== null) {
                e.preventDefault();
                turnPage(direction);
                return;
            }
            if (readOnlyRef.current || !(e.metaKey || e.ctrlKey)) {
                return;
            }
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) {
                e.preventDefault();
                void annotationStore.undoLast();
            } else if ((key === 'z' && e.shiftKey) || key === 'y') {
                e.preventDefault();
                void annotationStore.redoLast();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [annotationStore, turnPage]);

    const commitText = (text: string) => {
        if (!textIntent || textIntentHandled.current) {
            return;
        }
        textIntentHandled.current = true;
        setTextIntent(null);
        const trimmed = text.trim();
        const { existing } = textIntent;
        if (existing) {
            const live = annotationStore.get(existing.id);
            const base = live && isTextPayload(live.payload) ? live.payload : existing.payload;
            if (!isTextPayload(base)) {
                return;
            }
            // Live payload keeps a font change made while this editor is open.
            const next = editedTextPayload(base, trimmed);
            if (next === 'delete') {
                void annotationStore.delete(existing.id);
            } else if (next !== 'unchanged') {
                void annotationStore.update(existing.id, { payload: next });
            }
            return;
        }
        if (trimmed === '') {
            return;
        }
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        void annotationStore.create({
            id,
            docId,
            page: textIntent.pageIndex,
            kind: 'text',
            color: useViewerStore.getState().color,
            payload: withActiveLayer({
                x: textIntent.nx,
                y: textIntent.ny,
                text: trimmed,
                size: DEFAULT_TEXT_SIZE,
            }),
            createdBy: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            seq: 0,
        });
        inkRef.current?.selectTextNote(id, textIntent.pageIndex);
    };

    // Device pixels per CSS pixel for page bitmaps, reduced when everything
    // that can be mounted at this zoom would blow the canvas budget (iOS kills
    // the tab well before the OS reports memory pressure).
    const pixelRatio = useMemo(() => {
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        return dpr * bitmapBudgetFactor(layout, pageColumns, renderScale, dpr, viewportSize.width, viewportSize.height);
    }, [layout, pageColumns, renderScale, viewportSize.width, viewportSize.height]);

    const pages = [];
    if (doc) {
        for (const i of mountedPageIndices(view, layout, viewportSize.width, viewportSize.height)) {
            const pageLayout = layout.layouts[i];
            if (pageLayout) {
                pages.push(
                    <PageView
                        key={i}
                        doc={doc}
                        pageIndex={i}
                        layout={pageLayout}
                        scale={renderScale}
                        pixelRatio={pixelRatio}
                        registry={registry}
                    />,
                );
            }
        }
    }

    // Positions use the live scale; bitmaps use the settled renderScale. While they
    // differ, canvases are CSS-stretched by wrapping pages in a scaling transform.
    const previewFactor = view.scale / renderScale;
    const textIntentLayout = textIntent ? layout.layouts[textIntent.pageIndex] : undefined;
    const fingeringLayout = fingeringSel ? layout.layouts[fingeringSel.pageIndex] : undefined;

    // NOTE: the ref'd container must render in every state — the ResizeObserver
    // and GestureController bind once and would otherwise attach to nothing.
    return (
        <div ref={containerRef} className="ink-surface relative h-full overflow-hidden bg-stone-200">
            {status === 'loading' ? (
                <div className="flex h-full items-center justify-center">
                    <LoadingText>Loading score…</LoadingText>
                </div>
            ) : status === 'error' || !doc ? (
                <div className="flex h-full items-center justify-center p-8">
                    <ErrorText>Could not open this PDF{error ? `: ${error}` : '.'}</ErrorText>
                </div>
            ) : (
                <>
                    <div
                        className="absolute left-0 top-0"
                        style={{
                            transform: `translate(${-view.scrollX}px, ${-view.scrollY}px) scale(${previewFactor})`,
                            transformOrigin: '0 0',
                            width: layout.contentWidth * renderScale,
                            height: layout.contentHeight * renderScale,
                        }}
                    >
                        {pages}
                        {playbackScore ? (
                            <>
                                <LoopRangeOverlay score={playbackScore} layout={layout} renderScale={renderScale} />
                                <div
                                    ref={setMeasureHighlightEl}
                                    aria-hidden="true"
                                    className="pointer-events-none absolute left-0 top-0 rounded-[2px] bg-accent/10"
                                    style={{ display: 'none' }}
                                />
                                <div
                                    ref={setPlayheadLineEl}
                                    aria-hidden="true"
                                    className="pointer-events-none absolute left-0 top-0 w-[2px] rounded-full bg-accent/70"
                                    style={{ display: 'none' }}
                                />
                            </>
                        ) : null}
                    </div>
                    {overlayMode === 'history' ? (
                        <div
                            data-ui-overlay
                            className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center"
                        >
                            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-950 shadow">
                                <span>Viewing day starting point</span>
                                <button
                                    type="button"
                                    onClick={() => annotationStore.setHistoryOverlay(null)}
                                    className="rounded-full bg-amber-800 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-amber-700"
                                >
                                    Back to current
                                </button>
                            </div>
                        </div>
                    ) : null}
                    {effectiveReadOnly ? null : <Toolbar store={annotationStore} />}
                    {readOnly && overlayMode === null ? <ReadOnlyFingeringToggle /> : null}
                    {!effectiveReadOnly && textIntent && textIntentLayout ? (
                        <TextEditorOverlay
                            intent={textIntent}
                            layout={textIntentLayout}
                            view={view}
                            store={annotationStore}
                            onCommit={commitText}
                            onCancel={() => {
                                textIntentHandled.current = true;
                                setTextIntent(null);
                            }}
                        />
                    ) : null}
                    {fingeringSel && fingeringLayout ? (
                        <Suspense fallback={null}>
                            <FingeringFlow
                                key={`${fingeringSel.pageIndex}:${fingeringSel.rect.x.toFixed(4)}:${fingeringSel.rect.y.toFixed(4)}`}
                                docId={docId}
                                selection={fingeringSel}
                                layout={fingeringLayout}
                                store={annotationStore}
                                canWrite={!readOnly}
                                score={playbackScore}
                                onClose={() => setFingeringSel(null)}
                            />
                        </Suspense>
                    ) : null}
                    <ZoomControls
                        onZoomBy={(factor) => {
                            const { view: v, setView } = useViewerStore.getState();
                            const zoomed = zoomAt(v, v.scale * factor, viewportSize.width / 2, viewportSize.height / 2);
                            setView(clampScroll(zoomed, layout, viewportSize.width, viewportSize.height));
                        }}
                        pageColumns={layout.layouts.length > 1 ? pageColumns : null}
                        onTogglePageColumns={togglePageColumns}
                        spreadCover={spreadCover}
                        onToggleSpreadCover={toggleSpreadCover}
                    />
                    {layout.layouts.length > 1 ? (
                        <Pager layout={layout} viewportSize={viewportSize} onTurn={turnPage} />
                    ) : null}
                </>
            )}
        </div>
    );
};

/**
 * View-only members get no Toolbar, but the fingering diagram is FOR students —
 * this pill is their way into the (read-only, never-writes) selection tool.
 */
const ReadOnlyFingeringToggle = () => {
    const tool = useViewerStore((s) => s.tool);
    const active = tool === 'fingering';
    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(0.75rem+var(--safe-bottom))] z-20 flex justify-center sm:bottom-auto sm:top-3"
        >
            <button
                type="button"
                aria-pressed={active}
                title={active ? 'Stop selecting' : 'Fingering — drag over a chord or phrase'}
                onClick={() => useViewerStore.getState().setTool(active ? 'pan' : 'fingering')}
                className={`pointer-events-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm shadow-lg backdrop-blur transition ${
                    active
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-stone-200 bg-white/95 text-stone-600 hover:bg-white'
                }`}
            >
                <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    aria-hidden
                >
                    <rect x="4" y="5" width="16" height="14" rx="1.5" />
                    <path strokeLinecap="round" strokeWidth="2.5" d="M9.33 5.5v6M14.67 5.5v6" />
                </svg>
                Fingering
            </button>
        </div>
    );
};

/**
 * Floating pager: previous / "p. 3 / 12" / next. Big round targets so a
 * player can hit them without looking away from the music. Reads the
 * debounced focused page, which is also what decides the ends.
 */
const Pager = ({
    layout,
    viewportSize,
    onTurn,
}: {
    layout: DocumentLayout;
    viewportSize: ViewportSize;
    onTurn: (direction: -1 | 1) => void;
}) => {
    const pageIndex = useViewerStore((s) => s.focusedPageIndex);
    const view = useViewerStore((s) => s.view);
    const pageCount = layout.layouts.length;
    const canTurn = (direction: -1 | 1) =>
        pageTurnView(view, layout, pageIndex, direction, viewportSize.width, viewportSize.height) !== null;
    return (
        <div
            data-ui-overlay
            className="absolute left-2 top-2 z-10 flex items-center gap-1 sm:bottom-[calc(1rem+var(--safe-bottom))] sm:left-4 sm:top-auto"
        >
            <button
                type="button"
                aria-label="Previous page"
                disabled={!canTurn(-1)}
                onClick={() => onTurn(-1)}
                className={pagerButtonClassName}
            >
                <ChevronLeftIcon size={20} />
            </button>
            <span className="rounded-full border border-stone-200 bg-white/95 px-2.5 py-1 text-xs font-medium tabular-nums text-stone-600 shadow-sm">
                p. {Math.min(pageIndex + 1, pageCount)} / {pageCount}
            </span>
            <button
                type="button"
                aria-label="Next page"
                disabled={!canTurn(1)}
                onClick={() => onTurn(1)}
                className={pagerButtonClassName}
            >
                <ChevronRightIcon size={20} />
            </button>
        </div>
    );
};

const roundControlClassName =
    'flex h-11 w-11 items-center justify-center rounded-full bg-white text-stone-700 shadow-md transition active:bg-stone-100';

const pagerButtonClassName = `${roundControlClassName} disabled:opacity-40 disabled:active:bg-white`;

const ZoomControls = ({
    onZoomBy,
    pageColumns,
    onTogglePageColumns,
    spreadCover,
    onToggleSpreadCover,
}: {
    onZoomBy: (factor: number) => void;
    /** Null hides the one/two-page toggle (single-page documents). */
    pageColumns: 1 | 2 | null;
    onTogglePageColumns: () => void;
    spreadCover: boolean;
    onToggleSpreadCover: () => void;
}) => {
    return (
        <div
            data-ui-overlay
            // Phones: top-right, clear of the bottom toolbar whose wrapped rows
            // would otherwise cover the zoom buttons. Larger screens: bottom-right.
            className="absolute right-2 top-2 flex flex-col gap-2 sm:bottom-[calc(1rem+var(--safe-bottom))] sm:right-4 sm:top-auto"
        >
            {pageColumns !== null ? (
                <button
                    type="button"
                    aria-label={pageColumns === 2 ? 'Show one page' : 'Show two pages side by side'}
                    title={pageColumns === 2 ? 'Show one page' : 'Show two pages side by side'}
                    aria-pressed={pageColumns === 2}
                    onClick={onTogglePageColumns}
                    className={`${roundControlClassName} aria-pressed:bg-accent-soft aria-pressed:text-accent`}
                >
                    <Columns2Icon size={20} />
                </button>
            ) : null}
            {pageColumns === 2 ? (
                <button
                    type="button"
                    aria-label="Cover page first"
                    title="Show the first page alone, so spreads pair 2|3"
                    aria-pressed={spreadCover}
                    onClick={onToggleSpreadCover}
                    className={`${roundControlClassName} aria-pressed:bg-accent-soft aria-pressed:text-accent`}
                >
                    <CoverPageIcon size={20} />
                </button>
            ) : null}
            <button type="button" aria-label="Zoom in" onClick={() => onZoomBy(1.25)} className={roundControlClassName}>
                <ZoomInIcon size={20} />
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => onZoomBy(0.8)} className={roundControlClassName}>
                <ZoomOutIcon size={20} />
            </button>
        </div>
    );
};
