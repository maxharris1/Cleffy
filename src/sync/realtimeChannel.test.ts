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
    docDbTopic,
    docTopic,
    rejoinDelayMs,
    type DocRealtimeChannelOptions,
} from '@/sync/realtimeChannel';
import {
    INK_PROGRESS_EVENT,
    MEMBERSHIP_EVENT,
    SCORE_ANALYSIS_EVENT,
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
        expect(live.events('broadcast')).toEqual([INK_PROGRESS_EVENT, MEMBERSHIP_EVENT]);
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
