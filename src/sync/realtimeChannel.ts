import type { RealtimeChannel } from '@supabase/supabase-js';

import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    INK_PROGRESS_EVENT,
    SCORE_ANALYSIS_EVENT,
    parseDbChange,
    parseDocumentChange,
    parseInkProgress,
    parseScoreAnalysisBroadcast,
    presenceSchema,
    type InkProgressMsg,
    type PresencePeer,
    type ScoreAnalysisBroadcast,
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

/**
 * How long doc-db:{id} may lag behind a joined doc:{id} before we stop waiting
 * for it. Both topics share one socket, so a healthy re-join lands within a
 * round-trip of the other; anything slower means the join is being refused or
 * retried (e.g. the frontend is live before migration 20261007120101).
 */
export const DB_JOIN_GRACE_MS = 4000;
/** Pull cadence while committed rows cannot arrive live (fallback mode). */
export const DB_FALLBACK_POLL_MS = 15_000;
/**
 * In fallback mode a peer's finished live stroke is pulled this long after its
 * last batch — long enough for their outbox flush to commit, well inside the
 * 10 s live-preview TTL so the mark never visibly disappears.
 */
export const DB_FALLBACK_INK_PULL_MS = 1500;

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
    /**
     * Pull committed rows without touching live buffers. Used while
     * doc-db:{id} cannot be joined, when committed rows can only come from
     * pulls, and once it finally joins (to cover the gap until then).
     */
    onResync: () => void;
    /** Another member replaced the document's PDF bytes (smart-import cleanup). */
    onDocReplaced?: (contentRev: number) => void;
    /** Play-along analysis lifecycle changed (trimmed broadcast). */
    onScoreAnalysis?: (msg: ScoreAnalysisBroadcast) => void;
}

/** Private topic for presence and live ink — members may send on it. */
export const docTopic = (docId: string): string => `doc:${docId}`;

/**
 * Private topic for server-authored events: committed annotation rows, PDF
 * replacement and play-along status, all written by database triggers. RLS lets
 * members receive on it and no client send on it (migration
 * 20261007120101_realtime_db_topic). It is separate from doc:{id} because
 * Realtime authorizes a channel's sends for every event name at once, so on a
 * shared topic any editor could broadcast a hand-made 'INSERT' that peers
 * would apply as a committed row (forged author, forged seq).
 */
export const docDbTopic = (docId: string): string => `doc-db:${docId}`;

type ChannelKey = 'live' | 'db';

/**
 * The per-document realtime connection: presence and live ink on the private
 * topic `doc:{id}`, and committed-row fan-out on the receive-only `doc-db:{id}`.
 */
export class DocRealtimeChannel {
    private channel: RealtimeChannel | null = null;
    private dbChannel: RealtimeChannel | null = null;
    private readonly joined: Record<ChannelKey, boolean> = { live: false, db: false };
    private readonly everJoined: Record<ChannelKey, boolean> = { live: false, db: false };
    private reconnectPending = false;
    private stopped = false;

    // Fallback when doc-db:{id} will not join (see armDbFallback).
    private dbGraceTimer: ReturnType<typeof setTimeout> | null = null;
    private dbPollTimer: ReturnType<typeof setInterval> | null = null;
    private dbInkPullTimer: ReturnType<typeof setTimeout> | null = null;
    /** Committed rows have had no live path since this was set; a db join must pull. */
    private dbFallback = false;

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
        const channel = supabase.channel(docTopic(docId), {
            config: {
                private: true,
                broadcast: { self: false, ack: false },
                presence: { key: self.userId },
            },
        });

