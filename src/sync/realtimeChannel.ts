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

/**
 * Live-ink flush cadence. Slower than pen sampling on purpose: Free-plan
 * Realtime messages are billed with fan-out, so we coalesce aggressively and
 * degrade further under client-side backpressure (plan §realtime).
 */
const FLUSH_MS = 100;
const FLUSH_MS_DEGRADED = 175;
const FLUSH_MAX_POINTS = 45;

/** Min gap between presence `track` calls — avoids ClientPresenceRateLimitReached. */
const PRESENCE_TRACK_MIN_MS = 1000;

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
    /** True when at least one other member is on the channel (solo → no live ink). */
    private hasRemoteAudience = false;

    // Presence track coalescing (page-only payload).
    private lastTrackedPage: number | null = null;
    private lastPresenceTrackAt = 0;
    private presenceTrackTimer: ReturnType<typeof setTimeout> | null = null;

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
            this.hasRemoteAudience = peers.some((p) => p.userId !== self.userId);
            this.opts.onPeers(peers);
        });

        this.channel = channel;
        channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                // Only write path for track() — force so join/reconnect always announce.
                this.trackPresence({ force: true });
                if (this.everSubscribed) {
                    this.opts.onReconnect();
                }
                this.everSubscribed = true;
            }
        });
    }

    stop(): void {
        this.stopped = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.presenceTrackTimer) {
            clearTimeout(this.presenceTrackTimer);
            this.presenceTrackTimer = null;
        }
        if (this.channel) {
            void this.opts.supabase.removeChannel(this.channel);
            this.channel = null;
        }
    }

    /**
     * Presence: report which page the user is looking at.
     * PdfViewport already debounces scroll at 400ms; this adds a 1s min gap
     * (including SUBSCRIBED reconnects) so we do not trip ClientPresenceRateLimitReached.
     */
    setPage(page: number): void {
        this.opts.self.page = page;
        this.trackPresence();
    }

    /** Sole writer for `channel.track` presence state. */
    private trackPresence(opts?: { force?: boolean }): void {
        if (this.presenceTrackTimer) {
            clearTimeout(this.presenceTrackTimer);
            this.presenceTrackTimer = null;
        }
        const channel = this.channel;
        if (this.stopped || !channel) {
            return;
        }
        const force = opts?.force === true;
        // SUBSCRIBED callback can fire before state flips to 'joined'; allow force.
        if (!force && channel.state !== 'joined') {
            return;
        }
        const page = this.opts.self.page;
        if (!force && this.lastTrackedPage === page) {
            return;
        }
        // Min-gap applies to reconnect storms too; first join (lastPresenceTrackAt=0) is immediate.
        const elapsed = Date.now() - this.lastPresenceTrackAt;
        if (elapsed < PRESENCE_TRACK_MIN_MS) {
            this.presenceTrackTimer = setTimeout(
                () => this.trackPresence(force ? { force: true } : undefined),
                PRESENCE_TRACK_MIN_MS - elapsed,
            );
            return;
        }
        this.lastTrackedPage = page;
        this.lastPresenceTrackAt = Date.now();
        void channel.track({ ...this.opts.self });
    }

    // ---- Live ink publishing (called by InkController) -------------------

    readonly publisher: LiveInkPublisher = {
        start: (meta) => {
            this.meta = meta;
            this.pending = [];
        },
        append: (pts) => {
            if (!this.meta || !this.hasRemoteAudience) {
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
            if (meta && this.hasRemoteAudience) {
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
        // Solo on the channel: drop the batch. Committed strokes still fan out
        // via the DB trigger — live ink is only useful with a remote audience.
        if (!this.hasRemoteAudience) {
            this.pending = [];
            return;
        }
        const pts = this.pending;
        this.pending = [];
        this.send({ ...metaToMsg(meta, this.opts.self.userId), pts, ...(extra ?? {}) });
    }

    private send(payload: InkProgressMsg): void {
        if (!this.channel || this.stopped || !this.hasRemoteAudience) {
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
