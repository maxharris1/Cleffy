import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { LinkViewSync } from '@/features/share/LinkViewSync';
import type { ViewerBackend } from '@/features/viewer/ViewerBackendContext';
import type { TypedSupabaseClient } from '@/lib/supabase';
import { ScribblerDb } from '@/sync/db';
import { DocRealtimeChannel, type TopicEpochRead } from '@/sync/realtimeChannel';

/** Rotation hints are followed within this, so a revoke clears an open viewer in about 2 s. */
export const LINK_VIEWER_ROTATION_JITTER_MS = 250;

export type LinkAccess =
    | { status: 'open'; epoch: number; linkExpiresAt: string | null }
    | { status: 'revoked' | 'expired' | 'unavailable' | 'invalid' }
    | { status: 'failed' };

/** link_view_access() under the viewer token: is the link still open, and at which topic generation. */
export const readLinkAccess = async (client: TypedSupabaseClient): Promise<LinkAccess> => {
    const { data, error } = await client.rpc('link_view_access');
    if (error || !data) {
        return { status: 'failed' };
    }
    if (data.status === 'open') {
        return { status: 'open', epoch: data.epoch, linkExpiresAt: data.link_expires_at };
    }
    return { status: data.status === 'revoked' || data.status === 'expired' ? data.status : 'unavailable' };
};

const toEpoch = (access: LinkAccess): TopicEpochRead => {
    if (access.status === 'open') {
        return { status: 'epoch', epoch: access.epoch };
    }
    return access.status === 'failed' ? { status: 'failed' } : { status: 'denied' };
};

export interface LinkViewerBackend extends ViewerBackend {
    dispose(): Promise<void>;
}

/**
 * The backend a signed-out link viewer's PdfViewport runs on: a database in
 * memory (fake-indexeddb, a fresh factory per open), the link-only client, and
 * the same realtime channel members use, on doc-view. Nothing it holds
 * outlives dispose().
 */
export const createLinkViewerBackend = (client: TypedSupabaseClient): LinkViewerBackend => {
    const db = new ScribblerDb(`link-view-${crypto.randomUUID()}`, { indexedDB: new IDBFactory(), IDBKeyRange });
    const connections = new Set<{ channel: DocRealtimeChannel; sync: LinkViewSync }>();
    return {
        db,
        supabase: client,
        connect({ docId, store, ink, self, callbacks }) {
            const sync = new LinkViewSync({ client, store });
            const channel = new DocRealtimeChannel({
                supabase: client,
                docId,
                self,
                dbTopic: 'doc-view',
                rotationJitterMaxMs: LINK_VIEWER_ROTATION_JITTER_MS,
                onRemoteInk: (msg) => ink.applyRemoteInk(msg),
                onDbChange: () => undefined,
                onViewMark: (mark) => {
                    void sync.applyMark(mark).then(() => ink.remoteInkCommitted(mark.id));
                },
                onPeers: (peers) => callbacks.onPeers?.(peers),
                onReconnect: () => {
                    ink.clearRemoteInk();
                    void sync.pull();
                },
                onResync: () => void sync.pull(),
                onMembershipChanged: () => callbacks.onMembershipChanged?.(),
                fetchTopicEpoch: async () => toEpoch(await readLinkAccess(client)),
            });
            const connection = { channel, sync };
            connections.add(connection);
            void sync.pull();
            channel.start();
            return {
                setPage: (page) => channel.setPage(page),
                stop: () => {
                    connections.delete(connection);
                    sync.stop();
                    channel.stop();
                },
            };
        },
        async dispose() {
            for (const { channel, sync } of connections) {
                sync.stop();
                channel.stop();
            }
            connections.clear();
            await client.removeAllChannels();
            client.realtime.disconnect();
            db.close();
            await db.delete().catch(() => undefined);
        },
    };
};
