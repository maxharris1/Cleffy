import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    DB_FALLBACK_INK_PULL_MS,
    DB_FALLBACK_POLL_MS,
    DB_JOIN_GRACE_MS,
    DocRealtimeChannel,
    docDbTopic,
    docTopic,
    type DocRealtimeChannelOptions,
} from '@/sync/realtimeChannel';
import { INK_PROGRESS_EVENT, SCORE_ANALYSIS_EVENT } from '@/sync/wire';
import type { AnnotationRow } from '@/types/database';

const DOC = 'c0ffee00-0000-4000-8000-000000000001';
const SELF = 'user-self';
const PEER = 'user-peer';

type Handler = (msg: { payload: unknown }) => void;

/** Just enough of a realtime-js channel to drive DocRealtimeChannel. */
class FakeChannel {
    readonly handlers: Array<{ type: string; event: string; handler: Handler }> = [];
    statusCallback: ((status: string) => void) | null = null;
    state = 'joined';

    constructor(
        readonly topic: string,
        readonly options: unknown,
    ) {}

    on(type: string, filter: { event: string }, handler: Handler) {
        this.handlers.push({ type, event: filter.event, handler });
        return this;
    }

    subscribe(callback: (status: string) => void) {
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

    status(status: string): void {
        this.statusCallback?.(status);
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
    const supabase = {
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
    return { rt, opts, live, db, channels, removed };
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
        expect(live.events('broadcast')).toEqual([INK_PROGRESS_EVENT]);
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

    it('gap-fills when only the committed-row channel re-joins', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('SUBSCRIBED');
        db.status('TIMED_OUT');
        db.status('SUBSCRIBED');
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
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

    it('still gap-fills when the live channel reconnects and doc-db:{id} never joins', () => {
        const { opts, live, db } = setup();
        live.status('SUBSCRIBED');
        db.status('CHANNEL_ERROR');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        live.status('CHANNEL_ERROR');
        live.status('SUBSCRIBED');
        expect(opts.onReconnect).not.toHaveBeenCalled();
        db.status('CHANNEL_ERROR');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
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

    it('stops polling while the socket is down and resumes after the live re-join', () => {
        const { opts, live } = setup();
        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        live.status('CHANNEL_ERROR');
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS * 3);
        expect(opts.onResync).toHaveBeenCalledTimes(1);

        live.status('SUBSCRIBED');
        vi.advanceTimersByTime(DB_JOIN_GRACE_MS);
        expect(opts.onReconnect).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(DB_FALLBACK_POLL_MS);
        expect(opts.onResync).toHaveBeenCalledTimes(2);
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
