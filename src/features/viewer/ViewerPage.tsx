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
    cacheDocumentBytes,
    cacheStreamedDocument,
    ensureDocumentPageCount,
    fetchDocument,
    fetchMyRole,
    isCloudDocId,
    loadDocumentBytes,
    loadDocumentOffline,
    loadDocumentSource,
    prefetchScoreUrl,
    purgeLocalDocument,
} from '@/features/library/documentsService';
import { removeCachedLibraryDocument } from '@/features/library/libraryBootstrap';
import { usePlayback } from '@/features/playback/usePlayback';
import { useScoreAnalysis } from '@/features/playback/useScoreAnalysis';
import { NotesPanel } from '@/features/notes/NotesPanel';
import { ShareDialog } from '@/features/share/ShareDialog';
import { signOutEndedStudent } from '@/features/student/endedSignIn';
import { fetchAccountDeleted, fetchSignInStillValid } from '@/features/student/studentApi';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider, type PdfSource, type StreamedPdfSource } from '@/features/viewer/pdf/PdfProvider';
import type { ProgressiveDownload } from '@/features/viewer/pdf/progressiveDownload';
import { ScoreSourceButton } from '@/features/viewer/ScoreSourceButton';
import { SyncHeldNotice, SyncRejectedNotice } from '@/features/viewer/SyncRejectedNotice';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { features } from '@/lib/features';
import { getLocalDoc, localDocId, putLocalDoc } from '@/lib/localDocs';
import { perfMark } from '@/lib/perf';
import { isTransportFailure, useOnline } from '@/lib/useOnline';
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

/**
 * A first open on this device: the score streams from a signed URL and shows
 * page 1 long before the file is in (PdfProvider). Carries what caching the
 * finished download needs.
 */
interface ScoreStream extends StreamedPdfSource {
    doc: DocumentRow;
    /** The role confirmed when the stream started, if any (see loadDocumentBytes' `role`). */
    role: MemberRole | undefined;
}

interface CloudDocState {
    doc: DocumentRow;
    role: MemberRole | null;
    /** What the viewer renders: the bytes, or a ScoreStream still downloading. */
    pdf: PdfSource;
    /**
     * The whole file (import scan, clean-up). Null while a first open is
     * still streaming; set, and cached for offline use, when it finishes.
     */
    bytes: ArrayBuffer | null;
    /**
     * No role to go on: a warm Dexie paint whose cache row stored none (a
     * score cached by an older build, or by a share link). Read-only, and no
     * sync, until the server says what this account may do — a guessed role
     * must never grant writes. Cleared by the server's answer.
     */
    provisional?: boolean;
    /**
     * Painted with the role this device stored the last time the server
     * vouched for it, and not re-confirmed on this visit yet. That role
     * applies at once — editing and sync start without waiting on a network
     * that may be minutes away, or absent — and the server's answer, whenever
     * it comes, replaces it (a lowered role turns the viewer read-only, and
     * the engine rolls back anything the server then refuses, saying so).
     * Owner and export chrome still wait for the answer.
     */
    unconfirmed?: boolean;
}

/** A first open while the browser is offline: there is nothing on this device to show. */
const OFFLINE_NO_COPY_MESSAGE =
    'You’re offline, and this score isn’t saved on this device yet. It will open when you reconnect.';
/**
 * A first open that never got an answer although the browser says it is
 * online (DNS, a blocker, an outage) — no 'online' event will come, so it is
 * retried on a timer.
 */
const UNREACHABLE_NO_COPY_MESSAGE =
    'Couldn’t reach Cleffy to open this score. Check your connection — we’ll keep trying.';
/** A first open the server failed (its "no" is the not-found message instead). */
const OPEN_FAILED_MESSAGE = 'Couldn’t open this score. Try again in a moment.';
/** Load errors that asking again can fix: they get Try again, and a timer. */
const RETRYABLE_OPEN_MESSAGES: ReadonlySet<string> = new Set([
    OFFLINE_NO_COPY_MESSAGE,
    UNREACHABLE_NO_COPY_MESSAGE,
    OPEN_FAILED_MESSAGE,
]);
const CONFIRM_RETRY_BASE_MS = 5000;
const CONFIRM_RETRY_MAX_MS = 60_000;