        // Only live ink is accepted here. Committed rows are never read off this
        // topic: every member who may send on it could have written them.
        channel.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => {
            const msg = parseInkProgress(payload);
            if (msg && msg.userId !== self.userId) {
                this.opts.onRemoteInk(msg);
                if (msg.done && this.dbFallback) {
                    this.scheduleInkPull();
                }
            }
        });

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
            }
            this.onChannelStatus('live', status);
        });

        // Receive-only: no presence, and nothing is ever sent on it.
        const dbChannel = supabase.channel(docDbTopic(docId), {
            config: { private: true, broadcast: { self: false, ack: false } },
        });
        const onDb = ({ payload }: { payload: unknown }) => {
            // The topic multiplexes two tables: documents (bytes replaced) and annotations.
            const docChange = parseDocumentChange(payload);
            if (docChange) {
                this.opts.onDocReplaced?.(docChange.content_rev);
                return;
            }
            const row = parseDbChange(payload);
            if (row) {
                this.opts.onDbChange(row);
            }
        };
        dbChannel.on('broadcast', { event: 'INSERT' }, onDb);
        dbChannel.on('broadcast', { event: 'UPDATE' }, onDb);
        dbChannel.on('broadcast', { event: SCORE_ANALYSIS_EVENT }, ({ payload }) => {
            const msg = parseScoreAnalysisBroadcast(payload);
            if (msg && msg.document_id === docId) {
                this.opts.onScoreAnalysis?.(msg);
            }
        });
        this.dbChannel = dbChannel;
        dbChannel.subscribe((status) => this.onChannelStatus('db', status));
    }

    /**
     * Re-join bookkeeping across the two channels. A drop usually takes both
     * (they share one socket), and the gap-fill pull must start only once the
     * committed-row channel is live again — otherwise a row committed between
     * the pull and the db channel's re-join would be missed by both. So
     * onReconnect fires once both are joined after either re-joined; the first
     * join of each is not a reconnect.
     *
     * Waiting on doc-db:{id} is bounded, though: if it stays unjoined
     * DB_JOIN_GRACE_MS after doc:{id} joined, the channel degrades to pulling
     * (see armDbFallback) instead of leaving the score with no committed-row
     * path at all.
     */
    private onChannelStatus(key: ChannelKey, status: string): void {
        if (this.stopped) {
            return;
        }
        if (status !== 'SUBSCRIBED') {
            this.joined[key] = false;
            this.updateDbFallback();
            return;
        }
        this.joined[key] = true;
        if (this.everJoined[key]) {
            this.reconnectPending = true;
        }
        this.everJoined[key] = true;
        if (this.joined.live && this.joined.db) {
            const missedRows = this.reconnectPending || this.dbFallback;
            const clearLive = this.reconnectPending;
            this.reconnectPending = false;
            this.leaveDbFallback();
            if (clearLive) {
                this.opts.onReconnect();
            } else if (missedRows) {
                // First db join after running without it: rows committed since
                // the last fallback pull reached nobody. Live ink was intact.
                this.opts.onResync();
            }
            return;
        }
        this.updateDbFallback();
    }

    /** Start or stop waiting on doc-db:{id} as the two join states change. */
    private updateDbFallback(): void {
        if (this.joined.live && !this.joined.db) {
            this.armDbFallback();
        } else {
            // Socket down (live not joined): pulls would only fail; the next
            // live join re-arms. Or db is joined: onChannelStatus handled it.
            this.clearDbFallbackTimers();
        }
    }

    /**
     * doc:{id} is joined but doc-db:{id} is not. Give it DB_JOIN_GRACE_MS, then
     * run whatever gap-fill was waiting on it and keep pulling every
     * DB_FALLBACK_POLL_MS (plus shortly after each peer stroke ends) until it
     * joins. realtime-js keeps retrying the refused join on its own.
     */
    private armDbFallback(): void {
        if (this.dbGraceTimer || this.dbPollTimer) {
            return;
        }
        this.dbGraceTimer = setTimeout(() => {
            this.dbGraceTimer = null;
            if (this.stopped || !this.joined.live || this.joined.db) {
                return;
            }
            this.dbFallback = true;
            if (this.reconnectPending) {
                this.reconnectPending = false;
                this.opts.onReconnect();
            } else {
                this.opts.onResync();
            }
            this.dbPollTimer = setInterval(() => this.opts.onResync(), DB_FALLBACK_POLL_MS);
        }, DB_JOIN_GRACE_MS);
    }

    private scheduleInkPull(): void {
        if (this.dbInkPullTimer) {
            clearTimeout(this.dbInkPullTimer);
        }
        this.dbInkPullTimer = setTimeout(() => {
            this.dbInkPullTimer = null;
            if (!this.stopped && this.dbFallback && !this.joined.db) {
                this.opts.onResync();
            }
        }, DB_FALLBACK_INK_PULL_MS);
    }

    private leaveDbFallback(): void {
        this.dbFallback = false;
        this.clearDbFallbackTimers();
        if (this.dbInkPullTimer) {
            clearTimeout(this.dbInkPullTimer);
            this.dbInkPullTimer = null;
        }
    }

    private clearDbFallbackTimers(): void {
        if (this.dbGraceTimer) {
            clearTimeout(this.dbGraceTimer);
            this.dbGraceTimer = null;
        }
        if (this.dbPollTimer) {
            clearInterval(this.dbPollTimer);
            this.dbPollTimer = null;
        }
    }

    stop(): void {
        this.stopped = true;
        this.leaveDbFallback();
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
        if (this.dbChannel) {
            void this.opts.supabase.removeChannel(this.dbChannel);
            this.dbChannel = null;
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
