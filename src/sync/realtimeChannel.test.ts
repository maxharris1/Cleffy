import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    DB_FALLBACK_INK_PULL_MS,
    DB_FALLBACK_POLL_MS,
    DB_JOIN_GRACE_MS,
    DocRealtimeChannel,
    PRESENCE_TRACK_MIN_MS,
    RATE_LIMIT_DECAY_MS,
    RATE_LIMIT_MAX_LEVEL,
    REJOIN_BASE_MS,
    REJOIN_MAX_MS,
    REJOIN_RATE_LIMITED_MIN_MS,
    REJOIN_STABLE_MS,
    EPOCH_RETRY_BASE_MS,
    EPOCH_RETRY_MAX_MS,
    ROTATION_JITTER_MAX_MS,
    ARCHIVED_RECHECK_MS,
    ARCHIVED_WAKE_MIN_MS,
    archivedRecheckDelayMs,
    docDbTopic,
    docTopic,
    epochRetryDelayMs,
    fetchRealtimeTopicEpoch,
    rejoinDelayMs,
    rotationJitterMs,
    type DocRealtimeChannelOptions,
    type TopicEpochRead,
} from '@/sync/realtimeChannel';
import {
    INK_PROGRESS_EVENT,
    MEMBERSHIP_EVENT,
    SCORE_ANALYSIS_EVENT,
    TOPIC_ROTATED_EVENT,
    parseMembershipChange,
    type InkProgressMsg,
} from '@/sync/wire';
import type { AnnotationRow } from '@/types/database';

const DOC = 'c0ffee00-0000-4000-8000-000000000001';
const SELF = 'user-self';
const PEER = 'user-peer';

type Handler = (msg: { payload: unknown }) => void;

/** Just enough of a realtime-js channel to drive DocRealtimeChannel. */
class FakeChannel {
    readonly handlers: Array<{ type: string; event: string; handler: Handler }> = [];
    statusCallback: ((status: string, err?: Error) => void) | null = null;
    state = 'joined';

    constructor(
        readonly topic: string,
        readonly options: unknown,
    ) {}

    on(type: string, filter: { event?: string }, handler: Handler) {
        this.handlers.push({ type, event: filter.event ?? '', handler });
        return this;
    }

    subscribe(callback: (status: string, err?: Error) => void) {
        this.statusCallback = callback;
        return this;
    }

    track = vi.fn(async () => 'ok');
    send = vi.fn(async () => 'ok');
    presenceState = () => ({});

    /** Deliver a broadcast as the Realtime server would to this topic. */
    broadcast(event: string, payload: unknown): void {
        for (const h of this.handlers) {
            if (h.type === 'broadcast' && h.event === event) {
                h.handler({ payload });
            }
        }
    }

    events(type: string): string[] {
        return this.handlers.filter((h) => h.type === type).map((h) => h.event);
    }

    /** Report a subscribe status, moving `state` the way realtime-js does. */
    status(status: string, err?: Error): void {
        this.state = status === 'SUBSCRIBED' ? 'joined' : status === 'CLOSED' ? 'closed' : 'errored';
        this.statusCallback?.(status, err);
    }

    /** Deliver a server `system` message (e.g. the rate limiter's notice). */
    system(payload: unknown): void {
        for (const h of this.handlers) {
            if (h.type === 'system') {
                h.handler(payload as { payload: unknown });
            }
        }
    }
}

const row = (overrides: Partial<AnnotationRow> = {}): AnnotationRow => ({
    id: 'a1',
    document_id: DOC,
    page: 0,
    kind: 'stroke',
    color: '#000000',
    payload: { pts: [0, 0, 1], w: 0.01 },
    created_by: PEER,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    seq: 7,
    ...overrides,
});

/** The broadcast_changes() envelope the annotations trigger sends. */
const dbChange = (record: AnnotationRow) => ({
    operation: 'INSERT',
    schema: 'public',
    table: 'annotations',
    record,
    old_record: null,
});

const setup = (overrides: Partial<DocRealtimeChannelOptions> = {}) => {
    const channels: FakeChannel[] = [];
    const removed: FakeChannel[] = [];
    const socket = { connected: true };
    const supabase = {
        realtime: { isConnected: () => socket.connected },
        channel: (topic: string, options: unknown) => {
            const ch = new FakeChannel(topic, options);
            channels.push(ch);
            return ch;
        },
        removeChannel: async (ch: FakeChannel) => {
            removed.push(ch);
            return 'ok';
        },
    } as unknown as TypedSupabaseClient;
    const opts: DocRealtimeChannelOptions = {
        supabase,
        docId: DOC,
        self: { userId: SELF, name: 'Me', color: '#123456', page: 0, isAnonymous: false },
        onRemoteInk: vi.fn(),
        onDbChange: vi.fn(),
        onPeers: vi.fn(),
        onReconnect: vi.fn(),
        onResync: vi.fn(),
        onDocReplaced: vi.fn(),
        onScoreAnalysis: vi.fn(),
        ...overrides,
    };
    const rt = new DocRealtimeChannel(opts);
    rt.start();
    const live = channels.find((c) => c.topic === docTopic(DOC));
    const db = channels.find((c) => c.topic === docDbTopic(DOC));
    if (!live || !db) {
        throw new Error('expected both channels');
    }
    /** The channel currently open on a topic (a re-join replaces it). */
    const latest = (topic: string): FakeChannel => {
        const found = channels.filter((c) => c.topic === topic).at(-1);
        if (!found) {
            throw new Error(`no channel on ${topic}`);
        }
        return found;
    };
    return { rt, opts, live, db, channels, removed, socket, latest };
};

describe('DocRealtimeChannel topics', () => {
    it('joins a private presence/ink topic and a private receive-only committed-row topic', () => {
        const { channels, live, db } = setup();
        expect(channels.map((c) => c.topic)).toEqual([`doc:${DOC}`, `doc-db:${DOC}`]);
        expect(live.options).toMatchObject({ config: { private: true, presence: { key: SELF } } });
        expect(db.options).toMatchObject({ config: { private: true } });
        expect(db.options).not.toMatchObject({ config: { presence: expect.anything() } });
    });

    it('applies committed rows only from doc-db:{id}', () => {
        const { opts, db } = setup();
        db.broadcast('INSERT', dbChange(row()));
        db.broadcast('UPDATE', { ...dbChange(row({ color: '#ff0000', seq: 8 })), operation: 'UPDATE' });
        expect(opts.onDbChange).toHaveBeenCalledTimes(2);
        expect(opts.onDbChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a1', seq: 8 }));
    });

    it('ignores a committed-row event a member forges on doc:{id}', () => {
        const { opts, live } = setup();
        // Any editor may send on doc:{id}; a hand-made 'INSERT' there claims to
        // be the owner's mark with a huge seq. It must reach nothing.
        live.broadcast('INSERT', dbChange(row({ created_by: 'owner', seq: 9_000_000_000 })));
        live.broadcast('UPDATE', dbChange(row({ created_by: 'owner' })));
        live.broadcast('score_analysis', {
            table: 'score_analyses',
            document_id: DOC,
            status: 'ready',
            updated_at: '2026-01-01T00:00:00.000Z',
        });
        live.broadcast('INSERT', { table: 'documents', record: { id: DOC, content_rev: 99 } });
        expect(opts.onDbChange).not.toHaveBeenCalled();
        expect(opts.onScoreAnalysis).not.toHaveBeenCalled();
        expect(opts.onDocReplaced).not.toHaveBeenCalled();
        // Live ink, plus the membership hint (which only triggers a role
        // re-read over PostgREST, so a forged one changes nothing).
        // The topic hint, likewise, only makes the app re-read the generation.
        expect(live.events('broadcast')).toEqual([INK_PROGRESS_EVENT, MEMBERSHIP_EVENT, TOPIC_ROTATED_EVENT]);
    });

    it('still takes live ink from doc:{id}, never from doc-db:{id}', () => {
        const { opts, live, db } = setup();
        const ink = {
            strokeId: 's1',
            userId: PEER,
            page: 0,
            kind: 'stroke',
            color: '#000000',
            w: 0.01,
            pts: [0, 0, 1],
        };
        live.broadcast(INK_PROGRESS_EVENT, ink);
        expect(opts.onRemoteInk).toHaveBeenCalledWith(expect.objectContaining({ strokeId: 's1' }));
        expect(db.events('broadcast')).not.toContain(INK_PROGRESS_EVENT);
    });

    it('routes PDF replacement and play-along status from doc-db:{id}', () => {
        const { opts, db } = setup();
        db.broadcast('UPDATE', { table: 'documents', record: { id: DOC, content_rev: 3 } });
        expect(opts.onDocReplaced).toHaveBeenCalledWith(3);
        db.broadcast(SCORE_ANALYSIS_EVENT, {
            table: 'score_analyses',
            document_id: DOC,
            status: 'processing',
            progress: 2,
            updated_at: '2026-01-01T00:00:00.000Z',
        });
        expect(opts.onScoreAnalysis).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }));
    });
});

