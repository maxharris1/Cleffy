import type { RealtimeChannel } from '@supabase/supabase-js';

import { safePresenceName } from '@/lib/presenceName';
import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    INK_PROGRESS_EVENT,
    MEMBERSHIP_EVENT,
    SCORE_ANALYSIS_EVENT,
    TOPIC_ROTATED_EVENT,
    parseDbChange,
    parseDocumentChange,
    parseInkProgress,
    parseMembershipChange,
    parseScoreAnalysisBroadcast,
    parseTopicRotated,
    presenceSchema,
    type InkProgressMsg,
    type PresencePeer,
    type ScoreAnalysisBroadcast,
} from '@/sync/wire';
import type { AnnotationRow } from '@/types/database';

/**
 * Live-ink flush cadence. Realtime bills every broadcast once as sent and once
 * per member it reaches, so a batch costs as much as the room is large: the
 * cadence widens with the room (10 ms per member, 80–250 ms), keeping a
 * 25-person lesson to four batches per second-long stroke (pen-up included)
 * where a one-to-one lesson still gets smooth 80 ms ink. At c08a922 a flat
 * 100 ms cost ~250 messages per stroke at 25 members and tripped the
 * server's per-second limit (DEPLOY.md §10).
 */
export const FLUSH_MIN_MS = 80;
export const FLUSH_MAX_MS = 250;
const FLUSH_MS_PER_MEMBER = 10;
/** Cadence ceiling while the server is rate-limiting (see RATE_LIMIT_MAX_LEVEL). */
const FLUSH_DEGRADED_MAX_MS = 1000;
/** A batch this large goes out early: payload size, not message count. */
const FLUSH_MAX_POINTS = 150;
/** Same, when only pen-up is streamed (a very long stroke is split). */
const PEN_UP_MAX_POINTS = 1500;

/**
 * Min gap between presence `track` calls. Each one fans out to the whole room
 * and Realtime caps presence messages per second well below broadcast, so a
 * scroll only reports its page every couple of seconds.
 */
export const PRESENCE_TRACK_MIN_MS = 2000;

/**
 * Adaptive backoff after the server says "Too many messages per second" (a
 * `system` error, normally followed by closing the channel) or refuses a join
 * for the same reason. Each signal is one level: the ink cadence and presence
 * gap double per level, and at the top level mid-stroke previews stop — a
 * stroke is streamed once, whole, at pen-up. Committed strokes are never
 * affected: they go through the outbox and the database, not this channel.
 */
export const RATE_LIMIT_MAX_LEVEL = 3;
/** One level is shed after this long without a new signal. */
export const RATE_LIMIT_DECAY_MS = 30_000;
/** Signals this close together (one burst, both channels) count as one level. */
const RATE_LIMIT_MERGE_MS = 1000;

/**
 * Re-join backoff for a channel that dropped. realtime-js retries an errored
 * join itself but never re-joins a channel the server closed — which is what
 * the rate limiter does — so every drop arms one of these: exponential from
 * REJOIN_BASE_MS to REJOIN_MAX_MS, with jitter so a room the server just shed
 * does not come back in lockstep and trip the limit again.
 */
export const REJOIN_BASE_MS = 1000;
export const REJOIN_MAX_MS = 30_000;
/** After a rate-limit signal: rejoining sooner would only be refused again. */
export const REJOIN_RATE_LIMITED_MIN_MS = 5000;
/** A channel that stayed joined this long starts its next backoff from the base. */
export const REJOIN_STABLE_MS = 60_000;

/** The wording Realtime uses for its rate limits ("Too many …", "…RateLimitReached"). */
const RATE_LIMIT_RE = /too many|rate.?limit/i;

export const isRateLimitText = (text: unknown): boolean => typeof text === 'string' && RATE_LIMIT_RE.test(text);

/**
 * Delay before re-join attempt `attempt` (0-based): half the exponential
 * ceiling plus up to half again at random ("equal jitter"), so it is bounded
 * on both sides.
 */
export const rejoinDelayMs = (attempt: number, rateLimited: boolean, random: () => number = Math.random): number => {
    let ceiling = Math.min(REJOIN_MAX_MS, REJOIN_BASE_MS * 2 ** Math.min(attempt, 16));
    if (rateLimited) {
        ceiling = Math.max(ceiling, REJOIN_RATE_LIMITED_MIN_MS);
    }
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};

