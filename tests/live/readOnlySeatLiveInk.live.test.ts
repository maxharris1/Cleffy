// @vitest-environment node
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import { DocRealtimeChannel, docTopic } from '@/sync/realtimeChannel';
import { INK_PROGRESS_EVENT } from '@/sync/wire';

import { createLiveDistrict, LIVE_LOCAL, type LiveDistrict } from './districtFixture';

/**
 * Live ink from a seat that turns read-only, against the real Realtime server
 * (migrations 20261020180600 and 20261020180800; Codex round-3 review of #61).
 * The sixth teacher owns a score that the first edits too, and joined its
 * doc:{id} topic while their seat was active. Realtime keeps a channel's send
 * permission from the join until the client's next token refresh, so the
 * policy alone does not stop them. This proves the rest:
 *
 *  1. the change reaches the app's channel at once: the server's membership
 *     hint arrives on the open DocRealtimeChannel, which is what makes the
 *     viewer re-read its seat and drop to view only;
 *  2. view only restarts the channel, and a fresh join is refused every
 *     broadcast while presence still works;
 *  3. a client that ignores the hint is refused every send from its next
 *     token refresh (and Realtime closes the channel when the token expires).
 *     Cutting such a client off before that is PR #63's topic rotation, which
 *     20261020180800 calls when present and tests/sql/district_read_only_seats.sql
 *     proves it calls.
 *
 * Local stack only; see districtFixture.ts for how to run it.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (what: string, test: () => boolean, ms = 15_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!test()) {
        if (Date.now() > until) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(50);
    }
};

const join = (client: SupabaseClient, topic: string, ack: boolean): Promise<RealtimeChannel> =>
    new Promise((resolve, reject) => {
        const channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack } } });
        channel.subscribe((status, err) => {
            if (status === 'SUBSCRIBED') {
                resolve(channel);
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                reject(new Error(`join ${topic}: ${status} ${err?.message ?? ''}`));
            }
        });
    });

describe.skipIf(!LIVE_LOCAL)('live ink from a seat that turns read-only', () => {
    let district: LiveDistrict;
    const docId = crypto.randomUUID();
    const received: number[] = [];

    beforeAll(async () => {
        district = await createLiveDistrict(`ink${Date.now().toString(36)}`);
        const [t1, , , , , t6] = district.teachers;
        const { error } = await district.admin
            .from('documents')
            .insert({ id: docId, owner_id: t6!.id, title: 'Live ink', storage_path: `${docId}/original.pdf` });
        expect(error).toBeNull();
        const { error: memberError } = await district.admin
            .from('document_members')
            .insert({ document_id: docId, user_id: t1!.id, role: 'editor' });
        expect(memberError).toBeNull();
    }, 60_000);

    afterAll(async () => {
        await district?.cleanup();
    }, 60_000);

    it('reaches the open channel at once, refuses a rejoined one, and a stale one from its next token refresh', async () => {
        const t1 = district.teachers[0]!;
        const t6 = district.teachers[5]!;
        const topic = docTopic(docId);

        // The peer, listening for live ink.
        const peer = await join(t1.client, topic, false);
        peer.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => {
            received.push((payload as { n: number }).n);
        });

        // The read-only-to-be teacher's app channel (as PdfViewport wires it) ...
        let hinted = 0;
        const app = new DocRealtimeChannel({
            supabase: t6.client as unknown as TypedSupabaseClient,
            docId,
            self: { userId: t6.id, name: 'Teacher six', color: '#123456', page: 0, isAnonymous: false },
            onRemoteInk: () => undefined,
            onDbChange: () => undefined,
            onPeers: () => undefined,
            onReconnect: () => undefined,
            onResync: () => undefined,
            onMembershipChanged: () => {
                hinted += 1;
            },
        });
        app.start();
        await waitFor('the app channel to join', () =>
            t6.client.realtime.getChannels().some((c) => c.topic === `realtime:${topic}` && c.state === 'joined'),
        );

        // ... and a second socket for the same account that ignores every hint.
        const { createClient } = await import('@supabase/supabase-js');
        const stale = createClient(process.env.CLEFFY_LIVE_SUPABASE_URL!, process.env.CLEFFY_LIVE_ANON_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: signedIn } = await stale.auth.signInWithPassword({
            email: t6.email,
            password: 'live-district-seat-1',
        });
        await stale.realtime.setAuth(signedIn.session!.access_token);
        const staleChannel = await join(stale, topic, true);
        const send = async (n: number) => {
            const answer = await staleChannel.send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload: { n } });
            await sleep(700);
            return answer;
        };

        expect(await send(1)).toBe('ok');
        await waitFor('the active seat’s ink to reach the peer', () => received.includes(1));

        // The district's override is cleared: back to Academy's 5, so the sixth
        // seat is read-only, and the override's own reconcile follows it.
        await district.lapse();
        expect((await t6.client.rpc('caller_seat_read_only')).data).toBe(true);

        // 1. The app's open channel hears it at once.
        await waitFor('the membership hint on the open channel', () => hinted > 0);

        // 2. View only restarts the channel; a fresh join may not broadcast.
        app.stop();
        await t6.client.removeAllChannels();
        const rejoined = await join(t6.client, topic, true);
        expect(await rejoined.send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload: { n: 2 } })).not.toBe('ok');
        await sleep(700);
        expect(received).not.toContain(2);
        // Presence still works: a read-only seat is still seen on the score.
        expect(await rejoined.track({ userId: t6.id })).toBe('ok');

        // 3. The stale channel kept its permission from the join (Realtime's
        // cache) ...
        expect(await send(3)).toBe('ok');
        await waitFor('the stale channel’s cached permission', () => received.includes(3));

        // ... until its token is refreshed: from then on every send is refused.
        const { data: refreshed } = await stale.auth.refreshSession();
        await stale.realtime.setAuth(refreshed.session!.access_token);
        await sleep(1500);
        expect(await send(4)).not.toBe('ok');
        expect(received).not.toContain(4);

        // Active again: a fresh join broadcasts.
        await district.restore();
        await t6.client.removeAllChannels();
        const active = await join(t6.client, topic, true);
        expect(await active.send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload: { n: 5 } })).toBe('ok');
        await waitFor('the active seat’s ink again', () => received.includes(5));

        await stale.removeAllChannels();
    }, 90_000);
});
