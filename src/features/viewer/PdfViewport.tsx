import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    clampScroll,
    computeDocumentLayout,
    fitPageWidthScale,
    focusedPageIndex,
    visiblePageRange,
    zoomAt,
    type DocumentLayout,
} from '@/features/viewer/geometry';
import { CanvasRegistry } from '@/features/viewer/ink/CanvasRegistry';
import { GestureController } from '@/features/viewer/ink/GestureController';
import { InkController, type TextIntent } from '@/features/viewer/ink/InkController';
import { TextEditorOverlay } from '@/features/viewer/ink/TextEditorOverlay';
import { PageView } from '@/features/viewer/pdf/PageView';
import { usePdf } from '@/features/viewer/pdf/pdfContext';
import { Toolbar } from '@/features/viewer/toolbar/Toolbar';
import { getSupabase } from '@/lib/supabase';
import { peerColor } from '@/lib/colors';
import { AnnotationStore } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { DocRealtimeChannel } from '@/sync/realtimeChannel';
import { createSupabaseAnnotationsApi, SyncEngine, type SyncStatus } from '@/sync/syncEngine';
import type { PresencePeer } from '@/sync/wire';
import { useViewerStore } from '@/state/store';
import { isTextPayload } from '@/types/models';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ZoomInIcon, ZoomOutIcon } from '@/ui/icons';

/** Delay before re-rendering page bitmaps at a new zoom level (ms). */
const RENDER_SETTLE_MS = 200;

/** Default text-note size as a fraction of page width. */
const DEFAULT_TEXT_SIZE = 0.018;

interface ViewportSize {
    width: number;
    height: number;
}

export interface PdfViewportProps {
    docId: string;
    /** View-only role: hides editing UI and blocks the ink delegate. */
    readOnly?: boolean;
    /** Expose the live AnnotationStore to the parent (share/history chrome). */
    onStoreReady?: (store: AnnotationStore) => void;
    /** Present for cloud documents: enables the sync engine + realtime channel. */
    sync?: {
        userId: string;
        name: string;
        isAnonymous: boolean;
        canWrite: boolean;
        onStatus?: (status: SyncStatus) => void;
        onPeers?: (peers: PresencePeer[]) => void;
        /** Another member replaced the PDF bytes (smart-import cleanup). */
        onDocReplaced?: (contentRev: number) => void;
    };
}

/**
 * The scrollable, zoomable, annotatable stack of PDF pages. Owns the gesture +
 * ink wiring and page virtualization. Remount (key) per document.
 */
