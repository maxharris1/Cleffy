import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';

import { displayNameOf, isRegisteredSession, userTypeOf, useSession } from '@/features/auth/session';
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
    prefetchDocumentBytes,
    purgeLocalDocument,
} from '@/features/library/documentsService';
import { removeCachedLibraryDocument } from '@/features/library/libraryBootstrap';
import { usePlayback } from '@/features/playback/usePlayback';
import { useScoreAnalysis } from '@/features/playback/useScoreAnalysis';
import { NotesPanel } from '@/features/notes/NotesPanel';
import { ShareDialog } from '@/features/share/ShareDialog';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { ScoreSourceButton } from '@/features/viewer/ScoreSourceButton';
import { SyncHeldNotice, SyncRejectedNotice } from '@/features/viewer/SyncRejectedNotice';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { features } from '@/lib/features';
import { getLocalDoc, localDocId, putLocalDoc } from '@/lib/localDocs';
import { perfMark } from '@/lib/perf';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { SyncHold, SyncRejection, SyncStatus } from '@/sync/syncEngine';
import type { PresencePeer } from '@/sync/wire';
import type { DocumentRow, MemberRole } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { buttonClassName, linkClassName } from '@/ui/classNames';
import { MusicIcon } from '@/ui/icons';

/**
 * Play-along's transport loads on first open, and only in a build that ships
 * the feature — with VITE_FEATURE_PLAYALONG off the chunk is never requested.
 */
const TransportBar = lazy(() => import('@/features/playback/TransportBar').then((m) => ({ default: m.TransportBar })));

/**
 * What a confirmed row contributes to a cache-painted one before (or instead
 * of) the full swap: the archive state, and the provenance the offline row
 * cannot carry (the viewer's Source button reads it).
 */
const confirmedMeta = (doc: DocumentRow) => ({
    archived_at: doc.archived_at,
    source_url: doc.source_url ?? null,
    source_filename: doc.source_filename ?? null,
    source_license: doc.source_license ?? null,
    source_attribution: doc.source_attribution ?? null,
});

export const ViewerPage = () => {
    const { documentId } = useParams<{ documentId: string }>();
    if (!documentId) {
        return null;
    }
    return isCloudDocId(documentId) ? <CloudViewer docId={documentId} /> : <LocalViewer docId={documentId} />;
};

// ---------------------------------------------------------------------------
// Cloud documents: auth-gated, role-aware, synced.

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

const isTransportFailure = (err: unknown): boolean => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true;
    }
    if (err instanceof TypeError) {
        return true;
    }
    return err instanceof Error && /failed to fetch/i.test(err.message);
};

/**
 * Shown when the server says this account can no longer see the score. Neutral
 * on purpose: deleting a score ends every membership too (the same broadcast
 * reaches members and the owner's own other tabs), and the client cannot tell
 * which happened.
 */
const ACCESS_REVOKED_MESSAGE = 'This score is no longer available to you — it was deleted, or your access was removed.';

/**
 * Why this account just lost the score in the open viewer, which decides what
 * happens once the viewport (and its sync engine) has unmounted:
 *  - 'removed' / 'denied': the server says no — purge, then explain.
 *  - 'left': the user chose to leave — purge, then go back to the library.
 */
type AccessLoss = 'removed' | 'denied' | 'left';