describe('DocRealtimeChannel reconnect', () => {
    it('does not treat the first join of both channels as a reconnect', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        expect(opts.onReconnect).not.toHaveBeenCalled();
        expect(live.track).toHaveBeenCalledTimes(1);
    });

    it('gap-fills once, only after the committed-row channel is back', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');

        // The socket drops: both channels error, then re-join one at a time.
        live.status('CHANNEL_ERROR');
        db.status('CHANNEL_ERROR');
        live.status('SUBSCRIBED');
        expect(opts.onReconnect).not.toHaveBeenCalled();
        db.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
    });

    it('gap-fills when only the committed-row channel re-joins, leaving live ink alone', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        db.status('TIMED_OUT');
        db.status('SUBSCRIBED');
        expect(opts.onResync).toHaveBeenCalledTimes(1);
        expect(opts.onReconnect).not.toHaveBeenCalled();
    });

    it('removes both channels on stop and ignores late status callbacks', () => {
        const { rt, opts, live, db, removed } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        rt.stop();
        expect(removed).toEqual([live, db]);
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        expect(opts.onReconnect).not.toHaveBeenCalled();
    });
});

const peerStroke = (extra: Record<string, unknown> = {}) => ({
    strokeId: 's1',
    userId: PEER,
    page: 0,
    kind: 'stroke',
    color: '#000000',
    w: 0.01,
    pts: [0, 0, 1],
    ...extra,
});

