import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router';

import { displayNameOf, isRegisteredSession, useSession } from '@/features/auth/session';
import { UpgradeBanner } from '@/features/auth/UpgradeBanner';
import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import { makeCloudClassifyFn } from '@/features/import/analyzeApi';
import { buildCleanFn } from '@/features/import/cleanReplace';
import { ImportScanButton } from '@/features/import/ImportScanButton';
import { UPLOAD_ACCEPT, prepareUploadFile } from '@/features/import/prepareUpload';
import {
    ensureDocumentPageCount,
    fetchDocument,
    fetchMyRole,
    isCloudDocId,
    loadDocumentBytes,
    loadDocumentOffline,
} from '@/features/library/documentsService';
import { TransportBar } from '@/features/playback/TransportBar';
import { usePlayback } from '@/features/playback/usePlayback';
import { useScoreAnalysis } from '@/features/playback/useScoreAnalysis';
import { NotesPanel } from '@/features/notes/NotesPanel';
import { ShareDialog } from '@/features/share/ShareDialog';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { getLocalDoc, localDocId, putLocalDoc } from '@/lib/localDocs';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { SyncStatus } from '@/sync/syncEngine';
import type { PresencePeer } from '@/sync/wire';
import type { DocumentRow, MemberRole } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { buttonClassName, linkClassName } from '@/ui/classNames';

export const ViewerPage = () => {
    const { documentId } = useParams<{ documentId: string }>();
    if (!documentId) {
        return null;
    }
    return isCloudDocId(documentId) ? <CloudViewer docId={documentId} /> : <LocalViewer docId={documentId} />;
};

// ---------------------------------------------------------------------------
// Cloud documents: auth-gated, role-aware, synced.

/** How long a warm open waits for the server to confirm the cached role. */
const PROVISIONAL_ROLE_TIMEOUT_MS = 4000;

interface CloudDocState {
    doc: DocumentRow;
    role: MemberRole | null;
    bytes: ArrayBuffer;
    /**
     * A warm Dexie paint the server hasn't confirmed yet. The cached role may
     * overstate today's access, and RLS discards (not retries) an annotation
     * flushed under a role that turned out read-only — so writes and sync wait
     * until the fetch settles. Cleared by the server response, or by the
     * offline fallback, where the last-known role is the best truth available.
     */
    provisional?: boolean;
}