/**
 * Retry backoff for the topic-generation read after a `topic_rotated` hint.
 * The owner's live ink stays held until a read succeeds (see inkHeld), so a
 * failed read is retried, never given up on: exponential from
 * EPOCH_RETRY_BASE_MS to EPOCH_RETRY_MAX_MS, with the same equal jitter as a
 * re-join so a room the server just rotated does not ask in lockstep.
 */
export const EPOCH_RETRY_BASE_MS = 500;
export const EPOCH_RETRY_MAX_MS = 30_000;

/** Delay before generation re-read `attempt` (0-based): bounded on both sides, like rejoinDelayMs. */
export const epochRetryDelayMs = (attempt: number, random: () => number = Math.random): number => {
    const ceiling = Math.min(EPOCH_RETRY_MAX_MS, EPOCH_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};

/**
 * Spread before a `topic_rotated` hint is followed (the generation re-read,
 * then the rejoin and its gap-fill pull): a rotation tells every member of the
 * score at once, and one commit may rotate hundreds of scores (a district's
 * soft delete, a plan lapse archiving a library), so without it every open
 * device would read, join and pull in the same instant. Uniform over
 * 0..ROTATION_JITTER_MAX_MS; hints that land while one is waiting join it.
 */
export const ROTATION_JITTER_MAX_MS = 2000;

export const rotationJitterMs = (random: () => number = Math.random): number =>
    Math.round(random() * ROTATION_JITTER_MAX_MS);

/**
 * How long doc-db:{id} may be out before we stop waiting for it and pull
 * instead. A healthy (re-)join lands well inside this; anything slower means
 * the join is being refused or retried (e.g. the frontend is live before
 * migration 20261007120101), or the server closed the channel and its re-join
 * is backing off.
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
    /**
     * This user's own access to the document may have changed: the server
     * broadcast a role change or removal for them, or the channel join was
     * refused (Realtime re-checks membership only when a channel joins, so a
     * refusal on rejoin is the other way a removal shows up). The receiver
     * re-reads its role rather than trusting either signal.
     */
    onMembershipChanged?: () => void;
    /**
     * Read the score's realtime topic generation (realtime_topic_epoch,
     * migration 20261020150100; see TopicEpochRead). A throw counts as
     * 'failed'. Absent: always generation 0.
     */
    fetchTopicEpoch?: () => Promise<TopicEpochRead>;
}

/**
 * One read of a score's topic generation. Only the server's own answer moves
 * the channel, so a failed read is kept apart from both answers rather than
 * standing in for either:
 *  - 'epoch': this user may open the score, at this generation (0 until a
 *    takedown moves it to fresh topics).
 *  - 'denied': a definite no. This user may not open the score (any more).
 *  - 'failed': no answer, which says nothing about access.
 */
export type TopicEpochRead = { status: 'epoch'; epoch: number } | { status: 'denied' } | { status: 'failed' };

const EPOCH_READ_FAILED: TopicEpochRead = { status: 'failed' };

/**
 * The suffix of a score's topics at generation `epoch`. Generation 0 is the
 * plain topic, so nothing changes for a score no takedown has rotated; after
 * one, the server sends only to `{topic}:{n}` and admits a join there only
 * (20261020150100_takedown_realtime_topics): whoever it shut out is left on a
 * topic nobody talks on.
 */
const generation = (epoch: number): string => (epoch > 0 ? `:${epoch}` : '');

/** Private topic for presence and live ink — members may send on it. */
export const docTopic = (docId: string, epoch = 0): string => `doc:${docId}${generation(epoch)}`;

/**
 * Private topic for server-authored events: committed annotation rows, PDF
 * replacement and play-along status, all written by database triggers. RLS lets
 * members receive on it and no client send on it (migration
 * 20261007120101_realtime_db_topic). It is separate from doc:{id} because
 * Realtime authorizes a channel's sends for every event name at once, so on a
 * shared topic any editor could broadcast a hand-made 'INSERT' that peers
 * would apply as a committed row (forged author, forged seq).
 */
export const docDbTopic = (docId: string, epoch = 0): string => `doc-db:${docId}${generation(epoch)}`;

/**
 * The score's topic generation for fetchTopicEpoch.
 *
 * Telling a definite denial from a transient failure: realtime_topic_epoch
 * runs under this request's own token and returns null exactly when
 * document_role() does, i.e. the caller is not (or no longer) a member, a
 * takedown shuts them out (restricted: everyone but the owner; removed:
 * everyone), or the score is gone -- and also while the score is archived,
 * when the realtime policies refuse every join (20261022120100), so the
 * channels stop rather than retry. That is the check RLS makes, read fresh on
 * every request, so only a response that arrived with no error and a SQL
 * null body is 'denied'.
 *
 * Everything else is 'failed': a throw (offline, aborted), any error object
 * (network, timeout, every HTTP 4xx/5xx, among them a 401 from an expired
 * token that the next refresh fixes and a 404 from a server without the
 * function), and a 2xx body that is not a non-negative integer. None of those
 * says anything about access, so when unsure it is a failure, and a failure
 * after a rotation hint keeps the owner's ink held (fail closed).
 */