describe('DocRealtimeChannel when doc-db:{id} will not join', () => {
    // E.g. the frontend went live before migration 20261007120101: the
    // receive policy still refuses doc-db: topics and realtime-js keeps
    // retrying the join with CHANNEL_ERROR in between.
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does nothing while doc-db:{id} joins within the grace period', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS - 1);
        db.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 3);
        expect(opts.onResync).not.toHaveBeenCalled();
        expect(opts.onReconnect).not.toHaveBeenCalled();
    });

    it('gap-fills at once when the live channel reconnects while doc-db:{id} is polled', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('CHANNEL_ERROR');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        // Committed rows only come from the polls now, so the live re-join
        // has nothing to wait for.
        live.status('CHANNEL_ERROR');
        live.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(2);
    });

    it('gap-fills a reconnect whose doc-db:{id} re-join is refused', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        live.status('CHANNEL_ERROR');
        db.status('CHANNEL_ERROR');
        live.status('SUBSCRIBED');
        db.status('CHANNEL_ERROR');
        expect(opts.onReconnect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        expect(opts.onResync).not.toHaveBeenCalled();
    });

    it('polls while doc-db:{id} is missing, and stops once it joins', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 2);
        expect(opts.onResync).toHaveBeenCalledTimes(3);

        // The join finally succeeds: one pull covers the rows committed since
        // the last poll, and polling stops.
        db.status('SUBSCRIBED');
        expect(opts.onResync).toHaveBeenCalledTimes(4);
        expect(opts.onReconnect).not.toHaveBeenCalled();
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 3);
        expect(opts.onResync).toHaveBeenCalledTimes(4);
    });

    it('pulls shortly after a peer finishes a stroke, before its live preview expires', () => {
        const { opts, live } = setup();
        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        live.broadcast(INK_PROGRESS_EVENT, peerStroke());
        vi.advanceTimersByTime(DB_FALLBACK_INK_PULL_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        live.broadcast(INK_PROGRESS_EVENT, peerStroke({ pts: [], done: true }));
        vi.advanceTimersByTime(DB_FALLBACK_INK_PULL_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(2);
    });

    it('does not pull on finished strokes while doc-db:{id} is healthy', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        live.broadcast(INK_PROGRESS_EVENT, peerStroke({ done: true }));
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS);
        expect(opts.onResync).not.toHaveBeenCalled();
    });

    it('keeps polling while both channels are down', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');

        // The server sheds both channels (its rate limiter closes them).
        live.status('CLOSED');
        db.status('CLOSED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 3);
        expect(opts.onResync).toHaveBeenCalledTimes(4);
    });

    it('clears every fallback timer on stop', () => {
        const { rt, opts, live } = setup();
        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        live.broadcast(INK_PROGRESS_EVENT, peerStroke({ done: true }));
        rt.stop();
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 3);
        expect(opts.onResync).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

const membership = (userId: string, role: string | null, documentId = DOC) => ({
    table: 'document_members',
    document_id: documentId,
    user_id: userId,
    role,
    id: 'msg-id',
});

describe('membership broadcasts', () => {
    it('re-checks when this user’s own membership changes or ends (sent on doc:{id})', () => {
        const onMembershipChanged = vi.fn();
        const { live } = setup({ onMembershipChanged });

        live.broadcast('membership', membership(SELF, 'viewer'));
        live.broadcast('membership', membership(SELF, null));

        expect(onMembershipChanged).toHaveBeenCalledTimes(2);
    });

    it('ignores other members’ changes and other documents', () => {
        const onMembershipChanged = vi.fn();
        const { live } = setup({ onMembershipChanged });

        live.broadcast('membership', membership('someone-else', null));
        live.broadcast('membership', membership(SELF, null, 'doc-2'));

        expect(onMembershipChanged).not.toHaveBeenCalled();
    });

    it('ignores a malformed payload', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const onMembershipChanged = vi.fn();
        const { live } = setup({ onMembershipChanged });

        live.broadcast('membership', { table: 'document_members', user_id: SELF });

        expect(onMembershipChanged).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('re-checks when the doc:{id} join is refused, but not after stop', () => {
        const onMembershipChanged = vi.fn();
        const { live, rt } = setup({ onMembershipChanged });

        live.status('CHANNEL_ERROR');
        expect(onMembershipChanged).toHaveBeenCalledTimes(1);

        rt.stop();
        live.status('CHANNEL_ERROR');
        expect(onMembershipChanged).toHaveBeenCalledTimes(1);
    });

    it('leaves a refused doc-db:{id} join to the polling fallback, not an access re-check', () => {
        const onMembershipChanged = vi.fn();
        const { db } = setup({ onMembershipChanged });

        db.status('CHANNEL_ERROR');

        expect(onMembershipChanged).not.toHaveBeenCalled();
    });
});

describe('DocRealtimeChannel while doc:{id} is down', () => {
    const peerJoins = (live: FakeChannel) => {
        live.presenceState = () =>
            ({
                [PEER]: [{ userId: PEER, name: 'Peer', color: '#000000', page: 0, isAnonymous: false }],
            }) as ReturnType<FakeChannel['presenceState']>;
        for (const h of live.handlers) {
            if (h.type === 'presence' && h.event === 'sync') {
                h.handler({ payload: undefined });
            }
        }
    };

    const drawStroke = (rt: DocRealtimeChannel) => {
        rt.publisher.start({ strokeId: 's1', page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
        rt.publisher.append(new Array(3 * 50).fill(0.5));
        rt.publisher.end();
    };

    afterEach(() => {
        vi.useRealTimers();
    });

    it('streams live ink while joined with someone watching', () => {
        const { rt, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        peerJoins(live);

        drawStroke(rt);

        expect(live.send).toHaveBeenCalled();
    });

    it('sends no live ink (no REST fallback burst) once the channel drops', () => {
        const { rt, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        peerJoins(live);

        // The socket drops: realtime-js reports the channel and leaves its state.
        live.state = 'errored';
        live.status('CHANNEL_ERROR');
        drawStroke(rt);
        rt.publisher.cancel();

        expect(live.send).not.toHaveBeenCalled();
    });

    it('does not push presence while down, and announces itself again on rejoin', () => {
        vi.useFakeTimers();
        const { rt, live, db, socket } = setup();
        // The socket itself is down: realtime-js re-joins the errored channel
        // when it reopens, so the same channel object comes back.
        socket.connected = false;
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        expect(live.track).toHaveBeenCalledTimes(1);

        live.state = 'errored';
        live.status('TIMED_OUT');
        vi.advanceTimersByTime(5000);
        rt.setPage(3);
        vi.advanceTimersByTime(5000);
        expect(live.track).toHaveBeenCalledTimes(1);

        live.state = 'joined';
        live.status('SUBSCRIBED');
        expect(live.track).toHaveBeenCalledTimes(2);
        expect(live.track).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));
    });
});

/** The notice Realtime sends just before it closes a channel over the rate limit. */
const tooMany = { extension: 'system', status: 'error', message: 'Too many messages per second', channel: DOC };

/** A presence sync reporting `members` people on doc:{id}, this user included. */
const syncPresence = (ch: FakeChannel, members: number) => {
    const state: Record<string, unknown[]> = {};
    for (let i = 0; i < members; i++) {
        const userId = i === 0 ? SELF : `peer-${i}`;
        state[userId] = [{ userId, name: userId, color: '#000000', page: 0, isAnonymous: false }];
    }
    ch.presenceState = () => state as ReturnType<FakeChannel['presenceState']>;
    for (const h of ch.handlers) {
        if (h.type === 'presence' && h.event === 'sync') {
            h.handler({ payload: undefined });
        }
    }
};

/** Draw for `ms` with a point every 8 ms (a 120 Hz pen); returns the points appended. */
const drawFor = (rt: DocRealtimeChannel, ms: number): number => {
    rt.publisher.start({ strokeId: 's1', page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
    let points = 0;
    for (let t = 0; t < ms; t += 8) {
        rt.publisher.append([0.5, 0.5, 1]);
        points += 1;
        vi.advanceTimersByTime(8);
    }
    rt.publisher.end();
    return points;
};

const inkSent = (ch: FakeChannel): InkProgressMsg[] =>
    (ch.send.mock.calls as unknown as Array<[{ payload: InkProgressMsg }]>).map(([args]) => args.payload);

describe('DocRealtimeChannel re-joins channels the server dropped', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('re-joins both channels after the rate limiter closes them, pulling meanwhile', async () => {
        const { opts, live, db, removed, latest } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');

        // What the load test saw at 25 drawing users: a system notice, then
        // the server closes the channel. realtime-js never re-joins a
        // closed channel on its own.
        live.system(tooMany);
        live.status('CLOSED');
        db.status('CLOSED');
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS);

        const live2 = latest(docTopic(DOC));
        const db2 = latest(docDbTopic(DOC));
        expect(live2).not.toBe(live);
        expect(db2).not.toBe(db);
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        // Committed rows kept coming by pull while nothing was joined.
        expect(opts.onResync).toHaveBeenCalledTimes(2);
        expect(opts.onReconnect).not.toHaveBeenCalled();

        // Back on doc:{id}: stale previews go and a pull covers the gap.
        live2.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        expect(live2.track).toHaveBeenCalledTimes(1);
        // Back on doc-db:{id}: one more pull for rows since the last poll,
        // then polling stops.
        db2.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        expect(opts.onResync).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(DB_FALLBACK_POLL_MS * 2);
        expect(opts.onResync).toHaveBeenCalledTimes(3);
    });

    it('keeps re-joining a channel the server closes again and again, backing off to a bound', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1); // the longest delay of each step
        const { latest, channels } = setup();
        let ch = latest(docTopic(DOC));
        ch.status('SUBSCRIBED');
        const waits: number[] = [];
        for (let i = 0; i < 8; i++) {
            ch.status('CLOSED');
            let waited = 0;
            while (latest(docTopic(DOC)) === ch) {
                await vi.advanceTimersByTimeAsync(100);
                waited += 100;
                expect(waited).toBeLessThanOrEqual(REJOIN_MAX_MS);
            }
            waits.push(waited);
            ch = latest(docTopic(DOC));
            ch.status('SUBSCRIBED');
        }
        expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
        expect(channels.filter((c) => c.topic === docTopic(DOC))).toHaveLength(9);

        // A channel that then holds for a while starts over from the base.
        await vi.advanceTimersByTimeAsync(REJOIN_STABLE_MS);
        ch.status('CLOSED');
        await vi.advanceTimersByTimeAsync(REJOIN_BASE_MS);
        expect(latest(docTopic(DOC))).not.toBe(ch);
    });

    it('jitters each delay between half and all of its bounded ceiling', () => {
        expect(rejoinDelayMs(0, false, () => 0)).toBe(REJOIN_BASE_MS / 2);
        expect(rejoinDelayMs(0, false, () => 1)).toBe(REJOIN_BASE_MS);
        expect(rejoinDelayMs(3, false, () => 0.5)).toBe(6000);
        expect(rejoinDelayMs(50, false, () => 1)).toBe(REJOIN_MAX_MS);
        expect(rejoinDelayMs(50, false, () => 0)).toBe(REJOIN_MAX_MS / 2);
        // Rate-limited: an immediate retry would only be refused again.
        expect(rejoinDelayMs(0, true, () => 0)).toBe(REJOIN_RATE_LIMITED_MIN_MS / 2);
    });

    it('leaves an errored channel to realtime-js when it recovers in time', async () => {
        const { channels, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        live.status('CHANNEL_ERROR');
        // realtime-js's own re-join lands first.
        live.status('SUBSCRIBED');
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS * 2);
        expect(channels).toHaveLength(2);
    });

    it('replaces an errored channel realtime-js has not recovered, unless its socket is down or a join is in flight', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { live, db, socket, latest } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');

        // Socket down: realtime-js re-joins errored channels when it reopens.
        socket.connected = false;
        live.status('CHANNEL_ERROR');
        await vi.advanceTimersByTimeAsync(REJOIN_BASE_MS * 3);
        expect(latest(docTopic(DOC))).toBe(live);

        // Socket back, a join already in flight: let it answer.
        socket.connected = true;
        live.state = 'joining';
        await vi.advanceTimersByTimeAsync(REJOIN_BASE_MS * 4);
        expect(latest(docTopic(DOC))).toBe(live);

        // Socket up and still errored: start over with a fresh channel.
        live.state = 'errored';
        await vi.advanceTimersByTimeAsync(REJOIN_BASE_MS * 8);
        expect(latest(docTopic(DOC))).not.toBe(live);
    });

    it('ignores the replaced channel and pulls as soon as doc-db:{id} is back, before doc:{id}', async () => {
        const { opts, live, db, latest } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        live.status('CLOSED');
        db.status('CLOSED');
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS / 2);
        const db2 = latest(docDbTopic(DOC));
        expect(db2).not.toBe(db);

        // Late news from the dead channels changes nothing.
        db.status('SUBSCRIBED');
        live.status('SUBSCRIBED');
        expect(opts.onReconnect).not.toHaveBeenCalled();

        const pulls = vi.mocked(opts.onResync).mock.calls.length;
        db2.status('SUBSCRIBED');
        expect(opts.onResync).toHaveBeenCalledTimes(pulls + 1);
        latest(docTopic(DOC)).status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
    });

    it('opens nothing once stopped, even with a re-join under way', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { rt, live, db, channels } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        live.status('CLOSED');
        db.status('CLOSED');
        // The live re-join fires and starts removing the old channel...
        vi.advanceTimersByTime(REJOIN_BASE_MS);
        // ...when the viewer closes.
        rt.stop();
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS);
        expect(channels).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('DocRealtimeChannel message volume and server rate limits', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    const joinedWith = (members: number) => {
        const ctx = setup();
        ctx.live.status('SUBSCRIBED');
        ctx.db.status('SUBSCRIBED');
        syncPresence(ctx.live, members);
        return ctx;
    };

    it('coalesces live ink by room size: smooth one-to-one, a few batches per stroke at 25', () => {
        const small = joinedWith(2);
        drawFor(small.rt, 1000);
        // 80 ms batches plus pen-up.
        expect(inkSent(small.live)).toHaveLength(13);

        const big = joinedWith(25);
        const points = drawFor(big.rt, 1000);
        const sent = inkSent(big.live);
        // 250 ms batches plus pen-up — c08a922 sent 10 here, at any room size.
        expect(sent).toHaveLength(4);
        expect(sent.at(-1)?.done).toBe(true);
        expect(sent.reduce((n, m) => n + m.pts.length, 0)).toBe(points * 3);
    });

    it('widens the cadence on the server’s notice, counting one burst once', () => {
        const { rt, live, db } = joinedWith(25);
        live.system(tooMany);
        db.system(tooMany);
        drawFor(rt, 1000);
        // 500 ms batches plus pen-up (one level, not two).
        expect(inkSent(live)).toHaveLength(2);
    });

    it('streams a stroke whole at pen-up at the top level, then recovers as notices stop', () => {
        const { rt, live } = joinedWith(25);
        for (let i = 0; i < RATE_LIMIT_MAX_LEVEL; i++) {
            live.system(tooMany);
            vi.advanceTimersByTime(1500);
        }
        const points = drawFor(rt, 1000);
        expect(inkSent(live)).toHaveLength(1);
        expect(inkSent(live)[0]).toMatchObject({ done: true });
        expect(inkSent(live)[0]?.pts).toHaveLength(points * 3);

        // A cancelled stroke that never went out sends nothing to retract.
        live.send.mockClear();
        rt.publisher.start({ strokeId: 's2', page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
        rt.publisher.append([0.5, 0.5, 1]);
        rt.publisher.cancel();
        expect(live.send).not.toHaveBeenCalled();

        vi.advanceTimersByTime(RATE_LIMIT_DECAY_MS * RATE_LIMIT_MAX_LEVEL);
        live.send.mockClear();
        drawFor(rt, 1000);
        expect(inkSent(live)).toHaveLength(4);
    });

    it('ignores system messages that are not rate limits', () => {
        const { rt, live } = joinedWith(25);
        live.system({ extension: 'system', status: 'ok', message: 'Subscribed to PostgreSQL', channel: DOC });
        live.system({ ...tooMany, status: 'ok' });
        drawFor(rt, 1000);
        expect(inkSent(live)).toHaveLength(4);
    });

    it('backs off a join the rate limiter refused, without an access re-check', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const onMembershipChanged = vi.fn();
        const { live, latest } = setup({ onMembershipChanged });
        live.status('CHANNEL_ERROR', new Error('Too many joins per second'));
        expect(onMembershipChanged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(REJOIN_RATE_LIMITED_MIN_MS / 2 - 100);
        expect(latest(docTopic(DOC))).toBe(live);
        await vi.advanceTimersByTimeAsync(200);
        expect(latest(docTopic(DOC))).not.toBe(live);
    });

    it('takes a rate-limit send result as a signal too', async () => {
        const { rt, live } = joinedWith(25);
        live.send.mockResolvedValueOnce('rate limited');
        drawFor(rt, 300);
        await vi.advanceTimersByTimeAsync(0);
        live.send.mockClear();
        drawFor(rt, 1000);
        expect(inkSent(live)).toHaveLength(2);
    });

    it('spaces presence updates, and further under the rate limit', () => {
        const { rt, live } = joinedWith(2);
        expect(live.track).toHaveBeenCalledTimes(1);
        rt.setPage(1);
        vi.advanceTimersByTime(PRESENCE_TRACK_MIN_MS - 1);
        expect(live.track).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(live.track).toHaveBeenCalledTimes(2);

        live.system(tooMany);
        rt.setPage(2);
        vi.advanceTimersByTime(PRESENCE_TRACK_MIN_MS * 2 - 1);
        expect(live.track).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        expect(live.track).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    });
});

describe('parseMembershipChange', () => {
    it('accepts the trigger payload, including a removal', () => {
        expect(parseMembershipChange(membership(SELF, null))).toEqual({
            table: 'document_members',
            document_id: DOC,
            user_id: SELF,
            role: null,
        });
        expect(parseMembershipChange(membership(SELF, 'editor'))?.role).toBe('editor');
    });

    it('rejects anything that is not a membership change', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(parseMembershipChange({ ...membership(SELF, 'admin') })).toBeNull();
        expect(parseMembershipChange({ ...membership(SELF, null), table: 'annotations' })).toBeNull();
        warn.mockRestore();
    });
});

describe('DocRealtimeChannel presence names', () => {
    it('never passes on an email an older build announces as a name', () => {
        const onPeers = vi.fn();
        const { live } = setup({ onPeers });
        live.presenceState = () =>
            ({
                [PEER]: [{ userId: PEER, name: 'teacher@example.com', color: '#000000', page: 0, isAnonymous: false }],
                guest: [{ userId: 'guest', name: 'Sharon', color: '#000000', page: 0, isAnonymous: true }],
            }) as ReturnType<FakeChannel['presenceState']>;
        for (const h of live.handlers) {
            if (h.type === 'presence' && h.event === 'sync') {
                h.handler({ payload: undefined });
            }
        }
        const peers = onPeers.mock.calls.at(-1)?.[0] as Array<{ userId: string; name: string }>;
        expect(peers.map((p) => [p.userId, p.name])).toEqual([
            [PEER, 'Collaborator'],
            ['guest', 'Sharon'],
        ]);
    });
});

/** A generation, null a denial, undefined a failed read, 'archived' an archived score. */
type EpochAnswer = number | null | undefined | 'archived';

const toRead = (epoch: EpochAnswer): TopicEpochRead =>
    epoch === undefined
        ? { status: 'failed' }
        : epoch === null
          ? { status: 'denied' }
          : epoch === 'archived'
            ? { status: 'archived' }
            : { status: 'epoch', epoch };

/** One stroke, flushed at pen-up without advancing the clock. */
const scribble = (rt: DocRealtimeChannel, strokeId = 's1'): void => {
    rt.publisher.start({ strokeId, page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
    rt.publisher.append(new Array(3 * 50).fill(0.5));
    rt.publisher.end();
};

describe('DocRealtimeChannel takedown topics (20261020150100)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    /**
     * A channel that asks the generation first; `epochs` answers each ask in
     * turn, the last one from then on (see EpochAnswer).
     */
    const setupWithEpochs = async (epochs: EpochAnswer[], overrides: Partial<DocRealtimeChannelOptions> = {}) => {
        const answers = [...epochs];
        const fetchTopicEpoch = vi.fn(async () => toRead(answers.length > 1 ? answers.shift() : answers[0]));
        const channels: FakeChannel[] = [];
        const removed: FakeChannel[] = [];
        const supabase = {
            realtime: { isConnected: () => true },
            channel: (topic: string, options: unknown) => {
                const ch = new FakeChannel(topic, options);
                channels.push(ch);
                return ch;
            },
            removeChannel: async (ch: FakeChannel) => {
                removed.push(ch);
                return 'ok';
            },
        } as unknown as TypedSupabaseClient;
        const opts: DocRealtimeChannelOptions = {
            supabase,
            docId: DOC,
            self: { userId: SELF, name: 'Me', color: '#123456', page: 0, isAnonymous: false },
            onRemoteInk: vi.fn(),
            onDbChange: vi.fn(),
            onPeers: vi.fn(),
            onReconnect: vi.fn(),
            onResync: vi.fn(),
            onMembershipChanged: vi.fn(),
            fetchTopicEpoch,
            ...overrides,
        };
        const rt = new DocRealtimeChannel(opts);
        rt.start();
        await vi.advanceTimersByTimeAsync(0);
        const latest = (topic: string): FakeChannel | undefined => channels.filter((c) => c.topic === topic).at(-1);
        return { rt, opts, channels, removed, latest, fetchTopicEpoch };
    };

    it('names generation 0 with the plain topics, and a rotated score with a suffix', () => {
        expect(docTopic(DOC)).toBe(`doc:${DOC}`);
        expect(docTopic(DOC, 0)).toBe(`doc:${DOC}`);
        expect(docTopic(DOC, 3)).toBe(`doc:${DOC}:3`);
        expect(docDbTopic(DOC, 3)).toBe(`doc-db:${DOC}:3`);
    });

    it('asks the generation before joining, and joins that generation', async () => {
        const { channels, fetchTopicEpoch } = await setupWithEpochs([2]);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
        expect(channels.map((c) => c.topic)).toEqual([`doc:${DOC}:2`, `doc-db:${DOC}:2`]);
    });

    it('joins generation 0 when the server cannot say (offline, or before the migration)', async () => {
        const { channels } = await setupWithEpochs([undefined]);
        expect(channels.map((c) => c.topic)).toEqual([`doc:${DOC}`, `doc-db:${DOC}`]);
    });

    /** Past a rotation hint's jittered wait, whatever Math.random said. */
    const afterJitter = () => vi.advanceTimersByTimeAsync(ROTATION_JITTER_MAX_MS);

    it('a takedown moves the owner to the new topics, and leaves the old doc:{id} silent', async () => {
        const { rt, opts, removed, latest } = await setupWithEpochs([0, 1]);
        const live = latest(docTopic(DOC))!;
        const db = latest(docDbTopic(DOC))!;
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        // A collaborator is on doc:{id} with the owner.
        syncPresence(live, 2);
        drawFor(rt, 200);
        expect(inkSent(live).length).toBeGreaterThan(0);
        live.send.mockClear();

        // The takedown: the server says the topics moved, on doc-db:{id}.
        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        // Both old topics are left at once, before the new generation is even
        // read: the collaborator may still be on doc:{id}, whatever its app does.
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        drawFor(rt, 200);
        expect(live.send).not.toHaveBeenCalled();

        await afterJitter();
        const live1 = latest(docTopic(DOC, 1))!;
        const db1 = latest(docDbTopic(DOC, 1))!;
        expect(live1).toBeDefined();
        expect(db1).toBeDefined();
        live1.status('SUBSCRIBED');
        db1.status('SUBSCRIBED');
        // A move is a re-join: pull whatever was committed between the topics.
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);

        // The owner's other device is on generation 1 too; the shut-out
        // collaborator cannot join it, so it is the only audience.
        syncPresence(live1, 2);
        drawFor(rt, 500);
        expect(inkSent(live1).length).toBeGreaterThan(0);
        // Not one batch more on the old topic, where the collaborator sits.
        expect(live.send).not.toHaveBeenCalled();
        // Committed rows now arrive on doc-db:{id}:1.
        db1.broadcast('INSERT', dbChange(row({ seq: 99 })));
        expect(opts.onDbChange).toHaveBeenCalledWith(expect.objectContaining({ seq: 99 }));
    });

    it('a member the takedown shut out is told to re-check, and never joins the new topics', async () => {
        const { opts, latest, channels } = await setupWithEpochs([0, null]);
        const db = latest(docDbTopic(DOC))!;
        db.status('SUBSCRIBED');
        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await afterJitter();
        expect(opts.onMembershipChanged).toHaveBeenCalled();
        expect(channels.some((c) => c.topic.endsWith(':1'))).toBe(false);
    });

    it('re-reads the generation when a join is refused (a stale device), and moves', async () => {
        const { latest, fetchTopicEpoch } = await setupWithEpochs([0, 4]);
        const live = latest(docTopic(DOC))!;
        live.status('CHANNEL_ERROR', new Error('Unauthorized'));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        expect(latest(docTopic(DOC, 4))).toBeDefined();
        expect(latest(docDbTopic(DOC, 4))).toBeDefined();
    });

    it('ignores a hint for another score, and a doc:{id} hint that changes no generation moves nothing', async () => {
        const { latest, channels, removed, fetchTopicEpoch } = await setupWithEpochs([0]);
        const live = latest(docTopic(DOC))!;
        const db = latest(docDbTopic(DOC))!;
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        db.broadcast(TOPIC_ROTATED_EVENT, { document_id: 'another-score' });
        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
        expect(removed).toEqual([]);
        live.broadcast(TOPIC_ROTATED_EVENT, { document_id: DOC });
        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        expect(removed).toEqual([]);
        expect(channels).toHaveLength(2);
    });

    it('reads the generation over PostgREST: only a null answer is a denial, anything unclear a failure', async () => {
        const rpc = vi.fn();
        const supabase = { rpc } as unknown as TypedSupabaseClient;
        rpc.mockResolvedValueOnce({ data: { status: 'open', epoch: 2 }, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'epoch', epoch: 2 });
        expect(rpc).toHaveBeenCalledWith('realtime_topic_access', { p_document: DOC });
        rpc.mockResolvedValueOnce({ data: { status: 'open', epoch: 0 }, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'epoch', epoch: 0 });
        // The function ran under this user's token and document_role() said no.
        rpc.mockResolvedValueOnce({ data: null, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'denied' });
        // A member of an archived score (20261022120200): wait, do not stop.
        rpc.mockResolvedValueOnce({ data: { status: 'archived' }, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'archived' });
        // Shapes it does not know, the old function's bare integer among them.
        for (const data of [2, [], 'archived', { status: 'open' }, { status: 'open', epoch: -1 }, { status: 'gone' }]) {
            rpc.mockResolvedValueOnce({ data, error: null });
            await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        }
        // None of these says anything about access.
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function' } });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'JWT expired', code: 'PGRST301' } });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        rpc.mockRejectedValueOnce(new Error('offline'));
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        rpc.mockResolvedValueOnce({ data: { status: 'open', epoch: 1.5 }, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
        rpc.mockResolvedValueOnce({ data: undefined, error: null });
        await expect(fetchRealtimeTopicEpoch(supabase, DOC)).resolves.toEqual({ status: 'failed' });
    });

    /** Owner and a collaborator on generation 0, the owner's ink reaching it. */
    const ownerWithCollaborator = async (epochs: EpochAnswer[]) => {
        const ctx = await setupWithEpochs(epochs);
        const live = ctx.latest(docTopic(DOC))!;
        const db = ctx.latest(docDbTopic(DOC))!;
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        syncPresence(live, 2);
        scribble(ctx.rt, 'before');
        expect(inkSent(live).length).toBeGreaterThan(0);
        live.send.mockClear();
        return { ...ctx, live, db };
    };

    it('a failed read after the hint keeps the hold and the old topics left, pulling meanwhile, and rejoins only on success', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1); // the longest delay of each step
        const { rt, opts, channels, removed, latest, fetchTopicEpoch, live, db } = await ownerWithCollaborator([
            0,
            undefined,
            undefined,
            1,
        ]);

        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        // Left at once; nothing new is opened until a read succeeds.
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        expect(channels).toHaveLength(2);
        // Late presence from the old topic; the owner draws, and cancels one.
        syncPresence(live, 2);
        scribble(rt, 'held-1');
        rt.publisher.start({ strokeId: 'held-2', page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
        rt.publisher.append(new Array(3 * 200).fill(0.5));
        rt.publisher.cancel();
        expect(live.send).not.toHaveBeenCalled();

        // The first retry fails too: still held, still off every topic.
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
        scribble(rt, 'held-3');
        expect(live.send).not.toHaveBeenCalled();
        expect(channels).toHaveLength(2);

        // The second retry succeeds: the owner joins generation 1, and only now lets ink go.
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS * 2);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
        const live1 = latest(docTopic(DOC, 1))!;
        const db1 = latest(docDbTopic(DOC, 1))!;
        live1.status('SUBSCRIBED');
        db1.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        syncPresence(live1, 2);
        scribble(rt, 'after');
        expect(inkSent(live1).map((m) => m.strokeId)).toContain('after');
        expect(live.send).not.toHaveBeenCalled();
        expect(opts.onMembershipChanged).not.toHaveBeenCalled();
        // Nothing left to retry or poll.
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_MAX_MS * 2);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
        expect(opts.onResync).not.toHaveBeenCalled();
    });

    it('while a slow read keeps the device off every topic, committed rows are pulled', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { opts, db } = await ownerWithCollaborator([0, undefined]);
        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await vi.advanceTimersByTimeAsync(DB_JOIN_GRACE_MS - 1);
        expect(opts.onResync).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(opts.onResync).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(DB_FALLBACK_POLL_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(2);
    });

    it('a denial closes doc:{id} and doc-db:{id} at once, for good, and a connected collaborator gets no ink', async () => {
        const { rt, opts, removed, channels, fetchTopicEpoch, live, db } = await ownerWithCollaborator([0, null]);

        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await afterJitter();
        // Both old channels are left, not merely muted.
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        expect(removed).toHaveLength(2);
        // The app's re-check shows the restricted state (CloudViewer's access loss).
        expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);

        // Late news on the dead channel: the collaborator's presence, a re-join.
        syncPresence(live, 2);
        live.status('SUBSCRIBED');
        scribble(rt, 'after');
        rt.setPage(3);
        expect(live.send).not.toHaveBeenCalled();
        expect(live.track).toHaveBeenCalledTimes(1);

        // Nothing re-opens, retries or polls.
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS * 4);
        expect(channels).toHaveLength(2);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        expect(opts.onResync).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a denial on start opens nothing', async () => {
        const { opts, channels } = await setupWithEpochs([null]);
        expect(channels).toEqual([]);
        expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS * 4);
        expect(channels).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a collaborator’s presence update during a failing read does not let the owner’s ink out', async () => {
        const { rt, live, db } = await ownerWithCollaborator([0, undefined]);

        // Rotation, then the read fails...
        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await afterJitter();
        // ...then the collaborator, still on the old doc:{id}, updates its
        // presence, which is what restored the audience at b8adc513...
        syncPresence(live, 2);
        syncPresence(live, 3);
        // ...and the owner draws and turns the page.
        const tracks = live.track.mock.calls.length;
        scribble(rt, 'during');
        rt.setPage(5);
        await vi.advanceTimersByTimeAsync(PRESENCE_TRACK_MIN_MS * 4);
        expect(live.send).not.toHaveBeenCalled();
        expect(live.track).toHaveBeenCalledTimes(tracks);
        rt.stop();
    });

    it('a doc:{id} hint that turns out not to move the score lets go on the same topics, and announces again', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { rt, live, removed, fetchTopicEpoch } = await ownerWithCollaborator([0, undefined, 0]);
        // Any member may send the hint on doc:{id}: with doc-db:{id} joined,
        // it holds and re-reads rather than leave.
        live.broadcast(TOPIC_ROTATED_EVENT, { id: 'forged', document_id: DOC });
        expect(removed).toEqual([]);
        await afterJitter();
        syncPresence(live, 2);
        rt.setPage(2);
        scribble(rt, 'held');
        expect(live.send).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
        expect(removed).toEqual([]);
        await vi.advanceTimersByTimeAsync(PRESENCE_TRACK_MIN_MS);
        expect(live.track).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
        scribble(rt, 'after');
        expect(inkSent(live).map((m) => m.strokeId)).toEqual(['after']);
    });

    it('a doc:{id} hint leaves at once when doc-db:{id} is not joined, its only word on this device', async () => {
        const { removed, latest, live, db } = await ownerWithCollaborator([0, 1]);
        db.status('CHANNEL_ERROR');
        live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        await afterJitter();
        expect(latest(docTopic(DOC, 1))).toBeDefined();
        expect(latest(docDbTopic(DOC, 1))).toBeDefined();
    });

    it('jitters each retry between half and all of a ceiling that doubles from 0.5 s to 30 s', () => {
        expect(epochRetryDelayMs(0, () => 0)).toBe(EPOCH_RETRY_BASE_MS / 2);
        expect(epochRetryDelayMs(0, () => 1)).toBe(EPOCH_RETRY_BASE_MS);
        expect(epochRetryDelayMs(1, () => 1)).toBe(1000);
        expect(epochRetryDelayMs(2, () => 0.5)).toBe(1500);
        expect(epochRetryDelayMs(6, () => 1)).toBe(EPOCH_RETRY_MAX_MS);
        expect(epochRetryDelayMs(1000, () => 1)).toBe(EPOCH_RETRY_MAX_MS);
        expect(epochRetryDelayMs(1000, () => 0)).toBe(EPOCH_RETRY_MAX_MS / 2);
    });

    it('backs off failed reads to a bound, and stops retrying on teardown', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const { rt, db, fetchTopicEpoch } = await ownerWithCollaborator([0, undefined]);
        db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);

        const waits: number[] = [];
        for (let i = 0; i < 9; i++) {
            const calls = fetchTopicEpoch.mock.calls.length;
            let waited = 0;
            while (fetchTopicEpoch.mock.calls.length === calls) {
                await vi.advanceTimersByTimeAsync(100);
                waited += 100;
                expect(waited).toBeLessThanOrEqual(EPOCH_RETRY_MAX_MS);
            }
            waits.push(waited);
        }
        expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

        rt.stop();
        const calls = fetchTopicEpoch.mock.calls.length;
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_MAX_MS * 4);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(calls);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a newer hint replaces the waiting retry, and an answer from before it decides nothing', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const pending: Array<(read: TopicEpochRead) => void> = [];
        const reads: TopicEpochRead[] = [{ status: 'epoch', epoch: 0 }, { status: 'failed' }, { status: 'failed' }];
        const fetchTopicEpoch = vi.fn(
            () =>
                new Promise<TopicEpochRead>((resolve) => {
                    const next = reads.shift();
                    if (next) {
                        resolve(next);
                    } else {
                        pending.push(resolve);
                    }
                }),
        );
        const { rt, live, db, removed, latest } = await (async () => {
            const ctx = await setupWithEpochs([0], { fetchTopicEpoch });
            const l = ctx.latest(docTopic(DOC))!;
            const d = ctx.latest(docDbTopic(DOC))!;
            l.status('SUBSCRIBED');
            d.status('SUBSCRIBED');
            syncPresence(l, 2);
            return { ...ctx, live: l, db: d };
        })();

        // Hints on doc:{id} (doc-db:{id} joined, so the channels stay): a
        // hint, a failed read, a retry waiting 500 ms...
        live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS - 100);
        // ...when a newer hint lands: the retry that was waiting is gone, and
        // the next read waits out the newer hint's jitter.
        live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm2', document_id: DOC });
        await vi.advanceTimersByTimeAsync(100);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(ROTATION_JITTER_MAX_MS - 100);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
        // That read failed too; its retry (the backoff's next step) is in
        // flight when a third hint lands.
        await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS * 2);
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
        live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm3', document_id: DOC });
        pending.shift()?.({ status: 'epoch', epoch: 0 });
        await vi.advanceTimersByTimeAsync(0);
        // The answer in flight may predate the third hint: it let nothing go.
        syncPresence(live, 2);
        scribble(rt, 'stale');
        expect(live.send).not.toHaveBeenCalled();
        expect(removed).toEqual([]);

        await afterJitter();
        expect(fetchTopicEpoch).toHaveBeenCalledTimes(5);
        pending.shift()?.({ status: 'epoch', epoch: 2 });
        await vi.advanceTimersByTimeAsync(0);
        expect(removed).toEqual(expect.arrayContaining([live, db]));
        expect(latest(docTopic(DOC, 2))).toBeDefined();
        expect(live.send).not.toHaveBeenCalled();
        rt.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    /**
     * 20261022120100_realtime_revocation_races: a rotation tells every member
     * of a score at once, and one commit can rotate hundreds of scores, so
     * each device waits a random 0..2 s before it re-reads and rejoins, and a
     * burst of hints is one read and one rejoin.
     */
    describe('rotation follow-ups are jittered and coalesced (20261022120100)', () => {
        it('spreads the wait uniformly over 0..2 s', () => {
            expect(ROTATION_JITTER_MAX_MS).toBe(2000);
            expect(rotationJitterMs(() => 0)).toBe(0);
            expect(rotationJitterMs(() => 0.25)).toBe(500);
            expect(rotationJitterMs(() => 0.999_9)).toBe(2000);
            expect(rotationJitterMs(() => 1)).toBe(2000);
        });

        it('waits out the jitter before the read, and makes one read and one rejoin of a burst of hints', async () => {
            const { opts, channels, fetchTopicEpoch, live, db, latest } = await ownerWithCollaborator([0, 1]);
            vi.spyOn(Math, 'random').mockReturnValue(0.5);
            // Both topics' hints, then the doc-db:{id} hint delivered twice.
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm2', document_id: DOC });
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            expect(Math.random).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(ROTATION_JITTER_MAX_MS / 2 - 1);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(channels.map((c) => c.topic)).toEqual([
                docTopic(DOC),
                docDbTopic(DOC),
                docTopic(DOC, 1),
                docDbTopic(DOC, 1),
            ]);
            latest(docTopic(DOC, 1))!.status('SUBSCRIBED');
            latest(docDbTopic(DOC, 1))!.status('SUBSCRIBED');
            // One gap-fill pull, no fallback pull beside it.
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(DB_FALLBACK_POLL_MS * 2);
            expect(opts.onResync).not.toHaveBeenCalled();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        });

        it('spreads the devices of one score over the window', async () => {
            const draws = [0, 0.3, 0.7, 1];
            const devices: Array<Awaited<ReturnType<typeof ownerWithCollaborator>>> = [];
            for (let i = 0; i < draws.length; i++) {
                devices.push(await ownerWithCollaborator([0, 1]));
            }
            const random = vi.spyOn(Math, 'random');
            draws.forEach((draw, i) => {
                random.mockReturnValueOnce(draw);
                devices[i]!.db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            });
            const readAt = devices.map(() => -1);
            for (let t = 0; t <= ROTATION_JITTER_MAX_MS; t += 100) {
                await vi.advanceTimersByTimeAsync(t === 0 ? 0 : 100);
                devices.forEach((device, i) => {
                    if (readAt[i] === -1 && device.fetchTopicEpoch.mock.calls.length === 2) {
                        readAt[i] = t;
                    }
                });
            }
            expect(readAt).toEqual([0, 600, 1400, 2000]);
        });

        it('the hint of a channel already left decides nothing', async () => {
            const { fetchTopicEpoch, channels, live, db } = await ownerWithCollaborator([0, 1, 2]);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            await afterJitter();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            // Late copies on the generation-0 channels, left since.
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm2', document_id: DOC });
            await afterJitter();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(channels).toHaveLength(4);
        });

        it('teardown cancels a waiting follow-up', async () => {
            const { rt, fetchTopicEpoch, db } = await ownerWithCollaborator([0, 1]);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            rt.stop();
            await afterJitter();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    /**
     * 20261022120200_realtime_archive_recovery (decision 55): archiving is a
     * temporary denial. A member's open score leaves both topics when it is
     * archived, asks again every 15-45 s, and joins the current generation by
     * itself once the score is restored -- no reopen.
     */
    describe('an archived score waits, and rejoins on restore (20261022120200)', () => {
        // Every wait at its longest: one recheck per afterArchivedRecheck().
        beforeEach(() => {
            vi.spyOn(Math, 'random').mockReturnValue(1);
        });

        /** Past one archived recheck (the longest, with Math.random at 1). */
        const afterArchivedRecheck = () => vi.advanceTimersByTimeAsync((ARCHIVED_RECHECK_MS * 3) / 2);

        it('spreads the rechecks uniformly over 15..45 s', () => {
            expect(ARCHIVED_RECHECK_MS).toBe(30_000);
            expect(archivedRecheckDelayMs(() => 0)).toBe(15_000);
            expect(archivedRecheckDelayMs(() => 0.5)).toBe(30_000);
            expect(archivedRecheckDelayMs(() => 1)).toBe(45_000);
        });

        it('an open viewer sees the score archived, then restored, and realtime resumes without a reopen', async () => {
            const { rt, opts, channels, removed, latest, fetchTopicEpoch, live, db } = await ownerWithCollaborator([
                0,
                'archived',
                'archived',
                1,
            ]);

            // The archive rotates the score: the hint on doc-db:{id}.
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            expect(removed).toEqual(expect.arrayContaining([live, db]));
            await afterJitter();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            // Archived: nothing is opened, the viewer is asked to re-check
            // (it shows the score archived), and nothing goes out.
            expect(channels).toHaveLength(2);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);
            syncPresence(live, 2);
            scribble(rt, 'archived');
            rt.setPage(2);
            expect(live.send).not.toHaveBeenCalled();
            // No row can be written on an archived score: no fallback polling.
            await vi.advanceTimersByTimeAsync(DB_JOIN_GRACE_MS + DB_FALLBACK_POLL_MS);
            expect(opts.onResync).not.toHaveBeenCalled();

            // Still archived at the next recheck: still off, nothing new to say.
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(channels).toHaveLength(2);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);

            // Restored: the next recheck joins the current generation, the same
            // mounted channel, no reopen.
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
            const live1 = latest(docTopic(DOC, 1))!;
            const db1 = latest(docDbTopic(DOC, 1))!;
            expect(channels.map((c) => c.topic)).toEqual([
                docTopic(DOC),
                docDbTopic(DOC),
                docTopic(DOC, 1),
                docDbTopic(DOC, 1),
            ]);
            // The viewer re-reads, and leaves its archived state.
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(2);
            live1.status('SUBSCRIBED');
            db1.status('SUBSCRIBED');
            // A re-join: one gap-fill pull for what was committed before it landed.
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            // Committed marks, live ink and presence all flow again.
            db1.broadcast('INSERT', dbChange(row({ seq: 42 })));
            expect(opts.onDbChange).toHaveBeenCalledWith(expect.objectContaining({ seq: 42 }));
            live1.broadcast(INK_PROGRESS_EVENT, peerStroke());
            expect(opts.onRemoteInk).toHaveBeenCalled();
            expect(live1.track).toHaveBeenCalled();
            syncPresence(live1, 2);
            scribble(rt, 'restored');
            expect(inkSent(live1).map((m) => m.strokeId)).toContain('restored');
            expect(live.send).not.toHaveBeenCalled();
            // Nothing left to ask.
            await vi.advanceTimersByTimeAsync(ARCHIVED_RECHECK_MS * 4);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
            rt.stop();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('tab focus asks at once while archived, so a restore resumes without waiting out the recheck', async () => {
            const { channels, latest, fetchTopicEpoch } = await setupWithEpochs(['archived', 1]);
            expect(channels).toEqual([]);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);

            window.dispatchEvent(new Event('focus'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(latest(docTopic(DOC, 1))).toBeDefined();
            expect(latest(docDbTopic(DOC, 1))).toBeDefined();

            // Restored: nothing listens any more, and no recheck is left.
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            await vi.advanceTimersByTimeAsync(ARCHIVED_RECHECK_MS * 4);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        });

        it('coming back online or into view asks too, at most once per ARCHIVED_WAKE_MIN_MS, never while hidden', async () => {
            const { rt, fetchTopicEpoch } = await setupWithEpochs(['archived', 'archived', 'archived', 'archived']);
            window.dispatchEvent(new Event('online'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);

            // A burst: focus and visibility right after are the same request.
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(ARCHIVED_WAKE_MIN_MS);
            const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            visibility.mockReturnValue('visible');
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            visibility.mockRestore();

            // Stopped: nothing asks again, whatever the window does.
            rt.stop();
            await vi.advanceTimersByTimeAsync(ARCHIVED_WAKE_MIN_MS);
            window.dispatchEvent(new Event('focus'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('focus does nothing while the score is not archived', async () => {
            const { fetchTopicEpoch } = await setupWithEpochs([0]);
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new Event('online'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
        });

        it('a score opened while archived joins nothing, then joins on restore and pulls the gap', async () => {
            const { opts, channels, latest, fetchTopicEpoch } = await setupWithEpochs(['archived', 0]);
            expect(channels).toEqual([]);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            latest(docTopic(DOC))!.status('SUBSCRIBED');
            latest(docDbTopic(DOC))!.status('SUBSCRIBED');
            // Rows written after the open's own pull, before these joins.
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(2);
        });

        it('a failed read while archived asks again at the archived pace, not the retry pace', async () => {
            const { channels, latest, fetchTopicEpoch, db } = await ownerWithCollaborator([
                0,
                'archived',
                undefined,
                2,
            ]);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            await afterJitter();
            await afterArchivedRecheck();
            // The failed read opens nothing: generation 0 would only be refused.
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(channels).toHaveLength(2);
            await vi.advanceTimersByTimeAsync(EPOCH_RETRY_BASE_MS * 4);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(4);
            expect(latest(docTopic(DOC, 2))).toBeDefined();
            expect(latest(docDbTopic(DOC, 2))).toBeDefined();
        });

        it('a denial while archived still stops for good', async () => {
            const { opts, channels, fetchTopicEpoch, db } = await ownerWithCollaborator([0, 'archived', null]);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            await afterJitter();
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(ARCHIVED_RECHECK_MS * 4);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(channels).toHaveLength(2);
            expect(vi.getTimerCount()).toBe(0);
        });

        it('a device that missed the archive (its re-join refused) waits too, and re-joins nothing meanwhile', async () => {
            const { opts, channels, removed, fetchTopicEpoch, live, db } = await ownerWithCollaborator([0, 'archived']);
            // Its socket was down for the hint; realtime-js's re-join is refused.
            live.status('CHANNEL_ERROR', new Error('Unauthorized'));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(removed).toEqual(expect.arrayContaining([live, db]));
            // The re-join the drop armed never fires, and nothing is polled.
            await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS);
            expect(channels).toHaveLength(2);
            expect(opts.onResync).not.toHaveBeenCalled();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
        });

        it('teardown while archived cancels the recheck', async () => {
            const { rt, fetchTopicEpoch } = await setupWithEpochs(['archived']);
            rt.stop();
            await afterArchivedRecheck();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    /**
     * 20261022120000_realtime_revocation_rotation: a member who loses the score
     * (removed, unassigned, a student whose access ended) or loses write on it
     * (editor -> viewer) moves it to the next generation, so every member on it
     * gets the membership hint (for whoever changed) and `topic_rotated` on
     * both old topics, in the same commit.
     */
    describe('when a membership change rotates the score (20261022120000)', () => {
        /** Each read answers after READ_MS, from `epochs` in turn (the last one from then on). */
        const READ_MS = 50;
        const slowReads = (epochs: Array<number | null>) => {
            const answers = [...epochs];
            let inFlight = 0;
            let maxInFlight = 0;
            const fetchTopicEpoch = vi.fn(
                () =>
                    new Promise<TopicEpochRead>((done) => {
                        inFlight += 1;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        const answer = answers.length > 1 ? answers.shift() : answers[0];
                        setTimeout(() => {
                            inFlight -= 1;
                            done(toRead(answer));
                        }, READ_MS);
                    }),
            );
            return { fetchTopicEpoch, maxInFlight: () => maxInFlight };
        };

        const membership = (userId: string, role: string | null) => ({
            table: 'document_members',
            document_id: DOC,
            user_id: userId,
            role,
        });

        /** On generation 0 with a collaborator, both topics joined. */
        const joinedAtZero = async (epochs: Array<number | null>) => {
            const reads = slowReads(epochs);
            const ctx = await setupWithEpochs([0], { fetchTopicEpoch: reads.fetchTopicEpoch });
            await vi.advanceTimersByTimeAsync(READ_MS);
            const live = ctx.latest(docTopic(DOC))!;
            const db = ctx.latest(docDbTopic(DOC))!;
            live.status('SUBSCRIBED');
            db.status('SUBSCRIBED');
            syncPresence(live, 2);
            return { ...ctx, ...reads, live, db };
        };

        /** Past the jitter and one read. */
        const afterJitterAndRead = () => vi.advanceTimersByTimeAsync(ROTATION_JITTER_MAX_MS + READ_MS);

        it('a member who keeps access follows it: off the old topics at once, one read, one move, one gap-fill pull', async () => {
            const { rt, opts, channels, removed, latest, fetchTopicEpoch, maxInFlight, live, db } = await joinedAtZero([
                0, 1,
            ]);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(1);

            // Someone else was removed: their hint is not this member's business.
            live.broadcast(MEMBERSHIP_EVENT, membership(PEER, null));
            expect(opts.onMembershipChanged).not.toHaveBeenCalled();

            // The rotation, told on both old topics in the same commit.
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm2', document_id: DOC });
            // Off both old topics at once, ink held, whoever may still be on doc:{id}.
            expect(removed).toEqual(expect.arrayContaining([live, db]));
            scribble(rt, 'held');
            expect(live.send).not.toHaveBeenCalled();

            // Both hints are one follow-up: one read, then the channels open.
            await afterJitterAndRead();
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(maxInFlight()).toBe(1);
            // Exactly one new pair of channels: the move is the whole rejoin.
            expect(channels.map((c) => c.topic)).toEqual([
                docTopic(DOC),
                docDbTopic(DOC),
                docTopic(DOC, 1),
                docDbTopic(DOC, 1),
            ]);

            // The gap-fill pull waits for both new topics, so a mark committed
            // while neither was joined is pulled (with the pull's overlap)
            // rather than missed between the pull and the join.
            const live1 = latest(docTopic(DOC, 1))!;
            const db1 = latest(docDbTopic(DOC, 1))!;
            live1.status('SUBSCRIBED');
            expect(opts.onReconnect).not.toHaveBeenCalled();
            db1.status('SUBSCRIBED');
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            expect(opts.onResync).not.toHaveBeenCalled();
            db1.broadcast('INSERT', dbChange(row({ seq: 42 })));
            expect(opts.onDbChange).toHaveBeenCalledWith(expect.objectContaining({ seq: 42 }));

            // Live ink goes on generation 1 only.
            syncPresence(live1, 2);
            scribble(rt, 'after');
            expect(inkSent(live1).map((m) => m.strokeId)).toEqual(['after']);
            expect(live.send).not.toHaveBeenCalled();

            // Settled: no further read, rejoin or pull is waiting.
            await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS * 2);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(channels).toHaveLength(4);
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            expect(opts.onMembershipChanged).not.toHaveBeenCalled();
            rt.stop();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('a removed member stops cleanly: re-checks on its hint, is denied the generation, and leaves both topics for good', async () => {
            const { rt, opts, channels, removed, fetchTopicEpoch, live, db } = await joinedAtZero([0, null]);

            // The hint for this user, then the rotation in the same commit.
            live.broadcast(MEMBERSHIP_EVENT, membership(SELF, null));
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            live.broadcast(TOPIC_ROTATED_EVENT, { id: 'm2', document_id: DOC });
            await afterJitterAndRead();

            expect(removed).toEqual(expect.arrayContaining([live, db]));
            expect(removed).toHaveLength(2);
            expect(channels).toHaveLength(2);
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(2);

            // Whatever still arrives on the dead channels, nothing goes out.
            syncPresence(live, 2);
            scribble(rt, 'after');
            expect(live.send).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(REJOIN_MAX_MS * 4);
            expect(channels).toHaveLength(2);
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(2);
            expect(opts.onResync).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });

        it('an editor made viewer re-checks its role on its hint and follows the rotation (the new join is a viewer’s)', async () => {
            const { opts, removed, latest, live, db } = await joinedAtZero([0, 1]);

            live.broadcast(MEMBERSHIP_EVENT, membership(SELF, 'viewer'));
            expect(opts.onMembershipChanged).toHaveBeenCalledTimes(1);
            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });

            // Off the old doc:{id} at once, where its channel kept the
            // editor's send permission Realtime cached at join, and onto
            // generation 1, which Realtime authorizes afresh: receive and
            // presence only.
            expect(removed).toEqual(expect.arrayContaining([live, db]));
            await afterJitterAndRead();
            const live1 = latest(docTopic(DOC, 1))!;
            const db1 = latest(docDbTopic(DOC, 1))!;
            live1.status('SUBSCRIBED');
            db1.status('SUBSCRIBED');
            expect(opts.onReconnect).toHaveBeenCalledTimes(1);
            // It announces itself there, inside the presence rate limit's gap.
            await vi.advanceTimersByTimeAsync(PRESENCE_TRACK_MIN_MS);
            expect(live1.track).toHaveBeenCalledTimes(1);
        });

        it('rotations back to back (an archive, then the session end) are followed to the newest generation, one read at a time', async () => {
            const { opts, channels, latest, fetchTopicEpoch, maxInFlight, db } = await joinedAtZero([0, 1, 2]);

            db.broadcast(TOPIC_ROTATED_EVENT, { id: 'm1', document_id: DOC });
            await afterJitterAndRead();
            const live1 = latest(docTopic(DOC, 1))!;
            const db1 = latest(docDbTopic(DOC, 1))!;
            live1.status('SUBSCRIBED');
            db1.status('SUBSCRIBED');

            // The second rotation is told on generation 1.
            db1.broadcast(TOPIC_ROTATED_EVENT, { id: 'm3', document_id: DOC });
            live1.broadcast(TOPIC_ROTATED_EVENT, { id: 'm4', document_id: DOC });
            await afterJitterAndRead();
            const live2 = latest(docTopic(DOC, 2))!;
            const db2 = latest(docDbTopic(DOC, 2))!;
            live2.status('SUBSCRIBED');
            db2.status('SUBSCRIBED');

            expect(maxInFlight()).toBe(1);
            // 1 on start, then 1 per rotation (both hints of each are one follow-up).
            expect(fetchTopicEpoch).toHaveBeenCalledTimes(3);
            expect(channels.map((c) => c.topic)).toEqual([
                docTopic(DOC),
                docDbTopic(DOC),
                docTopic(DOC, 1),
                docDbTopic(DOC, 1),
                docTopic(DOC, 2),
                docDbTopic(DOC, 2),
            ]);
            // One gap-fill pull per move.
            expect(opts.onReconnect).toHaveBeenCalledTimes(2);
        });
    });
});
