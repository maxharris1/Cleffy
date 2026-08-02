import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';

import { displayNameOf, isRegisteredSession, useSession } from '@/features/auth/session';
import { UpgradeBanner } from '@/features/auth/UpgradeBanner';
import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import {
    fetchDocument,
    fetchMyRole,
    isCloudDocId,
    loadDocumentBytes,
    loadDocumentOffline,
} from '@/features/library/documentsService';
import { ShareDialog } from '@/features/share/ShareDialog';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { getLocalDoc, localDocId, putLocalDoc } from '@/lib/localDocs';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { SyncStatus } from '@/sync/syncEngine';
import type { PresencePeer } from '@/sync/wire';
import type { DocumentRow, MemberRole } from '@/types/database';

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
}

const CloudViewer = ({ docId }: { docId: string }) => {
    const { session, loading } = useSession();
    const [state, setState] = useState<CloudDocState | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
    const [shareOpen, setShareOpen] = useState(false);
    const [peers, setPeers] = useState<PresencePeer[]>([]);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);

    const userId = session?.user.id;

    const onStoreReady = useCallback((store: AnnotationStore) => setAnnotationStore(store), []);

    useEffect(() => {
        if (!userId) {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const doc = await fetchDocument(docId);
                if (!doc) {
                    throw new Error('Score not found — it may have been deleted, or your access was revoked.');
                }
                const [role, bytes] = await Promise.all([fetchMyRole(docId, userId), loadDocumentBytes(doc)]);
                if (!cancelled) {
                    setState({ doc, role, bytes });
                }
            } catch (err) {
                // No network? A previously-cached score still opens (plan §offline).
                const fallback = await loadDocumentOffline(docId).catch(() => null);
                if (!cancelled) {
                    if (fallback) {
                        setState({ doc: fallback.doc, role: fallback.role, bytes: fallback.bytes });
                    } else {
                        setLoadError(err instanceof Error ? err.message : 'Could not open this score.');
                    }
                }
            }
        })();

        // Resist storage eviction — annotations and cached scores must survive
        // Safari's cleanup between rehearsals (plan §offline).
        void navigator.storage?.persist?.().catch(() => undefined);

        return () => {
            cancelled = true;
        };
    }, [docId, userId]);

    const onStatus = useCallback((status: SyncStatus) => setSyncStatus(status), []);
    const onPeers = useCallback((next: PresencePeer[]) => setPeers(next), []);

    if (!loading && !session) {
        return <Navigate to="/" replace />;
    }
    if (loadError) {
        const escapeTo = isRegisteredSession(session) ? '/library' : '/';
        const escapeLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';
        return (
            <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8">
                <p className="max-w-md text-center text-red-600">{loadError}</p>
                <Link to={escapeTo} className="text-sm text-indigo-600 underline">
                    {escapeLabel}
                </Link>
            </main>
        );
    }
    if (!state || !userId) {
        return (
            <main className="flex min-h-full items-center justify-center p-8">
                <p className="animate-pulse text-stone-500">Opening score…</p>
            </main>
        );
    }

    const readOnly = state.role !== 'owner' && state.role !== 'editor';
    const backTo = isRegisteredSession(session) ? '/library' : '/';
    const backLabel = isRegisteredSession(session) ? 'Back to library' : 'Back to home';

    return (
        <div className="fixed inset-0 flex flex-col">
            <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-3 py-2 shadow-sm">
                <Link
                    to={backTo}
                    aria-label={backLabel}
                    className="rounded px-2 py-1 text-stone-600 hover:bg-stone-100"
                >
                    ←
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-700">{state.doc.title}</span>
                <PresenceBar peers={peers} selfUserId={userId} />
                <SyncDot status={syncStatus} />
                {readOnly ? (
                    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">view only</span>
                ) : null}
                {annotationStore ? <LessonHistoryButton store={annotationStore} canRestore={!readOnly} /> : null}
                <ShareExportMenu docId={docId} bytes={state.bytes} title={state.doc.title} />
                {state.role === 'owner' ? (
                    <button
                        type="button"
                        onClick={() => setShareOpen(true)}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow hover:bg-indigo-500"
                    >
                        Invite
                    </button>
                ) : null}
            </header>
            {session?.user.is_anonymous ? <UpgradeBanner /> : null}
            <div className="min-h-0 flex-1">
                <PdfProvider data={state.bytes}>
                    <PdfViewport
                        key={docId}
                        docId={docId}
                        readOnly={readOnly}
                        onStoreReady={onStoreReady}
                        sync={{
                            userId,
                            name: displayNameOf(session),
                            isAnonymous: Boolean(session?.user.is_anonymous),
                            canWrite: !readOnly,
                            onStatus,
                            onPeers,
                        }}
                    />
                </PdfProvider>
            </div>
            {shareOpen ? <ShareDialog docId={docId} userId={userId} onClose={() => setShareOpen(false)} /> : null}
        </div>
    );
};

const SyncDot = ({ status }: { status: SyncStatus }) => {
    const styles: Record<SyncStatus, { dot: string; label: string }> = {
        synced: { dot: 'bg-emerald-500', label: 'Synced' },
        syncing: { dot: 'bg-amber-400 animate-pulse', label: 'Syncing…' },
        offline: { dot: 'bg-stone-400', label: 'Offline — changes saved on this device' },
        error: { dot: 'bg-red-500', label: 'Sync error — retrying' },
    };
    const { dot, label } = styles[status];
    return (
        <span title={label} aria-label={label} className="flex items-center">
            <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        </span>
    );
};

// ---------------------------------------------------------------------------
// Local documents: opened from disk, annotations on-device only.

const LocalViewer = ({ docId }: { docId: string }) => {
    const [, forceRender] = useState(0);
    const [annotationStore, setAnnotationStore] = useState<AnnotationStore | null>(null);
    const bytes = getLocalDoc(docId);

    const onStoreReady = useCallback((store: AnnotationStore) => setAnnotationStore(store), []);

    const reopenFile = useCallback(
        async (file: File) => {
            const buffer = await file.arrayBuffer();
            const id = await localDocId(buffer);
            putLocalDoc(id, buffer);
            if (id === docId) {
                forceRender((n) => n + 1);
            } else {
                // Different file than the one this URL refers to — open it under its own id.
                window.location.assign(`/doc/${id}`);
            }
        },
        [docId],
    );

    if (!bytes) {
        return (
            <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
                <p className="max-w-md text-center text-stone-600">
                    This score isn&apos;t loaded in this session. Re-open the PDF file to continue — your annotations
                    are saved on this device.
                </p>
                <label className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500">
                    Re-open PDF
                    <input
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                                void reopenFile(file);
                            }
                        }}
                    />
                </label>
                <Link to="/" className="text-sm text-indigo-600 underline">
                    Back to home
                </Link>
            </main>
        );
    }

    return (
        <div className="fixed inset-0 flex flex-col">
            <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-3 py-2 shadow-sm">
                <Link
                    to="/"
                    aria-label="Back to home"
                    className="rounded px-2 py-1 text-stone-600 hover:bg-stone-100"
                >
                    ←
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-700">Local score</span>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">this device only</span>
                {annotationStore ? <LessonHistoryButton store={annotationStore} canRestore /> : null}
                <ShareExportMenu docId={docId} bytes={bytes} title="Score" />
            </header>
            <div className="min-h-0 flex-1">
                <PdfProvider data={bytes}>
                    <PdfViewport key={docId} docId={docId} onStoreReady={onStoreReady} />
                </PdfProvider>
            </div>
        </div>
    );
};