export const fetchRealtimeTopicEpoch = async (
    supabase: TypedSupabaseClient,
    docId: string,
): Promise<TopicEpochRead> => {
    let data: unknown;
    let error: unknown;
    try {
        ({ data, error } = await supabase.rpc('realtime_topic_epoch', { p_document: docId }));
    } catch {
        return EPOCH_READ_FAILED;
    }
    if (error) {
        return EPOCH_READ_FAILED;
    }
    if (data === null) {
        return { status: 'denied' };
    }
    return typeof data === 'number' && Number.isInteger(data) && data >= 0
        ? { status: 'epoch', epoch: data }
        : EPOCH_READ_FAILED;
};

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
    /** doc:{id} re-joined after a drop and onReconnect has not run for it yet. */
    private liveRejoined = false;
    private stopped = false;

    // Topic generation (see fetchTopicEpoch and moveToEpoch).
    private epoch = 0;
    private epochCheck: Promise<void> | null = null;
    private epochCheckAgain = false;
    /**
     * The server said the topics moved and no read of the new generation has
     * succeeded yet: nothing goes out on doc:{id} (no live ink, no presence),
     * since whoever is still on it may be exactly who the takedown shut out,
     * and Realtime keeps the permissions it checked when they joined. Only a
     * successful read lifts it; a failed one keeps it and retries.
     */
    private inkHeld = false;
    /** Failed reads in a row while held (see epochRetryDelayMs); a successful read resets it. */
    private epochRetryAttempts = 0;
    private epochRetryTimer: ReturnType<typeof setTimeout> | null = null;
    /** A rotation hint's jittered follow-up (see onTopicRotated); while it waits, reads decide nothing. */
    private rotationTimer: ReturnType<typeof setTimeout> | null = null;

    // Re-join after a drop (see scheduleRejoin).
    private readonly rejoinTimers: Record<ChannelKey, ReturnType<typeof setTimeout> | null> = { live: null, db: null };
    private readonly rejoinAttempts: Record<ChannelKey, number> = { live: 0, db: 0 };
    private readonly joinedAt: Record<ChannelKey, number | null> = { live: null, db: null };

    // Server rate-limit backoff (see RATE_LIMIT_MAX_LEVEL).
    private rateLimitLevel = 0;
    private lastRateLimitAt = -Infinity;
    private rateLimitDecayTimer: ReturnType<typeof setTimeout> | null = null;

    // Fallback when doc-db:{id} is not joined (see armDbFallback).
    private dbGraceTimer: ReturnType<typeof setTimeout> | null = null;
    private dbPollTimer: ReturnType<typeof setInterval> | null = null;
    private dbInkPullTimer: ReturnType<typeof setTimeout> | null = null;
    /** Committed rows have had no live path since this was set; a db join must pull. */
    private dbFallback = false;

    // Live-ink batching state.
    private meta: StrokeMeta | null = null;
    private pending: number[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Some of the current stroke went out, so a cancel has something to retract. */
    private strokeStreamed = false;
    /** True when at least one other member is on the channel (solo → no live ink). */
    private hasRemoteAudience = false;
    /** Members on doc:{id} at the last presence sync, this user included. */
    private members = 0;

    // Presence track coalescing (page-only payload).
    private lastTrackedPage: number | null = null;
    private lastPresenceTrackAt = 0;
    private presenceTrackTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private opts: DocRealtimeChannelOptions) {}

    start(): void {
        if (!this.opts.fetchTopicEpoch) {
            this.openLive();
            this.openDb();
            return;
        }
        // Channels open once the generation is known (or could not be asked).
        this.refreshEpoch();
    }

    /**
     * Re-read the topic generation and act on the answer (applyEpochRead).
     * Runs on start, on the server's `topic_rotated` hint, on a refused join
     * (a stale generation is refused) and on a retry. Never two reads at
     * once: a call that lands mid-read makes the read go again, and the
     * answer that was in flight decides nothing, since the server may have
     * given it before whatever prompted the call (a newer rotation). A call
     * also supersedes a retry still waiting, so one loop runs, never two.
     */
    private refreshEpoch(): void {
        const fetchEpoch = this.opts.fetchTopicEpoch;
        if (!fetchEpoch || this.stopped) {
            return;
        }
        this.clearEpochRetry();
        if (this.epochCheck) {
            this.epochCheckAgain = true;
            return;
        }
        const run = async (): Promise<TopicEpochRead | null> => {
            let read: TopicEpochRead;
            do {
                this.epochCheckAgain = false;
                try {
                    read = await fetchEpoch();
                } catch {
                    read = EPOCH_READ_FAILED;
                }
                if (this.stopped) {
                    return null;
                }
            } while (this.epochCheckAgain);
            return read;
        };
        this.epochCheck = run().then((read) => {
            this.epochCheck = null;
            // A hint landed meanwhile and its follow-up reads again: this
            // answer may predate that rotation.
            if (read && !this.stopped && !this.rotationTimer) {
                this.applyEpochRead(read);
            }
        });
    }

    /**
     * Only the server's answer moves the channel or lifts the hold:
     *  - 'epoch': move both channels if the generation changed, then let ink go.
     *  - 'denied': close everything now (closeOnDenial). Never retried.
     *  - 'failed': says nothing about access. After a hint, stay held and try
     *    again with backoff; nothing goes out meanwhile. Otherwise (start, a
     *    refused join) open generation 0 if nothing is open yet: a fresh join
     *    is authorized against the current generation, so a wrong guess is
     *    refused, never admitted, and the refusal asks again.
     */
    private applyEpochRead(read: TopicEpochRead): void {
        if (read.status === 'denied') {
            this.closeOnDenial();
            return;
        }
        if (read.status === 'failed') {
            if (this.inkHeld) {
                this.scheduleEpochRetry();
            } else if (!this.channel && !this.dbChannel) {
                this.openLive();
                this.openDb();
            }
            return;
        }
        this.epochRetryAttempts = 0;
        const move = read.epoch !== this.epoch && (this.channel !== null || this.dbChannel !== null);
        if (move) {
            this.moveToEpoch(read.epoch);
        } else {
            this.epoch = read.epoch;
        }
        const wasHeld = this.inkHeld;
        this.inkHeld = false;
        if (!this.channel && !this.dbChannel) {
            this.openLive();
            this.openDb();
        } else if (wasHeld && !move) {
            // Same topics after all (a forged hint): say again what was held back.
            this.trackPresence({ force: true });
        }
    }

    private scheduleEpochRetry(): void {
        if (this.stopped || this.epochRetryTimer) {
            return;
        }
        const delay = epochRetryDelayMs(this.epochRetryAttempts);
        this.epochRetryAttempts += 1;
        this.epochRetryTimer = setTimeout(() => {
            this.epochRetryTimer = null;
            this.refreshEpoch();
        }, delay);
    }

    private clearEpochRetry(): void {
        if (this.epochRetryTimer) {
            clearTimeout(this.epochRetryTimer);
            this.epochRetryTimer = null;
        }
    }

    /**
     * The server said this user may not open the score (any more). Leave both
     * topics at once rather than wait for a re-check: a channel joined before
     * the takedown keeps the permissions Realtime cached at join, so leaving is
     * the only thing that stops ink going out on it. Then stop for good (no
     * re-join, retry or fallback pull) and let the app's re-check show the
     * restricted state.
     */
    private closeOnDenial(): void {
        this.inkHeld = true;
        this.stop();
        this.opts.onMembershipChanged?.();
    }

    /** Leave both topics for generation `epoch`'s (see leaveTopics). */
    private moveToEpoch(epoch: number): void {
        this.epoch = epoch;
        this.leaveTopics();
        this.openLive();
        this.openDb();
    }

    /**
     * Leave both topics. Whatever joins next is a re-join: once both are
     * back, onReconnect clears live ink and pulls what was committed while
     * neither topic was joined.
     */
    private leaveTopics(): void {
        const { supabase } = this.opts;
        const old = [this.channel, this.dbChannel];
        this.channel = null;
        this.dbChannel = null;
        for (const key of ['live', 'db'] as const) {
            this.clearRejoinTimer(key);
            this.joined[key] = false;
            this.joinedAt[key] = null;
            this.rejoinAttempts[key] = 0;
            this.everJoined[key] = true;
        }
        this.dropLiveAudience();
        for (const channel of old) {
            if (channel) {
                void supabase.removeChannel(channel).catch(() => undefined);
            }
        }
    }

    /**
     * The server moved this score's topics: stop live ink and presence now,
     * then follow.
     *
     * On the server's own word -- the hint on doc-db:{id}, where no client can
     * send -- both old topics are left at once, before the new generation is
     * even read. Realtime keeps the permissions it checked when a channel
     * joined until that client refreshes its token, and cannot evict anyone,
     * so a member who just lost the score, if their app ignores the hint,
     * stays on the old topics for up to an hour (jwt_expiry) able to send and
     * hear there (20261022120100). Leaving at once is what keeps this device's
     * presence and anything it would hear out of their reach; the server
     * already sends only on the new generation.
     *
     * The same hint on doc:{id} is left on at once only while doc-db:{id} is
     * not joined, when it is the only word this device gets. Otherwise any
     * member could send it there, so it holds and re-reads: a genuine one is
     * followed by doc-db:{id}'s in the same commit, and a forged one moves
     * nothing (applyEpochRead lets go on the same topics).
     *
     * The re-read and rejoin wait rotationJitterMs, once per burst: further
     * hints while it waits (the other topic's, a second rotation) join it,
     * and a read already in flight decides nothing.
     */
    private onTopicRotated(payload: unknown, from: RealtimeChannel): void {
        if (
            this.stopped ||
            (from !== this.channel && from !== this.dbChannel) ||
            parseTopicRotated(payload)?.document_id !== this.opts.docId ||
            !this.opts.fetchTopicEpoch
        ) {
            return;
        }
        this.inkHeld = true;
        this.dropLiveAudience();
        if (from === this.dbChannel || !this.joined.db) {
            this.leaveTopics();
            // Committed rows have no live path until the rejoin: pull if it is slow.
            this.updateDbFallback();
        }
        if (this.rotationTimer) {
            return;
        }
        this.clearEpochRetry();
        this.rotationTimer = setTimeout(() => {
            this.rotationTimer = null;
            this.refreshEpoch();
        }, rotationJitterMs());
    }

    /** Nobody is reachable on doc:{id} until a presence sync says so again. */
    private dropLiveAudience(): void {
        this.hasRemoteAudience = false;
        this.pending = [];
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    private openLive(): void {
        const { supabase, docId, self } = this.opts;
        const channel = supabase.channel(docTopic(docId, this.epoch), {
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

        // The membership event (document_members_broadcast trigger) is sent on
        // this topic, so any editor could forge one too. That is harmless: it is
        // only a hint — the receiver re-reads its own role over PostgREST and
        // never acts on the payload.
        channel.on('broadcast', { event: MEMBERSHIP_EVENT }, ({ payload }) => {
            const msg = parseMembershipChange(payload);
            // Other members' changes are none of this client's business; the
            // presence bar already follows who is here.
            if (msg && msg.document_id === docId && msg.user_id === self.userId) {
                this.opts.onMembershipChanged?.();
            }
        });

        // Any member could forge this one here too; it only makes us re-read
        // (and rejoin, while doc-db:{id} is down: see onTopicRotated).
        channel.on('broadcast', { event: TOPIC_ROTATED_EVENT }, ({ payload }) => this.onTopicRotated(payload, channel));

        channel.on('presence', { event: 'sync' }, () => {
            const state = channel.presenceState<Record<string, unknown>>();
            const peers: PresencePeer[] = [];
            for (const metas of Object.values(state)) {
                const first = metas[0];
                const parsed = presenceSchema.safeParse(first);
                if (parsed.success) {
                    // An older build announces its email when it has no
                    // display name; it is not shown as one here.
                    peers.push({ ...parsed.data, name: safePresenceName(parsed.data.name, parsed.data.isAnonymous) });
                }
            }
            this.members = peers.length;
            this.hasRemoteAudience = peers.some((p) => p.userId !== self.userId);
            this.opts.onPeers(peers);
        });

        // The server's rate-limit notice arrives here, just before it closes the channel.
        channel.on('system', {}, (payload: unknown) => this.onSystem(payload));

        this.channel = channel;
        channel.subscribe((status, err) => {
            // A channel replaced by a re-join, or stop(): its late events mean nothing.
            if (this.channel !== channel) {
                return;
            }
            const rateLimited = isRateLimitText(err?.message);
            if (rateLimited) {
                this.noteRateLimit();
            }
            if (status === 'CHANNEL_ERROR' && !rateLimited) {
                // Also what a refused join looks like: a removed member's
                // rejoin fails the realtime.messages policy on doc:{id}. A
                // transport error lands here too; the re-check tells them
                // apart. (doc-db:{id} refusals are left to the polling
                // fallback: before migration 20261007120101 every member's
                // join there is refused, which says nothing about access —
                // nor does a join refused by the rate limiter.)
                this.opts.onMembershipChanged?.();
                // Or the score moved to a new generation while we were away,
                // and the old one is refused.
                this.refreshEpoch();
            }
            // Join state first: presence and live ink only go out while joined.
            this.onChannelStatus('live', status);
            if (status === 'SUBSCRIBED') {
                // Only write path for track() — force so join/reconnect always announce.
                this.trackPresence({ force: true });
            }
        });
    }

    private openDb(): void {
        const { supabase, docId } = this.opts;
        // Receive-only: no presence, and nothing is ever sent on it.
        const dbChannel = supabase.channel(docDbTopic(docId, this.epoch), {
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
        // Server-authored, so unforgeable here: a takedown or a lost membership moved the score.
        dbChannel.on('broadcast', { event: TOPIC_ROTATED_EVENT }, ({ payload }) =>
            this.onTopicRotated(payload, dbChannel),
        );
        dbChannel.on('system', {}, (payload: unknown) => this.onSystem(payload));
        this.dbChannel = dbChannel;
        dbChannel.subscribe((status, err) => {
            if (this.dbChannel !== dbChannel) {
                return;
            }
            if (isRateLimitText(err?.message)) {
                this.noteRateLimit();
            }
            this.onChannelStatus('db', status);
        });
    }

    /**
     * Re-join bookkeeping across the two channels. A drop usually takes both
     * (they share one socket), and the gap-fill pull must start only once
     * committed rows have a path again — otherwise a row committed between
     * the pull and the db channel's re-join would be missed by both. So
     * onReconnect (clear live ink, pull) fires once both are joined after
     * doc:{id} re-joined, and onResync (pull) once doc-db:{id} is back after
     * only it dropped; the first join of each is not a reconnect.
     *
     * Waiting on doc-db:{id} is bounded, though: while it is not joined —
     * whatever doc:{id} is doing — the channel pulls instead (see
     * armDbFallback), and those pulls are then the path, so neither side
     * waits for the other. Every drop also arms a re-join (scheduleRejoin):
     * realtime-js gives up on a channel the server closed, which is how the
     * rate limiter sheds clients.
     */
    private onChannelStatus(key: ChannelKey, status: string): void {
        if (this.stopped) {
            return;
        }
        if (status !== 'SUBSCRIBED') {
            const joinedAt = this.joinedAt[key];
            if (joinedAt !== null && Date.now() - joinedAt >= REJOIN_STABLE_MS) {
                this.rejoinAttempts[key] = 0;
            }
            this.joinedAt[key] = null;
            this.joined[key] = false;
            if (key === 'live') {
                // Whoever was watching is not reachable until the rejoin's
                // presence sync says so again; a stroke drawn meanwhile is
                // not streamed (it still lands as a committed row).
                this.dropLiveAudience();
            }
            this.updateDbFallback();
            this.scheduleRejoin(key);
            return;
        }
        this.clearRejoinTimer(key);
        this.joinedAt[key] = Date.now();
        this.joined[key] = true;
        const rejoined = this.everJoined[key];
        this.everJoined[key] = true;
        if (key === 'live' && rejoined) {
            this.liveRejoined = true;
        }
        if (key === 'db') {
            // Committed rows flow again. Rows committed while it was down (or
            // since the last fallback poll) reached nobody: pull them now,
            // whether or not doc:{id} is back yet.
            const missedRows = rejoined || this.dbFallback;
            this.leaveDbFallback();
            if (this.joined.live && this.liveRejoined) {
                this.liveRejoined = false;
                this.opts.onReconnect();
            } else if (missedRows) {
                this.opts.onResync();
            }
            return;
        }
        if (this.joined.db) {
            if (this.liveRejoined) {
                this.liveRejoined = false;
                this.opts.onReconnect();
            }
        } else if (this.dbFallback && this.liveRejoined) {
            // Committed rows only come from polls while doc-db:{id} is out, so
            // waiting for it gains nothing: clear the stale live ink and pull now.
            this.liveRejoined = false;
            this.opts.onReconnect();
        }
        this.updateDbFallback();
    }

    /** Start or stop the polling fallback as doc-db:{id}'s join state changes. */
    private updateDbFallback(): void {
        if (this.joined.db) {
            this.clearDbFallbackTimers();
        } else {
            this.armDbFallback();
        }
    }

    /**
     * doc-db:{id} is not joined. Give it DB_JOIN_GRACE_MS, then run whatever
     * gap-fill was waiting on it and keep pulling every DB_FALLBACK_POLL_MS
     * (plus shortly after each peer stroke ends) until it joins. This runs
     * whether or not doc:{id} is joined: a pull is a plain HTTPS request, so
     * it still works after the server has shed this client's channels, and
     * offline it fails cheaply.
     */
    private armDbFallback(): void {
        if (this.dbGraceTimer || this.dbPollTimer) {
            return;
        }
        this.dbGraceTimer = setTimeout(() => {
            this.dbGraceTimer = null;
            if (this.stopped || this.joined.db) {
                return;
            }
            this.dbFallback = true;
            if (this.liveRejoined && this.joined.live) {
                this.liveRejoined = false;
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

    // ---- Re-join ---------------------------------------------------------

    /**
     * Arm the re-join of a channel that left 'joined'. When it fires, a channel
     * still not joined is replaced by a fresh one: a closed channel is dead to
     * realtime-js, and an errored one has had realtime-js's own retries (which
     * have no jitter) for as long as our backoff allowed. Two cases are left
     * to realtime-js and simply re-armed: a join already in flight, and an
     * errored channel whose socket is down — realtime-js re-joins those when
     * the socket reopens. A SUBSCRIBED meanwhile cancels the timer.
     */
    private scheduleRejoin(key: ChannelKey): void {
        if (this.stopped || this.rejoinTimers[key]) {
            return;
        }
        const delay = rejoinDelayMs(this.rejoinAttempts[key], this.rateLimitLevel > 0);
        this.rejoinAttempts[key] += 1;
        this.rejoinTimers[key] = setTimeout(() => {
            this.rejoinTimers[key] = null;
            void this.rejoin(key);
        }, delay);
    }

    private clearRejoinTimer(key: ChannelKey): void {
        const timer = this.rejoinTimers[key];
        if (timer) {
            clearTimeout(timer);
            this.rejoinTimers[key] = null;
        }
    }

    private async rejoin(key: ChannelKey): Promise<void> {
        if (this.stopped || this.joined[key]) {
            return;
        }
        const { supabase } = this.opts;
        const old = key === 'live' ? this.channel : this.dbChannel;
        if (old && (old.state === 'joining' || (old.state === 'errored' && !supabase.realtime.isConnected()))) {
            this.scheduleRejoin(key);
            return;
        }
        // Detach first, so the CLOSED its removal reports is ignored.
        if (key === 'live') {
            this.channel = null;
        } else {
            this.dbChannel = null;
        }
        if (old) {
            // Also takes it off the client's channel list, without which
            // supabase.channel() would hand the dead channel straight back.
            await supabase.removeChannel(old).catch(() => undefined);
        }
        if (this.stopped) {
            return;
        }
        if (key === 'live') {
            this.openLive();
        } else {
            this.openDb();
        }
    }

    // ---- Server rate limits ----------------------------------------------

    private onSystem(payload: unknown): void {
        if (typeof payload !== 'object' || payload === null) {
            return;
        }
        const { status, message } = payload as { status?: unknown; message?: unknown };
        if (status === 'error' && isRateLimitText(message)) {
            this.noteRateLimit();
        }
    }

    private noteRateLimit(): void {
        if (this.stopped) {
            return;
        }
        const now = Date.now();
        if (now - this.lastRateLimitAt >= RATE_LIMIT_MERGE_MS) {
            this.rateLimitLevel = Math.min(RATE_LIMIT_MAX_LEVEL, this.rateLimitLevel + 1);
        }
        this.lastRateLimitAt = now;
        this.armRateLimitDecay();
    }

    private armRateLimitDecay(): void {
        if (this.rateLimitDecayTimer) {
            clearTimeout(this.rateLimitDecayTimer);
        }
        this.rateLimitDecayTimer = setTimeout(() => {
            this.rateLimitDecayTimer = null;
            this.rateLimitLevel = Math.max(0, this.rateLimitLevel - 1);
            if (this.rateLimitLevel > 0) {
                this.armRateLimitDecay();
            }
        }, RATE_LIMIT_DECAY_MS);
    }

    /** Live-ink batch cadence right now; null while only pen-up is streamed. */
    private inkFlushMs(): number | null {
        if (this.rateLimitLevel >= RATE_LIMIT_MAX_LEVEL) {
            return null;
        }
        const base = Math.min(FLUSH_MAX_MS, Math.max(FLUSH_MIN_MS, this.members * FLUSH_MS_PER_MEMBER));
        return Math.min(FLUSH_DEGRADED_MAX_MS, base * 2 ** this.rateLimitLevel);
    }

    stop(): void {
        this.stopped = true;
        this.clearEpochRetry();
        if (this.rotationTimer) {
            clearTimeout(this.rotationTimer);
            this.rotationTimer = null;
        }
        this.leaveDbFallback();
        this.clearRejoinTimer('live');
        this.clearRejoinTimer('db');
        if (this.rateLimitDecayTimer) {
            clearTimeout(this.rateLimitDecayTimer);
            this.rateLimitDecayTimer = null;
        }
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
     * PdfViewport already debounces scroll at 400ms; this adds a min gap
     * (PRESENCE_TRACK_MIN_MS, doubled per rate-limit level, SUBSCRIBED
     * reconnects included) so we do not trip the presence rate limit.
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
        // Not while the channel is down: realtime-js would queue the push and
        // replay it on rejoin, and the rejoin announces itself (force) anyway.
        // Nor while held: the topic may have moved, and lifting announces.
        if (this.stopped || this.inkHeld || !channel || !this.joined.live) {
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
        const minGap = PRESENCE_TRACK_MIN_MS * 2 ** this.rateLimitLevel;
        const elapsed = Date.now() - this.lastPresenceTrackAt;
        if (elapsed < minGap) {
            this.presenceTrackTimer = setTimeout(
                () => this.trackPresence(force ? { force: true } : undefined),
                minGap - elapsed,
            );
            return;
        }
        this.lastTrackedPage = page;
        this.lastPresenceTrackAt = Date.now();
        void channel
            .track({ ...this.opts.self })
            .then((result) => {
                if (isRateLimitText(result)) {
                    this.noteRateLimit();
                }
            })
            .catch(() => undefined);
    }

    /** doc:{id} is joined right now, so a send goes over the websocket. */
    private isLive(): boolean {
        return this.joined.live && this.channel?.state === 'joined';
    }

    // ---- Live ink publishing (called by InkController) -------------------

    readonly publisher: LiveInkPublisher = {
        start: (meta) => {
            this.meta = meta;
            this.pending = [];
            this.strokeStreamed = false;
        },
        append: (pts) => {
            // Held: a presence sync may say someone is here, but they may be
            // on a topic the score left. Nothing is buffered for them.
            if (!this.meta || !this.hasRemoteAudience || this.inkHeld) {
                return;
            }
            this.pending.push(...pts);
            const interval = this.inkFlushMs();
            const maxPoints = interval === null ? PEN_UP_MAX_POINTS : FLUSH_MAX_POINTS;
            if (this.pending.length / 3 >= maxPoints) {
                this.flushInk();
            } else if (interval !== null && !this.flushTimer) {
                this.flushTimer = setTimeout(() => this.flushInk(), interval);
            }
        },
        end: () => {
            // The final batch carries whatever is left, pen-up point included.
            this.flushInk({ done: true });
            this.meta = null;
        },
        cancel: () => {
            const meta = this.meta;
            const streamed = this.strokeStreamed;
            this.meta = null;
            this.pending = [];
            this.strokeStreamed = false;
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            // Nothing went out, so peers have no preview to drop.
            if (meta && streamed && this.hasRemoteAudience) {
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
        // An empty pen-up only closes a preview peers actually have.
        if (extra && this.pending.length === 0 && !this.strokeStreamed) {
            return;
        }
        const pts = this.pending;
        this.pending = [];
        if (this.send({ ...metaToMsg(meta, this.opts.self.userId), pts, ...(extra ?? {}) })) {
            this.strokeStreamed = true;
        }
    }

    /**
     * Live ink rides the websocket or not at all. On a channel that is not
     * joined realtime-js falls back to one REST request per send — a burst of
     * them for every stroke while Realtime is down — for previews nobody can
     * receive. Committed strokes still reach everyone through the outbox.
     * Returns whether the batch went out.
     */
    private send(payload: InkProgressMsg): boolean {
        if (!this.channel || this.stopped || this.inkHeld || !this.hasRemoteAudience || !this.isLive()) {
            return false;
        }
        void this.channel
            .send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload })
            .then((result) => {
                // Without acks a websocket send resolves 'ok' at once, so the
                // server's `system` notice is the real signal; a rate-limit
                // result (older realtime-js said 'rate limited') still counts.
                if (isRateLimitText(result)) {
                    this.noteRateLimit();
                }
            })
            .catch(() => undefined);
        return true;
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
