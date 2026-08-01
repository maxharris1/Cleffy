import type { RealtimeChannel } from '@supabase/supabase-js';

import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    INK_PROGRESS_EVENT,
    parseDbChange,
    parseInkProgress,
    presenceSchema,
    type InkProgressMsg,
    type PresencePeer,
} from '@/sync/wire';
import type { AnnotationRow } from '@/types/database';

/** Live-ink flush cadence; degrades on backpressure (plan §realtime). */
const FLUSH_MS = 50;
const FLUSH_MS_DEGRADED = 100;
const FLUSH_MAX_POINTS = 25;

export interface StrokeMeta {
    strokeId: string;
    page: number;
    kind: 'stroke' | 'highlight';
    color: string;
    w: number;
}

/** Fed by InkController with local pen movement; batches over the channel. */
export interface LiveInkPublisher {
    start(meta: StrokeMeta): void;
    append(pts: number[]): void;
    end(): void;
    cancel(): void;
}

export interface DocRealtimeChannelOptions {
    supabase: TypedSupabaseClient;
    docId: string;
    self: PresencePeer;
    /** A collaborator's live ink batch arrived. */
    onRemoteInk: (msg: InkProgressMsg) => void;
    /** A committed annotation write fanned out from the database. */
    onDbChange: (row: AnnotationRow) => void;
    onPeers: (peers: PresencePeer[]) => void;
    /** Fired on re-join after a drop: clear live buffers + gap-fill pull. */
    onReconnect: () => void;
}

/**
 * The per-document realtime channel: presence, live ink, and committed
 * annotation fan-out, all multiplexed on the private topic `doc:{id}`.
 */
export class DocRealtimeChannel {
    private channel: RealtimeChannel | null = null;
    private everSubscribed = false;
    private stopped = false;

    // Live-ink batching state.
    private meta: StrokeMeta | null = null;
    private pending: number[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushInterval = FLUSH_MS;

    constructor(private opts: DocRealtimeChannelOptions) {}

    start(): void {
        const { supabase, docId, self } = this.opts;
        const channel = supabase.channel(`doc:${docId}`, {
            config: {
                private: true,
                broadcast: { self: false, ack: false },
                presence: { key: self.userId },
            },
        });

        channel.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => {
            const msg = parseInkProgress(payload);
            if (msg && msg.userId !== self.userId) {
                this.opts.onRemoteInk(msg);
            }
        });
        const onDb = ({ payload }: { payload: unknown }) => {
            const row = parseDbChange(payload);
            if (row) {
                this.opts.onDbChange(row);
            }
        };
        channel.on('broadcast', { event: 'INSERT' }, onDb);
        channel.on('broadcast', { event: 'UPDATE' }, onDb);

        channel.on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState<Record<string, unknown>>();
            const peers: PresencePeer[] = [];
            for (const metas of Object.values(state)) {
                const first = metas[0];
                const parsed = presenceSchema.safeParse(first);
                if (parsed.success) {
                    peers.push(parsed.data);
                }
            }
            this.opts.onPeers(peers);
        });

        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                void channel.track({ ...this.opts.self });
                if (this.everSubscribed) {
                    this.opts.onReconnect();
                }
                this.everSubscribed = true;
            }
        });
        this.channel = channel;
    }

    stop(): void {
        this.stopped = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.channel) {
            void this.opts.supabase.removeChannel(this.channel);
            this.channel = null;
        }
    }

    /** Presence: report which page the user is looking at. */
    setPage(page: number): void {
        this.opts.self.page = page;
        if (this.channel?.state === 'joined') {
            void this.channel.track({ ...this.opts.self });
        }
    }

    // ---- Live ink publishing (called by InkController) -------------------

    readonly publisher: LiveInkPublisher = {
        start: (meta) => {
            this.meta = meta;
            this.pending = [];
        },
        append: (pts) => {
            if (!this.meta) {
                return;
            }
            this.pending.push(...pts);
            if (this.pending.length / 3 >= FLUSH_MAX_POINTS) {
                this.flushInk();
            } else if (!this.flushTimer) {
                this.flushTimer = setTimeout(() => this.flushInk(), this.flushInterval);
            }
        },
        end: () => {
            this.flushInk({ done: true });
            this.meta = null;
        },
        cancel: () => {
            const meta = this.meta;
            this.meta = null;
            this.pending = [];
            if (meta) {
                this.send({ ...metaToMsg(meta, this.opts.self.userId), pts: [], cancel: true });
            }
        },
    };

    private flushInk(extra?: { done: true }): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const meta = this.meta;
        if (!meta || (this.pending.length === 0 && !extra)) {
            return;
        }
        const pts = this.pending;
        this.pending = [];
        this.send({ ...metaToMsg(meta, this.opts.self.userId), pts, ...(extra ?? {}) });
    }

    private send(payload: InkProgressMsg): void {
        if (!this.channel || this.stopped) {
            return;
        }
        void this.channel
            .send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload })
            .then((result) => {
                // Backpressure: realtime-js reports client-side rate limiting.
                if (result === 'rate limited') {
                    this.flushInterval = FLUSH_MS_DEGRADED;
                }
            })
            .catch(() => undefined);
    }
}

const metaToMsg = (meta: StrokeMeta, userId: string): InkProgressMsg => ({
    strokeId: meta.strokeId,
    userId,
    page: meta.page,
    kind: meta.kind,
    color: meta.color,
    w: meta.w,
    pts: [],
});