/** What a first open (nothing on this device) says when it failed. The raw text goes to the console. */
const firstOpenFailure = (err: unknown): string => {
    console.warn('Could not open the score', err);
    if (!isTransportFailure(err)) {
        return OPEN_FAILED_MESSAGE;
    }
    return navigator.onLine === false ? OFFLINE_NO_COPY_MESSAGE : UNREACHABLE_NO_COPY_MESSAGE;
};

const accessChangedNotice = (role: MemberRole | null): string =>
    role === 'editor' || role === 'owner'
        ? 'Your access changed: you can now edit this score.'
        : 'Your access changed: you can now only view this score.';

/**
 * Shown when the server says this account can no longer see the score. Neutral
 * on purpose: deleting a score ends every membership too (the same broadcast
 * reaches members and the owner's own other tabs), and the client cannot tell
 * which happened.
 */
const ACCESS_REVOKED_MESSAGE = 'This score is no longer available to you — it was deleted, or your access was removed.';

/** Shown for the moment it takes to sign out once the teacher ended this sign-in. */
const SIGN_IN_ENDED_MESSAGE = 'Your teacher changed your access. Signing you out…';

/**
 * Why this account just lost the score in the open viewer, which decides what
 * happens once the viewport (and its sync engine) has unmounted:
 *  - 'removed' / 'denied': the server says no — purge, then explain. For a
 *    roster student, asked once more first: their teacher archiving them or
 *    resetting their access reads exactly like an unassign here, and is 'ended'.
 *  - 'ended': the server ended this sign-in (a roster student's teacher) — sign
 *    out keeping what is queued on the device for the next sign-in, then say
 *    why on the student sign-in page. Nothing is purged. Unless the account
 *    was deleted with its teacher: then there is no next sign-in, and what it
 *    queued is discarded and said to be (endedSignIn.ts).
 *  - 'left': the user chose to leave — purge, then go back to the library.
 */
type AccessLoss = 'removed' | 'denied' | 'ended' | 'left';