const CloudViewer = ({ docId }: { docId: string }) => {
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [state, setState] = useState<CloudDocState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
    /**
     * Marks whose change the server refused for good (rolled back) since the
     * last dismiss, tagged with the score they belong to: CloudViewer is not
     * keyed by docId, so a client-side switch to another score must not carry
     * this one's notice over.
     */
    const [rejected, setRejected] = useState<{ docId: string; ids: ReadonlySet<string> } | null>(null);
    const rejectedCount = rejected?.docId === docId ? rejected.ids.size : 0;
    /** Changes kept on this device because the score is archived (see SyncHold). */
    const [held, setHeld] = useState<{ docId: string; pendingMarks: number } | null>(null);
    const heldCount = held?.docId === docId ? held.pendingMarks : 0;
    const [shareOpen, setShareOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    // Play-along transport: hidden until the reader asks for it. Nothing about
    // the analysis starts on its own — Generate inside the panel is the only
    // thing that requests an OMR run.
    const [playAlongOpen, setPlayAlongOpen] = useState(false);
    const [peers, setPeers] = useState<PresencePeer[]>([]);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const [staleBytes, setStaleBytes] = useState(false);
    const [accessLoss, setAccessLoss] = useState<AccessLoss | null>(null);
    /** "Your access changed" banner after a live role change. */
    const [accessNotice, setAccessNotice] = useState<string | null>(null);
    const accessCheckInFlight = useRef(false);
    /** A change arrived while a check was running; that check may have read the role before it. */
    const accessRecheckPending = useRef(false);
    /** Latest state for the access re-check, which runs outside render. */
    const stateRef = useRef(state);
    useEffect(() => {
        stateRef.current = state;
    }, [state]);

    const userId = session?.user.id;

    /**
     * Re-read this account's role after the server said it may have changed
     * (membership broadcast, refused channel join, reconnect). The broadcast
     * payload is only a hint; PostgREST is checked per request, so its answer
     * is the truth. A transport failure changes nothing — the next event or
     * reconnect asks again.
     *
     * One check at a time, but an event that lands mid-check is never dropped:
     * the running check may have read the role just before that change
     * committed (editor, then viewer, in quick succession), so it is followed
     * by exactly one more.
     */
    const recheckAccess = useCallback(() => {
        if (!userId) {
            return;
        }
        if (accessCheckInFlight.current) {
            accessRecheckPending.current = true;
            return;
        }
        accessCheckInFlight.current = true;

        /** One read of the server's answer. Resolves true once access is gone (nothing left to re-check). */
        const checkOnce = async (): Promise<boolean> => {
            const [docResult, roleResult] = await Promise.allSettled([
                fetchDocument(docId),
                fetchMyRole(docId, userId),
            ]);
            if (docResult.status !== 'fulfilled') {
                return false;
            }
            const doc = docResult.value;
            if (!doc) {
                setState(null);
                setShareOpen(false);
                setLoadError(ACCESS_REVOKED_MESSAGE);
                setAccessLoss('removed');
                return true;
            }
            if (roleResult.status !== 'fulfilled') {
                return false;
            }
            const role = roleResult.value;
            const current = stateRef.current;
            // A provisional paint is confirmed by the load effect, not here.
            if (!current || current.provisional || current.role === role) {
                return false;
            }
            // Read-only follows from the new role, and the viewport restarts
            // sync with it — rejoining the channel, which is when Realtime
            // re-evaluates what this account may send.
            setState((prev) => (prev ? { ...prev, role, doc: { ...prev.doc, archived_at: doc.archived_at } } : prev));
            // A follow-up check compares against this role, not the one the
            // ref holds until the next commit.
            stateRef.current = { ...current, role };
            setAccessNotice(
                role === 'editor' || role === 'owner'
                    ? 'Your access changed: you can now edit this score.'
                    : 'Your access changed: you can now only view this score.',
            );
            return false;
        };

        void (async () => {
            try {
                for (;;) {
                    accessRecheckPending.current = false;
                    const gone = await checkOnce();
                    if (gone || !accessRecheckPending.current) {
                        break;
                    }
                }
            } finally {
                accessCheckInFlight.current = false;
                accessRecheckPending.current = false;
            }
        })();
    }, [docId, userId]);

    // Runs after the commit that dropped the viewport, so the sync engine has
    // already been stopped — and a stopped engine re-checks after each await,
    // so a pull that was mid-flight cannot write rows or a watermark back over
    // the purge.
    useEffect(() => {
        if (!accessLoss || !userId) {
            return;
        }
        let cancelled = false;
        void (async () => {
            await purgeLocalDocument(docId).catch(() => undefined);
            await removeCachedLibraryDocument(userId, docId).catch(() => undefined);
            if (!cancelled && accessLoss === 'left') {
                navigate(isRegisteredSession(session) ? '/library' : '/', { replace: true });
            }
        })();
        return () => {
            cancelled = true;
        };
        // Once per loss: the session object changing identity must not re-run it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accessLoss, docId, userId]);

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
        const bytes = await loadDocumentBytes(doc, { userId });
        setState((prev) => (prev ? { ...prev, doc, bytes } : prev));
        setStaleBytes(false);
    }, [docId, userId]);

    // Play-along: analysis lifecycle + the audio engine for this document.
    // Switched off for this release (src/lib/features.ts): a disabled analysis
    // stays 'unavailable' and never reads a status, polls, or requests an OMR
    // run, so usePlayback never has a score to build an engine (or fetch
    // samples) for.
    const playAlongEnabled = features.playalong;
    const { state: analysisState, generate, applyBroadcast } = useScoreAnalysis(docId, playAlongEnabled);
    const { playbackFeature, getEngine, warning, dismissWarning } = usePlayback(docId, analysisState);
    const analysisInFlight = analysisState.kind === 'pending' || analysisState.kind === 'processing';

    const togglePlayAlong = () => {
        if (playAlongOpen) {
            // Closing the panel takes its controls away — never leave audio
            // running with nothing on screen to stop it.
            getEngine()?.pause();
        }
        setPlayAlongOpen(!playAlongOpen);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            // No session yet: on an SPA navigation the session is known
            // synchronously, and a cold start resolves it from local storage in
            // milliseconds — the effect re-runs then. Painting earlier would
            // show cached scores to a browser that turns out to be signed out.
            if (!userId) {
                return;
            }

            // Warm open: paint from Dexie immediately (provisionally — see
            // CloudDocState), then refresh in the background. A hung confirm
            // stays read-only: lifting provisional on a timer would grant a
            // cached role the server never vouched for.
            // Prefetch leaves in the same tick as the Dexie read; a hit ignores
            // that download, a miss reuses it.
            const prefetch = prefetchDocumentBytes(docId);
            const offline = await loadDocumentOffline(docId, userId).catch(() => null);
            if (!cancelled && offline) {
                setState({ doc: offline.doc, role: offline.role, bytes: offline.bytes, provisional: true });
                perfMark('viewer-cache-paint');
            }

            const [docResult, roleResult] = await Promise.allSettled([
                fetchDocument(docId),
                fetchMyRole(docId, userId),
            ]);
            if (cancelled) {
                return;
            }

            if (docResult.status === 'fulfilled') {
                const confirmedDoc = docResult.value;
                if (!confirmedDoc) {
                    // The server ANSWERED, and the answer is no: deleted, or this
                    // account was never (or is no longer) a member. Drop the paint
                    // even if the role request rejected — a role throw must not
                    // keep another account's PDF on a shared device.
                    setState(null);
                    setLoadError('Score not found — it may have been deleted, or your access was revoked.');
                    // This account's own cached copy goes too: an owner who took
                    // the score back must not leave it readable offline. Only
                    // when the cache row was this account's — another account's
                    // copy on a shared device is not ours to throw away.
                    if (offline) {
                        setAccessLoss('denied');
                    }
                    return;
                }
                const confirmedRole = roleResult.status === 'fulfilled' ? roleResult.value : null;
                if (roleResult.status === 'fulfilled') {
                    setState((prev) =>
                        prev?.provisional
                            ? {
                                  ...prev,
                                  doc: { ...prev.doc, ...confirmedMeta(confirmedDoc) },
                                  role: confirmedRole,
                                  provisional: false,
                              }
                            : prev,
                    );
                    perfMark('viewer-confirmed');
                }
                try {
                    const bytes = await loadDocumentBytes(confirmedDoc, {
                        preloaded: offline
                            ? {
                                  bytes: offline.bytes,
                                  contentRev: offline.doc.content_rev ?? 0,
                                  archivedAt: offline.doc.archived_at,
                              }
                            : undefined,
                        prefetch: offline ? undefined : prefetch,
                        userId,
                    });
                    const withPages = await ensureDocumentPageCount(confirmedDoc, bytes).catch(() => confirmedDoc);
                    if (!cancelled) {
                        setState((prev) => ({
                            doc: withPages,
                            role: confirmedRole ?? prev?.role ?? 'viewer',
                            bytes:
                                prev &&
                                prev.doc.id === withPages.id &&
                                (prev.doc.content_rev ?? 0) >= (withPages.content_rev ?? 0)
                                    ? prev.bytes
                                    : bytes,
                            provisional: roleResult.status !== 'fulfilled' ? true : undefined,
                        }));
                        setLoadError(null);
                    }
                } catch (err) {
                    if (cancelled) {
                        return;
                    }
                    if (offline) {
                        setState({
                            doc: { ...offline.doc, ...confirmedMeta(confirmedDoc) },
                            role: confirmedRole ?? offline.role,
                            bytes: offline.bytes,
                            provisional: roleResult.status !== 'fulfilled' ? true : undefined,
                        });
                        return;
                    }
                    setLoadError(err instanceof Error ? err.message : 'Could not open this score.');
                }
                return;
            }

            const bothTransport =
                isTransportFailure(docResult.reason) &&
                roleResult.status === 'rejected' &&
                isTransportFailure(roleResult.reason);
            if (offline && bothTransport && offline.cachedRole) {
                setState({ doc: offline.doc, role: offline.role, bytes: offline.bytes });
                return;
            }
            if (offline) {
                // Stay provisional: a PostgREST throw is not "the server never
                // answered", and a missing stored role must not grant writes.
                return;
            }
            setLoadError(docResult.reason instanceof Error ? docResult.reason.message : 'Could not open this score.');
        })();

        // Resist storage eviction — annotations and cached scores must survive
        // Safari's cleanup between rehearsals (plan §offline).
        void navigator.storage?.persist?.().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [docId, userId]);

    const onStatus = useCallback((status: SyncStatus) => setSyncStatus(status), []);
    const onRejected = useCallback(
        (rejection: SyncRejection) =>
            setRejected((prev) => ({
                docId,
                ids: new Set(prev?.docId === docId ? prev.ids : []).add(rejection.annotationId),
            })),
        [docId],
    );
    const onHeld = useCallback((hold: SyncHold) => setHeld({ docId, pendingMarks: hold.pendingMarks }), [docId]);
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
    // A roster student's scores are their teacher's to assign and withdraw
    // (leave_document refuses an assigned score), so they get no Leave.
    const canLeave = userTypeOf(session) !== 'student';

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
                {annotationStore && !state.provisional && state.role === 'owner' ? (
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
                {playAlongEnabled && analysisState.kind !== 'unavailable' ? (
                    <button
                        type="button"
                        title={
                            playAlongOpen
                                ? 'Hide the play-along panel'
                                : 'Play-along — listen to the score, or generate it'
                        }
                        aria-label="Play-along"
                        aria-expanded={playAlongOpen}
                        aria-controls="play-along-bar"
                        onClick={togglePlayAlong}
                        className={buttonClassName(
                            'ghost',
                            'sm',
                            'relative aria-expanded:bg-accent-soft aria-expanded:text-accent',
                        )}
                    >
                        <MusicIcon size={16} />
                        <span className="hidden sm:inline">Play-along</span>
                        {analysisInFlight ? (
                            <span
                                aria-hidden="true"
                                title="Analyzing score…"
                                className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent"
                            />
                        ) : null}
                    </button>
                ) : null}
                {/* IMSLP source, license and credits — for everyone on the score (CC-BY). */}
                <ScoreSourceButton doc={state.doc} />
                {/*
                  Export loads from Dexie on demand — no third live ArrayBuffer for
                  the menu. The row lets it download the PDF when the cache has none.
                */}
                {!state.provisional ? <ShareExportMenu docId={docId} doc={state.doc} title={state.doc.title} /> : null}
                {!state.provisional && state.role === 'owner' ? (
                    <Button size="sm" onClick={() => setShareOpen(true)}>
                        Invite
                    </Button>
                ) : !state.provisional && state.role && canLeave ? (
                    // Members get the same dialog, minus the owner's controls:
                    // who else is here (editors) and a way to leave.
                    <button
                        type="button"
                        title="Who this score is shared with, and leaving it"
                        onClick={() => setShareOpen(true)}
                        className={buttonClassName('ghost', 'sm')}
                    >
                        Sharing
                    </button>
                ) : null}
            </ViewerHeader>
            {session?.user.is_anonymous ? <UpgradeBanner /> : null}
            {accessNotice ? (
                <div
                    className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2"
                    role="status"
                >
                    <p className="flex-1 text-sm text-amber-900">{accessNotice}</p>
                    <Button size="sm" variant="ghost" onClick={() => setAccessNotice(null)}>
                        Dismiss
                    </Button>
                </div>
            ) : null}
            <SyncRejectedNotice count={rejectedCount} onDismiss={() => setRejected(null)} />
            <SyncHeldNotice count={heldCount} />
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
                        // Playhead, loop tint and tap-to-seek live only while
                        // the transport is on screen to drive them.
                        playback={playAlongEnabled && playAlongOpen ? playbackFeature : undefined}
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
                                      isOwner: state.role === 'owner',
                                      onStatus,
                                      onRejected,
                                      onHeld,
                                      onPeers,
                                      onDocReplaced,
                                      // A broadcast from a build with play-along on
                                      // must not wake the analysis (a 'ready'
                                      // would fetch the ScoreData) in this one.
                                      onScoreAnalysis: playAlongEnabled ? applyBroadcast : undefined,
                                      onMembershipChanged: recheckAccess,
                                  }
                                : undefined
                        }
                    />
                </PdfProvider>
            </div>
            {playAlongEnabled && playAlongOpen ? (
                <div id="play-along-bar" className="flex-none">
                    <Suspense fallback={null}>
                        <TransportBar
                            state={analysisState}
                            role={state.role}
                            onGenerate={() => void generate()}
                            getEngine={getEngine}
                            pageCount={state.doc.page_count}
                            warning={warning}
                            onDismissWarning={dismissWarning}
                        />
                    </Suspense>
                </div>
            ) : null}
            {shareOpen && resolvedUserId && state.role ? (
                <ShareDialog
                    docId={docId}
                    userId={resolvedUserId}
                    role={state.role}
                    canLeave={canLeave}
                    isGuest={Boolean(session?.user.is_anonymous)}
                    onClose={() => setShareOpen(false)}
                    onLeft={() => {
                        setShareOpen(false);
                        setState(null);
                        setAccessLoss('left');
                    }}
                />
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
                <ShareExportMenu docId={docId} bytes={bytes} title="Score" localOnly />
            </ViewerHeader>
            <div className="min-h-0 flex-1">
                <PdfProvider data={bytes}>
                    <PdfViewport key={docId} docId={docId} onStoreReady={onStoreReady} />
                </PdfProvider>
            </div>
        </div>
    );
};