const CloudViewer = ({ docId }: { docId: string }) => {
    const { session, loading } = useSession();
    const [state, setState] = useState<CloudDocState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
    const [shareOpen, setShareOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const [peers, setPeers] = useState<PresencePeer[]>([]);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const [staleBytes, setStaleBytes] = useState(false);

    const userId = session?.user.id;

    const onStoreReady = useCallback((store: AnnotationStore) => setAnnotationStore(store), []);

    /** Another member replaced the PDF (import cleanup) — offer a refresh. */
    const onDocReplaced = useCallback((contentRev: number) => {
        setState((prev) => {
            if (prev && contentRev > (prev.doc.content_rev ?? 0)) {
                setStaleBytes(true);
            }
            return prev;
        });
    }, []);

    const refreshBytes = useCallback(async () => {
        const doc = await fetchDocument(docId);
        if (!doc) {
            return;
        }
        const bytes = await loadDocumentBytes(doc);
        setState((prev) => (prev ? { ...prev, doc, bytes } : prev));
        setStaleBytes(false);
    }, [docId]);

    // Play-along: analysis lifecycle + the audio engine for this document.
    const { state: analysisState, generate, applyBroadcast } = useScoreAnalysis(docId, true);
    const { playbackFeature, getEngine, warning, dismissWarning } = usePlayback(docId, analysisState);

    useEffect(() => {
        let cancelled = false;
        let provisionalTimer: ReturnType<typeof setTimeout> | undefined;
        (async () => {
            // No session yet: on an SPA navigation the session is known
            // synchronously, and a cold start resolves it from local storage in
            // milliseconds — the effect re-runs then. Painting earlier would
            // show cached scores to a browser that turns out to be signed out.
            if (!userId) {
                return;
            }

            // Warm open: paint from Dexie immediately (provisionally — see
            // CloudDocState), then refresh in the background.
            const offline = await loadDocumentOffline(docId).catch(() => null);
            if (!cancelled && offline) {
                setState({ doc: offline.doc, role: offline.role, bytes: offline.bytes, provisional: true });
                // A confirm request that stalls without failing (captive portal,
                // half-open TCP) would otherwise hold the score read-only for as
                // long as the tab lives. Past this window the open degrades to
                // the offline contract: last-known role, edits repaired at flush.
                provisionalTimer = setTimeout(() => {
                    setState((prev) => (prev?.provisional ? { ...prev, provisional: false } : prev));
                }, PROVISIONAL_ROLE_TIMEOUT_MS);
            }

            try {
                const [doc, role] = await Promise.all([fetchDocument(docId), fetchMyRole(docId, userId)]);
                // The role is truth from here — confirm the warm paint now
                // rather than holding the pen hostage to the bytes download
                // and page-count parse still ahead (which can take seconds on
                // a replaced PDF, long enough for the timer to promote the
                // cached role instead of this one).
                clearTimeout(provisionalTimer);
                if (!doc) {
                    throw new Error('Score not found — it may have been deleted, or your access was revoked.');
                }
                if (!cancelled) {
                    setState((prev) => (prev?.provisional ? { ...prev, role, provisional: false } : prev));
                }
                const bytes = await loadDocumentBytes(doc);
                const withPages = await ensureDocumentPageCount(doc, bytes).catch(() => doc);
                if (!cancelled) {
                    // Same document at the same content revision as the warm
                    // paint → keep the old buffer: PdfProvider re-parses (and
                    // blanks every page) on buffer identity, not content.
                    setState((prev) => ({
                        doc: withPages,
                        role,
                        bytes:
                            prev &&
                            prev.doc.id === withPages.id &&
                            (prev.doc.content_rev ?? 0) >= (withPages.content_rev ?? 0)
                                ? prev.bytes
                                : bytes,
                    }));
                    setLoadError(null);
                }
            } catch (err) {
                clearTimeout(provisionalTimer);
                if (cancelled) {
                    return;
                }
                // No network? A previously-cached score still opens (plan §offline).
                if (offline) {
                    setState({ doc: offline.doc, role: offline.role, bytes: offline.bytes });
                    return;
                }
                const fallback = await loadDocumentOffline(docId).catch(() => null);
                if (fallback) {
                    setState({ doc: fallback.doc, role: fallback.role, bytes: fallback.bytes });
                } else {
                    setLoadError(err instanceof Error ? err.message : 'Could not open this score.');
                }
            }
        })();

        // Resist storage eviction — annotations and cached scores must survive
        // Safari's cleanup between rehearsals (plan §offline).
        void navigator.storage?.persist?.().catch(() => undefined);

        return () => {
            cancelled = true;
            clearTimeout(provisionalTimer);
        };
    }, [docId, userId]);

    const onStatus = useCallback((status: SyncStatus) => setSyncStatus(status), []);
    const onPeers = useCallback((next: PresencePeer[]) => setPeers(next), []);
    // Referentially stable — the review panel's scan effect depends on it.
    const classify = useMemo(() => makeCloudClassifyFn(docId), [docId]);

    // ?import=1 (post-upload prompt) auto-opens the import panel once; the
    // param is consumed so a refresh doesn't rescan (the AI pass costs money).
    const [searchParams, setSearchParams] = useSearchParams();
    const [autoOpenImport] = useState(() => searchParams.get('import') === '1');
    useEffect(() => {
        if (searchParams.get('import') === '1') {
            const next = new URLSearchParams(searchParams);
            next.delete('import');
            setSearchParams(next, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    if (!loading && !session) {
        return <Navigate to="/" replace />;
    }
    if (loadError) {
        const escapeTo = isRegisteredSession(session) ? '/library' : '/';
        const escapeLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';
        return (
            <main className="landing-page flex min-h-full flex-col items-center justify-center gap-3 p-8">
                <ErrorText className="max-w-md text-center">{loadError}</ErrorText>
                <Link to={escapeTo} className={linkClassName}>
                    {escapeLabel}
                </Link>
            </main>
        );
    }
    if (!state) {
        return (
            <main className="flex min-h-full items-center justify-center p-8">
                <LoadingText>Opening score…</LoadingText>
            </main>
        );
    }

    // Session may still be resolving on a warm Dexie open — paint the PDF anyway.
    const resolvedUserId = userId ?? session?.user.id ?? '';
    // Past the plan's score cap. RLS refuses every annotation write on an archived
    // score (annotations_insert/annotations_update both test document_is_archived),
    // and a refusal is not transient, so the sync engine discards the op — a whole
    // lesson's marks drawn and silently dropped. Role alone would say `owner` here:
    // the archive is a billing state, not a membership one. loadDocumentBytes keeps
    // CachedPdf.archivedAt current for exactly this, so the offline open (which
    // synthesizes its row from the cache) reads it too.
    const archived = state.doc.archived_at !== null;
    const readOnly =
        archived ||
        (state.role !== 'owner' && state.role !== 'editor') ||
        !resolvedUserId ||
        state.provisional === true;
    const backTo = isRegisteredSession(session) ? '/library' : '/';
    const backLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';

    return (
        <div className="fixed inset-0 flex flex-col">
            <ViewerHeader backTo={backTo} backLabel={backLabel} title={state.doc.title}>
                <PresenceBar peers={peers} selfUserId={resolvedUserId} />
                <SyncDot status={syncStatus} />
                {archived ? (
                    <span title="Read-only — over your plan’s score limit">
                        <Badge tone="warn">Archived</Badge>
                    </span>
                ) : readOnly ? (
                    <Badge>view only</Badge>
                ) : null}
                {annotationStore && state.role === 'owner' ? (
                    <ImportScanButton
                        store={annotationStore}
                        docId={docId}
                        bytes={state.bytes}
                        classify={classify}
                        includeBornDigital
                        clean={buildCleanFn(state.doc, state.bytes, (updated, newBytes) => {
                            setState((prev) => (prev ? { ...prev, doc: updated, bytes: newBytes } : prev));
                        })}
                        autoOpen={autoOpenImport}
                    />
                ) : null}
                {annotationStore ? <LessonHistoryButton store={annotationStore} canRestore={!readOnly} /> : null}
                {/*
                  Shown to everyone on the score, not just the owner. Whether a
                  member has anything to read would take a query to know, and
                  hiding the control until then makes it flicker in; opening it to
                  "no notes yet" costs a student nothing and tells them where the
                  notes will appear when there are some.
                */}
                <button
                    type="button"
                    title="Practice notes — a journal by lesson day"
                    onClick={() => setNotesOpen(true)}
                    className={buttonClassName('ghost', 'sm')}
                >
                    Notes
                </button>
                {/* Export loads from Dexie on demand — no third live ArrayBuffer for the menu. */}
                <ShareExportMenu docId={docId} title={state.doc.title} />
                {state.role === 'owner' ? (
                    <Button size="sm" onClick={() => setShareOpen(true)}>
                        Invite
                    </Button>
                ) : null}
            </ViewerHeader>
            {session?.user.is_anonymous ? <UpgradeBanner /> : null}
            {staleBytes ? (
                <div
                    className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2"
                    role="status"
                >
                    <p className="text-sm text-amber-900">
                        The score file was updated (existing marks were made editable).
                    </p>
                    <Button size="sm" variant="secondary" onClick={() => void refreshBytes()}>
                        Show the cleaned pages
                    </Button>
                </div>
            ) : null}
            <div className="min-h-0 flex-1">
                <PdfProvider data={state.bytes}>
                    <PdfViewport
                        key={docId}
                        docId={docId}
                        readOnly={readOnly}
                        onStoreReady={onStoreReady}
                        playback={playbackFeature}
                        sync={
                            // Not while provisional: the engine would start,
                            // then tear down and restart when the confirmed
                            // role lands a beat later.
                            resolvedUserId && !state.provisional
                                ? {
                                      userId: resolvedUserId,
                                      name: displayNameOf(session),
                                      isAnonymous: Boolean(session?.user.is_anonymous),
                                      canWrite: !readOnly,
                                      onStatus,
                                      onPeers,
                                      onDocReplaced,
                                      onScoreAnalysis: applyBroadcast,
                                  }
                                : undefined
                        }
                    />
                </PdfProvider>
            </div>
            <TransportBar
                state={analysisState}
                role={state.role}
                onGenerate={() => void generate()}
                getEngine={getEngine}
                pageCount={state.doc.page_count}
                warning={warning}
                onDismissWarning={dismissWarning}
            />
            {shareOpen && resolvedUserId ? (
                <ShareDialog docId={docId} userId={resolvedUserId} onClose={() => setShareOpen(false)} />
            ) : null}
            {notesOpen ? (
                <NotesPanel
                    documentId={docId}
                    role={state.role === 'owner' ? 'owner' : 'member'}
                    onClose={() => setNotesOpen(false)}
                />
            ) : null}
        </div>
    );
};

const SyncDot = ({ status }: { status: SyncStatus }) => {
    const styles: Record<SyncStatus, { dot: string; short: string; label: string }> = {
        synced: { dot: 'bg-emerald-500', short: 'Synced', label: 'Synced' },
        syncing: { dot: 'bg-amber-400 animate-pulse', short: 'Syncing…', label: 'Syncing…' },
        offline: { dot: 'bg-stone-400', short: 'Offline', label: 'Offline — changes saved on this device' },
        error: { dot: 'bg-red-500', short: 'Sync error', label: 'Sync error — retrying' },
    };
    const { dot, short, label } = styles[status];
    return (
        <span title={label} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dot}`} />
            <span className="sr-only whitespace-nowrap text-xs text-stone-500 md:not-sr-only">{short}</span>
        </span>
    );
};

// ---------------------------------------------------------------------------
// Local documents: opened from disk, annotations on-device only.

const LocalViewer = ({ docId }: { docId: string }) => {
    const [, forceRender] = useState(0);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const [reopenError, setReopenError] = useState<string | null>(null);
    const bytes = getLocalDoc(docId);

    const onStoreReady = useCallback((store: AnnotationStore) => setAnnotationStore(store), []);

    const reopenFile = useCallback(
        async (picked: File) => {
            setReopenError(null);
            try {
                // Image conversion is byte-deterministic, so re-opening the
                // same image file reproduces the same content-hash id.
                const { file } = await prepareUploadFile(picked);
                const buffer = await file.arrayBuffer();
                const id = await localDocId(buffer);
                putLocalDoc(id, buffer);
                if (id === docId) {
                    forceRender((n) => n + 1);
                } else {
                    // Different file than the one this URL refers to — open it under its own id.
                    window.location.assign(`/doc/${id}`);
                }
            } catch (err) {
                setReopenError(err instanceof Error ? err.message : 'Could not open that file.');
            }
        },
        [docId],
    );

    if (!bytes) {
        return (
            <main className="landing-page flex min-h-full flex-col items-center justify-center p-8">
                <EmptyState
                    title="Re-open this score"
                    body="This score isn't loaded in this session. Re-open the same file to continue — your annotations are saved on this device."
                >
                    <label className={buttonClassName('primary', 'md')}>
                        Re-open file
                        <input
                            type="file"
                            accept={UPLOAD_ACCEPT}
                            className="hidden"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                    void reopenFile(file);
                                }
                            }}
                        />
                    </label>
                    {reopenError ? <ErrorText>{reopenError}</ErrorText> : null}
                    <Link to="/" className={linkClassName}>
                        Back to home
                    </Link>
                </EmptyState>
            </main>
        );
    }

    return (
        <div className="fixed inset-0 flex flex-col">
            <ViewerHeader backTo="/" backLabel="Back to home" title="Local score">
                <Badge>this device only</Badge>
                {annotationStore ? (
                    <ImportScanButton
                        store={annotationStore}
                        docId={docId}
                        bytes={bytes}
                        classify={null}
                        includeBornDigital={false}
                        clean={null}
                    />
                ) : null}
                {annotationStore ? <LessonHistoryButton store={annotationStore} canRestore /> : null}
                <ShareExportMenu docId={docId} bytes={bytes} title="Score" />
            </ViewerHeader>
            <div className="min-h-0 flex-1">
                <PdfProvider data={bytes}>
                    <PdfViewport key={docId} docId={docId} onStoreReady={onStoreReady} />
                </PdfProvider>
            </div>
        </div>
    );
};
