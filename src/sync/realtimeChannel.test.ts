import { describe, expect, it, vi } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import { DocRealtimeChannel } from '@/sync/realtimeChannel';
import { parseMembershipChange } from '@/sync/wire';

const DOC = 'doc-1';
const SELF = 'user-self';

type Handler = (msg: { payload: unknown }) => void;

/** Just enough of a realtime channel to deliver broadcasts and join statuses. */
const fakeSupabase = () => {
    const handlers = new Map<string, Handler>();
    let onStatus: (status: string) => void = () => undefined;
    const channel = {
        state: 'joined',
        on: (type: string, filter: { event: string }, handler: Handler) => {
            handlers.set(`${type}:${filter.event}`, handler);
            return channel;
        },
        subscribe: (cb: (status: string) => void) => {
            onStatus = cb;
            return channel;
        },
        track: vi.fn(() => Promise.resolve('ok')),
        send: vi.fn(() => Promise.resolve('ok')),
        presenceState: () => ({}),
    };
    const supabase = {
        channel: vi.fn(() => channel),
        removeChannel: vi.fn(() => Promise.resolve('ok')),
    } as unknown as TypedSupabaseClient;
    return {
        supabase,
        broadcast: (event: string, payload: unknown) => handlers.get(`broadcast:${event}`)?.({ payload }),
        status: (status: string) => onStatus(status),
    };
};

const start = () => {
    const fake = fakeSupabase();
    const onMembershipChanged = vi.fn();
    const channel = new DocRealtimeChannel({
        supabase: fake.supabase,
        docId: DOC,
        self: { userId: SELF, name: 'Me', color: '#000', page: 0, isAnonymous: false },
        onRemoteInk: vi.fn(),
        onDbChange: vi.fn(),
        onPeers: vi.fn(),
        onReconnect: vi.fn(),
        onMembershipChanged,
    });
    channel.start();
    return { ...fake, channel, onMembershipChanged };
};

const membership = (userId: string, role: string | null, documentId = DOC) => ({
    table: 'document_members',
    document_id: documentId,
    user_id: userId,
    role,
    id: 'msg-id',
});

describe('membership broadcasts', () => {
    it('re-checks when this user’s own membership changes or ends', () => {
        const { broadcast, onMembershipChanged } = start();

        broadcast('membership', membership(SELF, 'viewer'));
        broadcast('membership', membership(SELF, null));

        expect(onMembershipChanged).toHaveBeenCalledTimes(2);
    });

    it('ignores other members’ changes and other documents', () => {
        const { broadcast, onMembershipChanged } = start();

        broadcast('membership', membership('someone-else', null));
        broadcast('membership', membership(SELF, null, 'doc-2'));

        expect(onMembershipChanged).not.toHaveBeenCalled();
    });

    it('ignores a malformed payload', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { broadcast, onMembershipChanged } = start();

        broadcast('membership', { table: 'document_members', user_id: SELF });

        expect(onMembershipChanged).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('re-checks when the channel join is refused, but not after stop', () => {
        const { status, channel, onMembershipChanged } = start();

        status('CHANNEL_ERROR');
        expect(onMembershipChanged).toHaveBeenCalledTimes(1);

        channel.stop();
        status('CHANNEL_ERROR');
        expect(onMembershipChanged).toHaveBeenCalledTimes(1);
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