export const PdfViewport = ({ docId, readOnly = false, onStoreReady, sync }: PdfViewportProps) => {
    const { doc, pageSizes, status, error } = usePdf();
    const view = useViewerStore((s) => s.view);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
    const [renderScale, setRenderScale] = useState(view.scale);
    const [textIntent, setTextIntent] = useState<TextIntent | null>(null);
    const textIntentHandled = useRef(false);
    const didFitRef = useRef(false);

    const layout: DocumentLayout = useMemo(() => computeDocumentLayout(pageSizes), [pageSizes]);

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
    useEffect(() => {
        layoutRef.current = layout;
        viewportSizeRef.current = viewportSize;
        readOnlyRef.current = effectiveReadOnly;
    }, [layout, viewportSize, effectiveReadOnly]);

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
    const channelRef = useRef<DocRealtimeChannel | null>(null);

    // Track viewport size.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        const observer = new ResizeObserver(() => {
            setViewportSize({ width: el.clientWidth, height: el.clientHeight });
        });
        observer.observe(el);
        setViewportSize({ width: el.clientWidth, height: el.clientHeight });
        return () => observer.disconnect();
    }, []);

    // Fit the widest page to the viewport width once the document is ready.
    useEffect(() => {
        if (didFitRef.current || status !== 'ready' || viewportSize.width === 0 || layout.layouts.length === 0) {
            return;
        }
        didFitRef.current = true;
        const scale = fitPageWidthScale(layout, viewportSize.width);
        const fitted = clampScroll({ scale, scrollX: 0, scrollY: 0 }, layout, viewportSize.width, viewportSize.height);
        useViewerStore.getState().resetView(fitted);
        setRenderScale(scale);
    }, [status, viewportSize, layout]);

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
        });

        const clamp = (v: { scale: number; scrollX: number; scrollY: number }) =>
            clampScroll(v, layoutRef.current, viewportSizeRef.current.width, viewportSizeRef.current.height);

        const controller = new GestureController(el, {
            onPan: (dx, dy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX - dx, scrollY: v.scrollY - dy }));
            },
            onZoomBy: (factor, cx, cy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp(zoomAt(v, v.scale * factor, cx, cy)));
            },
            onWheelScroll: (dx, dy) => {
                const { view: v, setView } = useViewerStore.getState();
                setView(clamp({ ...v, scrollX: v.scrollX + dx, scrollY: v.scrollY + dy }));
            },
            onGestureEnd: () => {
                // Bitmap refresh is handled by the settle timer on scale change.
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
        };
    }, [
        annotationStore,
        registry,
        docId,
        syncUserId,
        syncName,
        syncIsAnonymous,
        syncCanWrite,
        syncOnStatus,
        syncOnPeers,
        syncOnDocReplaced,
    ]);

    // Presence: report the top visible page (debounced against scroll churn).
    useEffect(() => {
        const timer = setTimeout(() => {
            const range = visiblePageRange(view, viewportSize.height, layout.layouts, 0);
            channelRef.current?.setPage(Math.max(0, range.start));
            useViewerStore.getState().setFocusedPageIndex(focusedPageIndex(view, viewportSize.height, layout.layouts));
        }, 400);
        return () => clearTimeout(timer);
    }, [view, viewportSize.height, layout]);

    // Undo/redo keyboard shortcuts.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
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
    }, [annotationStore]);

    const commitText = (text: string) => {
        if (!textIntent || textIntentHandled.current) {
            return;
        }
        textIntentHandled.current = true;
        setTextIntent(null);
        const trimmed = text.trim();
        const { existing } = textIntent;
        if (existing) {
            if (!isTextPayload(existing.payload)) {
                return;
            }
            if (trimmed === '') {
                void annotationStore.delete(existing.id);
            } else if (trimmed !== existing.payload.text) {
                void annotationStore.update(existing.id, { payload: { ...existing.payload, text: trimmed } });
            }
            return;
        }
        if (trimmed === '') {
            return;
        }
        const now = new Date().toISOString();
        void annotationStore.create({
            id: crypto.randomUUID(),
            docId,
            page: textIntent.pageIndex,
            kind: 'text',
            color: useViewerStore.getState().color,
            payload: { x: textIntent.nx, y: textIntent.ny, text: trimmed, size: DEFAULT_TEXT_SIZE },
            createdBy: null,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            seq: 0,
        });
    };

    const pages = [];
    if (doc) {
        const range = visiblePageRange(view, viewportSize.height, layout.layouts);
        for (let i = range.start; i <= range.end; i++) {
            const pageLayout = layout.layouts[i];
            if (pageLayout) {
                pages.push(
                    <PageView
                        key={i}
                        doc={doc}
                        pageIndex={i}
                        layout={pageLayout}
                        scale={renderScale}
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
                    {!effectiveReadOnly && textIntent && textIntentLayout ? (
                        <TextEditorOverlay
                            intent={textIntent}
                            layout={textIntentLayout}
                            view={view}
                            onCommit={commitText}
                            onCancel={() => {
                                textIntentHandled.current = true;
                                setTextIntent(null);
                            }}
                        />
                    ) : null}
                    <ZoomControls
                        onZoomBy={(factor) => {
                            const { view: v, setView } = useViewerStore.getState();
                            const zoomed = zoomAt(v, v.scale * factor, viewportSize.width / 2, viewportSize.height / 2);
                            setView(clampScroll(zoomed, layout, viewportSize.width, viewportSize.height));
                        }}
                    />
                    {layout.layouts.length > 1 ? <PageChip pageCount={layout.layouts.length} /> : null}
                </>
            )}
        </div>
    );
};

/** Floating "p. 3 / 12" position chip — reads the debounced focused page. */
const PageChip = ({ pageCount }: { pageCount: number }) => {
    const pageIndex = useViewerStore((s) => s.focusedPageIndex);
    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute left-2 top-2 z-10 sm:bottom-[calc(1rem+var(--safe-bottom))] sm:left-4 sm:top-auto"
        >
            <span className="rounded-full border border-stone-200 bg-white/95 px-2.5 py-1 text-xs font-medium tabular-nums text-stone-600 shadow-sm">
                p. {Math.min(pageIndex + 1, pageCount)} / {pageCount}
            </span>
        </div>
    );
};

const ZoomControls = ({ onZoomBy }: { onZoomBy: (factor: number) => void }) => {
    return (
        <div
            data-ui-overlay
            className="absolute bottom-[calc(4.5rem+var(--safe-bottom))] right-4 flex flex-col gap-2 sm:bottom-[calc(1rem+var(--safe-bottom))]"
        >
            <button
                type="button"
                aria-label="Zoom in"
                onClick={() => onZoomBy(1.25)}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-stone-700 shadow-md transition active:bg-stone-100"
            >
                <ZoomInIcon size={20} />
            </button>
            <button
                type="button"
                aria-label="Zoom out"
                onClick={() => onZoomBy(0.8)}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-stone-700 shadow-md transition active:bg-stone-100"
            >
                <ZoomOutIcon size={20} />
            </button>
        </div>
    );
};