const CloudViewer = ({ docId }: { docId: string }) => {
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [state, setState] = useState<CloudDocState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
    const online = useOnline();
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
            // A cache paint is confirmed by the load effect, not here.
            if (!current || current.provisional || current.unconfirmed || current.role === role) {
                return false;
            }
            // Read-only follows from the new role, and the viewport restarts
            // sync with it — rejoining the channel, which is when Realtime
            // re-evaluates what this account may send.
            setState((prev) => (prev ? { ...prev, role, doc: { ...prev.doc, archived_at: doc.archived_at } } : prev));
            // A follow-up check compares against this role, not the one the
            // ref holds until the next commit.
            stateRef.current = { ...current, role };
            setAccessNotice(accessChangedNotice(role));
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
            if (accessLoss === 'ended') {
                // Not gated on `cancelled`: the sign-out itself changes userId.
                // Asked before it, under the token that is still here: an
                // archived or reset account signs in again and uploads what is
                // queued; one deleted with its teacher never can.
                const accountDeleted = await fetchAccountDeleted().catch(() => false);
                const state = await signOutEndedStudent(accountDeleted);
                navigate('/student', { replace: true, state });
                return;
            }
            if (accessLoss !== 'left' && userTypeOf(session) === 'student') {
                const stillValid = await fetchSignInStillValid(null).catch(() => null);
                if (cancelled) {
                    return;
                }
                if (stillValid === false) {
                    setLoadError(SIGN_IN_ENDED_MESSAGE);
                    setAccessLoss('ended');
                    return;
                }
                if (stillValid === null) {
                    // Unanswered: keep what is here; opening it again asks again.
                    return;
                }
            }
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
        setState((prev) => (prev ? { ...prev, doc, pdf: bytes, bytes } : prev));
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

    /** The server confirmed doc + role for this score on this visit (see the 'online' re-check). */
    const confirmedFor = useRef<string | null>(null);
    /** Bumped to ask the server again — the browser came back online before it had answered. */
    const [confirmAttempt, setConfirmAttempt] = useState(0);
    /**
     * The last attempt ended without the server confirming doc + role: the
     * score is painted under the stored role (or read-only, with none) and
     * is asked about again on a backoff while online — see the retry effect.
     */
    const [awaitingServer, setAwaitingServer] = useState(false);
    /** Timed retries since the server last answered, for their backoff. */
    const confirmRetries = useRef(0);

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

            // A re-check after reconnecting keeps what is on screen: the same
            // bytes (a new buffer would reload the PDF) and the role in use.
            const current = stateRef.current?.doc.id === docId ? stateRef.current : null;

            // Warm open: paint from Dexie immediately with the role stored
            // there (see CloudDocState), then confirm in the background.
            // The signed URL for a cold open is minted in the same tick as the
            // Dexie read; a hit ignores it, a miss streams from it.
            const prefetch = current ? undefined : prefetchScoreUrl(docId);
            const offline = current ? null : await loadDocumentOffline(docId, userId).catch(() => null);
            if (!cancelled && offline) {
                setState({
                    doc: offline.doc,
                    role: offline.role,
                    pdf: offline.bytes,
                    bytes: offline.bytes,
                    ...(offline.cachedRole ? { unconfirmed: true } : { provisional: true }),
                });
                perfMark('viewer-cache-paint');
            }
            const held = current
                ? {
                      doc: current.doc,
                      bytes: current.bytes,
                      cachedRole: current.provisional ? null : current.role,
                  }
                : offline;

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
                    if (held) {
                        setAccessLoss('denied');
                    }
                    return;
                }
                const confirmedRole = roleResult.status === 'fulfilled' ? roleResult.value : null;
                if (roleResult.status === 'fulfilled') {
                    const before = stateRef.current;
                    if (
                        before?.doc.id === docId &&
                        confirmedFor.current !== docId &&
                        !before.provisional &&
                        before.role !== confirmedRole &&
                        (before.role === 'owner' || before.role === 'editor')
                    ) {
                        // The stored role was already in use (online or off);
                        // say why editing stopped.
                        setAccessNotice(accessChangedNotice(confirmedRole));
                    }
                    confirmedFor.current = docId;
                    confirmRetries.current = 0;
                    setAwaitingServer(false);
                    setState((prev) =>
                        prev?.doc.id === docId && (prev.provisional || prev.unconfirmed || prev.role !== confirmedRole)
                            ? {
                                  ...prev,
                                  doc: { ...prev.doc, ...confirmedMeta(confirmedDoc) },
                                  role: confirmedRole,
                                  provisional: undefined,
                                  unconfirmed: undefined,
                              }
                            : prev,
                    );
                    perfMark('viewer-confirmed');
                }
                // The role request failed: keep whatever role is in use (the
                // stored one, or none), still waiting on the server.
                if (roleResult.status === 'rejected') {
                    setAwaitingServer(true);
                }
                const pending = (prev: CloudDocState | null): Pick<CloudDocState, 'provisional' | 'unconfirmed'> =>
                    roleResult.status === 'fulfilled'
                        ? {}
                        : prev?.doc.id === docId && !prev.provisional
                          ? { unconfirmed: true }
                          : { provisional: true };
                // Stored with the bytes, so the next open without a network
                // knows what this account may do.
                const cacheRole = roleResult.status === 'fulfilled' ? (confirmedRole ?? undefined) : undefined;
                try {
                    // A re-check while this revision is still streaming in
                    // keeps that stream: there is nothing newer to load.
                    const streaming =
                        held !== null &&
                        held.bytes === null &&
                        (held.doc.content_rev ?? 0) >= (confirmedDoc.content_rev ?? 0);
                    const source = streaming
                        ? null
                        : await loadDocumentSource(confirmedDoc, {
                              preloaded: held?.bytes
                                  ? {
                                        bytes: held.bytes,
                                        contentRev: held.doc.content_rev ?? 0,
                                        archivedAt: held.doc.archived_at,
                                    }
                                  : undefined,
                              prefetch: held ? undefined : prefetch,
                              userId,
                              role: cacheRole,
                          });
                    // A streamed score's page count is backfilled when its
                    // download ends (onStreamComplete).
                    const withPages = source?.bytes
                        ? await ensureDocumentPageCount(confirmedDoc, source.bytes).catch(() => confirmedDoc)
                        : confirmedDoc;
                    if (!cancelled) {
                        const stream: ScoreStream | null = source?.url
                            ? { url: source.url, doc: withPages, role: cacheRole }
                            : null;
                        setState((prev) => {
                            const keep =
                                prev &&
                                prev.doc.id === withPages.id &&
                                (prev.doc.content_rev ?? 0) >= (withPages.content_rev ?? 0);
                            const next: Pick<CloudDocState, 'pdf' | 'bytes'> | null = keep
                                ? { pdf: prev.pdf, bytes: prev.bytes }
                                : source?.bytes
                                  ? { pdf: source.bytes, bytes: source.bytes }
                                  : stream
                                    ? { pdf: stream, bytes: null }
                                    : null;
                            if (!next) {
                                return prev;
                            }
                            return {
                                doc: withPages,
                                role: confirmedRole ?? prev?.role ?? 'viewer',
                                ...next,
                                ...pending(prev),
                            };
                        });
                        setLoadError(null);
                    }
                } catch (err) {
                    if (cancelled) {
                        return;
                    }
                    if (held) {
                        setState((prev) => {
                            // What is on screen stays: the cached paint, or a stream in flight.
                            const pdf = prev?.doc.id === docId ? prev.pdf : held.bytes;
                            if (!pdf) {
                                return prev;
                            }
                            return {
                                doc: { ...held.doc, ...confirmedMeta(confirmedDoc) },
                                role: confirmedRole ?? prev?.role ?? held.cachedRole ?? 'viewer',
                                pdf,
                                bytes: prev?.doc.id === docId ? prev.bytes : held.bytes,
                                ...pending(prev),
                            };
                        });
                        return;
                    }
                    setLoadError(firstOpenFailure(err));
                }
                return;
            }

            const bothTransport =
                isTransportFailure(docResult.reason) &&
                roleResult.status === 'rejected' &&
                isTransportFailure(roleResult.reason);
            if (held) {
                setAwaitingServer(true);
            }
            if (held && bothTransport && held.cachedRole) {
                // No server to ask: the last-known role is the best truth
                // there is. The 'online' re-check asks again on reconnect.
                setState((prev) =>
                    prev?.doc.id === docId ? { ...prev, provisional: undefined, unconfirmed: undefined } : prev,
                );
                return;
            }
            if (held) {
                // Stay as painted: a PostgREST throw is not "the server never
                // answered", and a missing stored role must not grant writes.
                return;
            }
            setLoadError(firstOpenFailure(docResult.reason));
        })();

        // Resist storage eviction — annotations and cached scores must survive
        // Safari's cleanup between rehearsals (plan §offline).
        void navigator.storage?.persist?.().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [docId, userId, confirmAttempt]);

    // Back online before the server confirmed this score: ask it now. A role
    // read from the cache (or none at all) is re-verified, a provisional paint
    // can finally start syncing, and a first open that failed offline loads.
    useEffect(() => {
        const onOnline = () => {
            if (confirmedFor.current === docId) {
                return;
            }
            setLoadError((prev) => (prev !== null && RETRYABLE_OPEN_MESSAGES.has(prev) ? null : prev));
            setConfirmAttempt((n) => n + 1);
        };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [docId]);

    // Online, and the server has not answered yet (a failed role confirm, a
    // first open that could not reach it): ask again on a backoff. Waiting for
    // an 'online' event would wait forever — the browser already is online.
    const retryOpen = loadError !== null && RETRYABLE_OPEN_MESSAGES.has(loadError);
    const askAgain = useCallback(() => {
        setLoadError((prev) => (prev !== null && RETRYABLE_OPEN_MESSAGES.has(prev) ? null : prev));
        setConfirmAttempt((n) => n + 1);
    }, []);
    useEffect(() => {
        if (!online || !(awaitingServer || retryOpen)) {
            return;
        }
        const attempt = confirmRetries.current;
        confirmRetries.current = attempt + 1;
        const timer = setTimeout(askAgain, Math.min(CONFIRM_RETRY_BASE_MS * 2 ** attempt, CONFIRM_RETRY_MAX_MS));
        return () => clearTimeout(timer);
    }, [online, awaitingServer, retryOpen, confirmAttempt, askAgain]);

    /**
     * What a streamed first open's offline copy is stamped with: the latest
     * row, and the server's role if it has answered by now, else the one the
     * stream started with.
     */
    const streamStamp = useCallback((source: StreamedPdfSource) => {
        const stream = source as ScoreStream;
        const live = stateRef.current?.pdf === source ? stateRef.current : null;
        const doc = live?.doc ?? stream.doc;
        const role = live && !live.provisional && !live.unconfirmed ? (live.role ?? undefined) : stream.role;
        return { doc, role };
    }, []);

    /**
     * A first open finished streaming: this is the offline copy (and the
     * bytes the import tools need).
     */
    const onStreamComplete = useCallback(
        (source: StreamedPdfSource, bytes: ArrayBuffer) => {
            const { doc, role } = streamStamp(source);
            void cacheDocumentBytes(doc, bytes, { userId, role });
            setState((prev) => (prev?.pdf === source ? { ...prev, bytes } : prev));
            void ensureDocumentPageCount(doc, bytes)
                .then((withPages) => {
                    if (withPages.page_count !== doc.page_count) {
                        setState((prev) =>
                            prev?.pdf === source
                                ? { ...prev, doc: { ...prev.doc, page_count: withPages.page_count } }
                                : prev,
                        );
                    }
                })
                .catch(() => undefined);
        },
        [userId, streamStamp],
    );

    /**
     * The viewer closed (or moved on) before a first open finished streaming:
     * the download carries on without it and still becomes the offline copy,
     * unless a copy of this revision or a newer one is cached by then (the
     * viewer moved on to a newer revision, or the score was reopened).
     */
    const onStreamAbandoned = useCallback(
        (source: StreamedPdfSource, download: ProgressiveDownload) => {
            const { doc, role } = streamStamp(source);
            cacheStreamedDocument(doc, download, { userId, role });
        },
        [userId, streamStamp],
    );

    /**
     * The stream failed (the signed URL refused, the connection dropped):
     * download the file whole instead, which also falls back to a stale
     * offline copy. Only if that fails too is the score unopenable.
     */
    const onStreamError = useCallback(
        (source: StreamedPdfSource, err: unknown) => {
            const stream = source as ScoreStream;
            console.warn('Streaming the score failed; downloading it whole', err);
            void loadDocumentBytes(stream.doc, { userId, role: stream.role })
                .then((bytes) => setState((prev) => (prev?.pdf === source ? { ...prev, pdf: bytes, bytes } : prev)))
                .catch((fallbackErr: unknown) => {
                    if (stateRef.current?.pdf !== source) {
                        return;
                    }
                    setState(null);
                    setLoadError(firstOpenFailure(fallbackErr));
                });
        },
        [userId],
    );

    const onStatus = useCallback((status: SyncStatus) => setSyncStatus(status), []);
    const onRejected = useCallback(
        (rejection: SyncRejection) =>
            setRejected((prev) => ({
                docId,
                ids: new Set(prev?.docId === docId ? prev.ids : []).add(rejection.annotationId),
            })),
        [docId],
    );
    const onHeld = useCallback(
        (hold: SyncHold) => {
            if (hold.reason === 'signed-out') {
                // Nothing more can be sent under this sign-in; the engine kept
                // the outbox, and the sign-out that follows keeps it too.
                setState(null);
                setShareOpen(false);
                setLoadError(SIGN_IN_ENDED_MESSAGE);
                setAccessLoss('ended');
                return;
            }
            setHeld({ docId, pendingMarks: hold.pendingMarks });
        },
        [docId],
    );
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
        // Mid sign-out after the teacher ended it: the student sign-in page is next.
        return accessLoss === 'ended' ? null : <Navigate to="/" replace />;
    }
    if (loadError) {
        const escapeTo = isRegisteredSession(session) ? '/library' : '/';
        const escapeLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';
        return (
            <main className="landing-page flex min-h-full flex-col items-center justify-center gap-3 p-8">
                <ErrorText className="max-w-md text-center">{loadError}</ErrorText>
                {RETRYABLE_OPEN_MESSAGES.has(loadError) ? (
                    <Button size="sm" variant="secondary" onClick={askAgain}>
                        Try again
                    </Button>
                ) : null}
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
    // Owner and export chrome waits for the server (or, offline, for the
    // stored role standing in for it); drawing and sync do not — see
    // CloudDocState.unconfirmed.
    const confirmed = !state.provisional && !state.unconfirmed;
    const syncing = Boolean(resolvedUserId) && !state.provisional;
    const backTo = isRegisteredSession(session) ? '/library' : '/';
    const backLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';
    // A roster student's scores are their teacher's to assign and withdraw
    // (leave_document refuses an assigned score), so they get no Leave.
    const canLeave = userTypeOf(session) !== 'student';
    const ownBytes = state.bytes;

    return (
        <div className="fixed inset-0 flex flex-col">
            <ViewerHeader backTo={backTo} backLabel={backLabel} title={state.doc.title}>
                <PresenceBar peers={peers} selfUserId={resolvedUserId} />
                {/* No engine yet (no role to sync under): say whether that is the network, or the server not having answered. */}
                <SyncDot status={syncing ? syncStatus : !online ? 'offline' : awaitingServer ? 'waiting' : 'syncing'} />
                {archived ? (
                    <span title="Read-only — over your plan’s score limit">
                        <Badge tone="warn">Archived</Badge>
                    </span>
                ) : readOnly ? (
                    <Badge>view only</Badge>
                ) : null}
                {/* Needs the whole file: a first open shows it once the stream ends. */}
                {annotationStore && confirmed && state.role === 'owner' && ownBytes ? (
                    <ImportScanButton
                        store={annotationStore}
                        docId={docId}
                        bytes={ownBytes}
                        classify={classify}
                        includeBornDigital
                        clean={buildCleanFn(state.doc, ownBytes, (updated, newBytes) => {
                            setState((prev) =>
                                prev ? { ...prev, doc: updated, pdf: newBytes, bytes: newBytes } : prev,
                            );
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
                {confirmed ? (
                    <ShareExportMenu docId={docId} doc={state.doc} role={state.role} title={state.doc.title} />
                ) : null}
                {confirmed && state.role === 'owner' ? (
                    // "Share" is sharing the score with people (links, who has
                    // access); sending a copy of it is "Export", beside it.
                    <Button
                        size="sm"
                        title="Share this score — links, and who has access"
                        onClick={() => setShareOpen(true)}
                    >
                        Share
                    </Button>
                ) : confirmed && state.role && canLeave ? (
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
            {/* The landmark for everything below the header — notices, the score
                and its floating controls — so none of it sits outside one. */}
            <main className="flex min-h-0 flex-1 flex-col">
                <UpgradeBanner isGuest={Boolean(session?.user.is_anonymous)} />
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
                    <PdfProvider
                        data={state.pdf}
                        onStreamComplete={onStreamComplete}
                        onStreamError={onStreamError}
                        onStreamAbandoned={onStreamAbandoned}
                    >
                        <PdfViewport
                            key={docId}
                            docId={docId}
                            readOnly={readOnly}
                            onStoreReady={onStoreReady}
                            // Playhead, loop tint and tap-to-seek live only while
                            // the transport is on screen to drive them.
                            playback={playAlongEnabled && playAlongOpen ? playbackFeature : undefined}
                            // Known before the score syncs (provisional): this
                            // account's own queued marks are drawn meanwhile.
                            authorId={resolvedUserId || null}
                            sync={
                                // Not while provisional: with no role there is
                                // nothing to sync under yet. A stored role syncs at
                                // once; the engine restarts only if the server's
                                // answer changes whether this account may write.
                                syncing
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
            </main>
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

/**
 * 'waiting': no engine yet because the server has not confirmed this score
 * (and no role was stored to edit under meanwhile); it is being asked again.
 */
export const SyncDot = ({ status }: { status: SyncStatus | 'waiting' }) => {
    // Red is kept for what needs the user's attention: a refusal, or failures
    // that have gone on for minutes. A throttled or briefly unreachable server
    // is "retrying" — the marks are safe on this device either way.
    const styles: Record<SyncStatus | 'waiting', { dot: string; short: string; label: string }> = {
        synced: { dot: 'bg-emerald-500', short: 'Synced', label: 'Synced' },
        syncing: { dot: 'bg-amber-400 animate-pulse', short: 'Syncing…', label: 'Syncing…' },
        offline: { dot: 'bg-stone-400', short: 'Offline', label: 'Offline — changes saved on this device' },
        retrying: {
            dot: 'bg-amber-400',
            short: 'Retrying…',
            label: 'Sync delayed — retrying. Changes are saved on this device.',
        },
        error: {
            dot: 'bg-red-500',
            short: 'Not syncing',
            label: 'Changes aren’t reaching the server yet. They’re saved on this device.',
        },
        waiting: {
            dot: 'bg-stone-400',
            short: 'Waiting for server',
            label: 'Waiting for the server to confirm this score — asking again shortly.',
        },
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
            <main className="min-h-0 flex-1">
                <PdfProvider data={bytes}>
                    <PdfViewport key={docId} docId={docId} onStoreReady={onStoreReady} />
                </PdfProvider>
            </main>
        </div>
    );
};
