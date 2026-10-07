import { describe, expect, it, vi } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import { DocRealtimeChannel, docDbTopic, docTopic, type DocRealtimeChannelOptions } from '@/sync/realtimeChannel';
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
