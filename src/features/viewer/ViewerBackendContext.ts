import { createContext, useContext } from 'react';

import { installSnapshotRetry } from '@/features/viewer/history/snapshotService';
import type { InkController } from '@/features/viewer/ink/InkController';
import { getSupabase, type TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import { getDb, type ScribblerDb } from '@/sync/db';
import { DocRealtimeChannel, fetchRealtimeTopicEpoch } from '@/sync/realtimeChannel';
import {
    createSupabaseAnnotationsApi,
    SyncEngine,
    type SyncHold,
    type SyncRejection,
    type SyncStatus,
} from '@/sync/syncEngine';
import type { PresencePeer, ScoreAnalysisBroadcast } from '@/sync/wire';

export interface ViewerSyncCallbacks {
    onStatus?: (status: SyncStatus) => void;
    onRejected?: (rejection: SyncRejection) => void;
    onHeld?: (hold: SyncHold) => void;
    onPeers?: (peers: PresencePeer[]) => void;
    onDocReplaced?: (contentRev: number) => void;
    onScoreAnalysis?: (msg: ScoreAnalysisBroadcast) => void;
    onMembershipChanged?: () => void;
}

export interface ViewerSyncArgs {
    docId: string;
    store: AnnotationStore;
    ink: InkController;
    self: PresencePeer;
    canWrite: boolean;
    callbacks: ViewerSyncCallbacks;
}

export interface ViewerSyncHandle {
    setPage(page: number): void;
    stop(): void;
}

/**
 * Where an open score's marks live and how they stay in step with the
 * server. PdfViewport asks for one and never learns which it has: members get
 * the cloud database and the sync engine, a signed-out link viewer gets an
 * in-memory database fed by the view link (src/features/share/linkViewerBackend.ts).
 */
export interface ViewerBackend {
    readonly db: ScribblerDb;
    readonly supabase: TypedSupabaseClient;
    connect(args: ViewerSyncArgs): ViewerSyncHandle;
}

export const memberBackend: ViewerBackend = {
    get db() {
        return getDb();
    },
    get supabase() {
        return getSupabase();
    },
    connect({ docId, store, ink, self, canWrite, callbacks }) {
        const supabase = getSupabase();
        const engine = new SyncEngine({
            db: getDb(),
            store,
            api: createSupabaseAnnotationsApi(supabase),
            docId,
            getUserId: () => self.userId,
            onStatus: callbacks.onStatus,
            onRejected: callbacks.onRejected,
            onHeld: callbacks.onHeld,
        });
        const channel = new DocRealtimeChannel({
            supabase,
            docId,
            self,
            onRemoteInk: (msg) => ink.applyRemoteInk(msg),
            onDbChange: (row) => {
                void engine.applyServerRow(row);
                ink.remoteInkCommitted(row.id);
            },
            onPeers: (peers) => callbacks.onPeers?.(peers),
            onReconnect: () => {
                ink.clearRemoteInk();
                // Committed rows may have gone unheard meanwhile (a drop, or
                // a takedown moving the score's topics): live rows must not
                // move the watermark past them before this pull lands.
                engine.noteGap();
                void engine.sync();
                installSnapshotRetry();
                // A role change made while the connection was down sent
                // its broadcast to nobody.
                callbacks.onMembershipChanged?.();
            },
            onResync: () => {
                engine.noteGap();
                void engine.sync();
            },
            onDocReplaced: (contentRev) => callbacks.onDocReplaced?.(contentRev),
            onScoreAnalysis: (msg) => callbacks.onScoreAnalysis?.(msg),
            onMembershipChanged: () => callbacks.onMembershipChanged?.(),
            fetchTopicEpoch: () => fetchRealtimeTopicEpoch(supabase, docId),
        });
        if (canWrite) {
            ink.setLivePublisher(channel.publisher);
        }
        engine.start();
        channel.start();
        // Lesson-history snapshots whose upload failed earlier (offline,
        // a closed tab) go up now, and again whenever the browser is back online.
        installSnapshotRetry();
        return {
            setPage: (page) => channel.setPage(page),
            stop: () => {
                channel.stop();
                engine.stop();
            },
        };
    },
};

const ViewerBackendContext = createContext<ViewerBackend>(memberBackend);

export const ViewerBackendProvider = ViewerBackendContext.Provider;

export const useViewerBackend = (): ViewerBackend => useContext(ViewerBackendContext);
