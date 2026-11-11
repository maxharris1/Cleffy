// @vitest-environment node
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { docTopic } from '@/sync/realtimeChannel';
import { INK_PROGRESS_EVENT } from '@/sync/wire';

import { createLiveDistrict, LIVE_LOCAL, type LiveDistrict } from './districtFixture';

/**
 * Grace that runs out on the clock alone, against the real Realtime server and
 * Storage API (migration 20261020181100_read_only_seats_grace_deadline.sql;
 * launch-compliance decision 26, Codex round-4 review of #61, D2 partial).
 *
 * The district's invoice is past due with its grace ending seconds from now.
 * The sixth teacher -- a full seat until the deadline, read-only after it --
 * joins the score's doc:{id} topic and sends BEFORE the deadline, and nothing
 * runs at the deadline: no webhook, no hourly sweep (seat_read_only_since stays
 * empty, so no hint and no topic rotation). Realtime keeps a channel's send
 * permission from its first send until the token changes, so before
 * 20261020181100 that channel went on broadcasting past the deadline. Now the
 * send is refused, because the grace ends before its token does, and stays
 * refused after; past the deadline the Storage write is refused too. Before
 * the deadline the seat still writes its file.
 *
 * Local stack only; see districtFixture.ts for how to run it.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const GRACE_LEFT_MS = 8_000;

describe.skipIf(!LIVE_LOCAL)('a grace period that runs out on the clock alone', () => {
    let district: LiveDistrict;
    const docId = crypto.randomUUID();
    const path = `${docId}/original.pdf`;
    const pdf = (text: string) => new Blob([`%PDF-1.4\n% ${text}\n`], { type: 'application/pdf' });
    const received: number[] = [];

    beforeAll(async () => {
        district = await createLiveDistrict(`grace${Date.now().toString(36)}`);
        const [t1, , , , , t6] = district.teachers;
        const { error } = await district.admin
            .from('documents')
            .insert({ id: docId, owner_id: t6!.id, title: 'Grace deadline', storage_path: path });
        expect(error).toBeNull();
        const { error: memberError } = await district.admin
            .from('document_members')
            .insert({ document_id: docId, user_id: t1!.id, role: 'editor' });
        expect(memberError).toBeNull();
    }, 60_000);

    afterAll(async () => {
        await district?.admin
            .from('subscriptions')
            .update({ status: 'active' })
            .eq('stripe_subscription_id', district.subscriptionId);
        await district?.admin.storage.from('scores').remove([path]);
        await district?.cleanup();
    }, 60_000);

    it('stops live ink and storage writes at the deadline itself, with no sweep', async () => {
        const t1 = district.teachers[0]!;
        const t6 = district.teachers[5]!;
        const topic = docTopic(docId);
        const storage = () => t6.client.storage.from('scores');

        const peer = await join(t1.client, topic, false);
        peer.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => {
            received.push((payload as { n: number }).n);
        });

        // The invoice went past due 30 days ago, less GRACE_LEFT_MS: the
        // write's own reconcile runs now, inside grace, and nothing after.
        const deadline = Date.now() + GRACE_LEFT_MS;
        const { error: pastDue } = await district.admin
            .from('subscriptions')
            .update({
                status: 'past_due',
                past_due_since: new Date(deadline - 30 * 86_400_000).toISOString(),
            })
            .eq('stripe_subscription_id', district.subscriptionId);
        expect(pastDue).toBeNull();

        // Before the deadline: a full seat, which writes its score file ...
        expect((await t6.client.rpc('caller_seat_read_only')).data).toBe(false);
        expect((await storage().upload(path, pdf('v1, inside grace'), { upsert: true })).error).toBeNull();

        // ... and joins live ink. Realtime asks the broadcast policy at the
        // channel's first send and keeps the answer until the token changes,
        // so this send, before the deadline, is the answer it would keep. The
        // grace ends before this token does, so it is refused now: no
        // permission Realtime holds can outlive the deadline. (Before
        // 20261020181100 it was 'ok', and so was every send after the
        // deadline, below.)
        const channel = await join(t6.client, topic, true);
        const send = async (n: number) => {
            const answer = await channel.send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload: { n } });
            await sleep(700);
            return answer;
        };
        expect(await send(0)).not.toBe('ok');
        expect(Date.now()).toBeLessThan(deadline);
        expect(received).not.toContain(0);

        // The deadline passes. Nothing runs: no webhook, no sweep.
        await sleep(Math.max(deadline - Date.now(), 0) + 1_000);
        const { data: onFile } = await district.admin
            .from('seat_read_only_since')
            .select('user_id')
            .eq('user_id', t6.id);
        expect(onFile).toEqual([]);
        expect((await t6.client.rpc('caller_seat_read_only')).data).toBe(true);

        // The channel joined before the deadline cannot broadcast after it.
        expect(await send(1)).not.toBe('ok');
        expect(received).not.toContain(1);

        // And the score file cannot be replaced.
        expect((await storage().upload(path, pdf('v2, past grace'), { upsert: true })).error).not.toBeNull();
        expect(await (await storage().download(path)).data!.text()).toContain('v1');
    }, 60_000);
});
