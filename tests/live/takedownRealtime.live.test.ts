// @vitest-environment node
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import { DocRealtimeChannel, docDbTopic, docTopic, fetchRealtimeTopicEpoch } from '@/sync/realtimeChannel';
import { INK_PROGRESS_EVENT, type InkProgressMsg } from '@/sync/wire';
import type { AnnotationRow } from '@/types/database';

/**
 * A takedown against the real Realtime server (20261020150100): the
 * collaborator's channel joined before the takedown, and its app ignores every
 * hint — the adversary Codex described. It must receive no live ink after the
 * takedown, while the owner's other device keeps receiving every committed
 * mark, more than the pull's 50-seq overlap included; after the lift the
 * collaborator hears the owner again, on the new topic.
 *
 * Local stack only (`npm run cloud:up`); skipped unless pointed at it:
 *
 *     CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LIVE_ANON_KEY=... CLEFFY_LIVE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/live/takedownRealtime.live.test.ts
 *
 * It creates its own throwaway accounts and score and deletes them after.
 */
const URL = process.env.CLEFFY_LIVE_SUPABASE_URL ?? '';
const ANON = process.env.CLEFFY_LIVE_ANON_KEY ?? '';
const SERVICE = process.env.CLEFFY_LIVE_SERVICE_ROLE_KEY ?? '';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL);

const PASSWORD = 'live-takedown-test-1';

const waitFor = async (what: string, test: () => boolean, ms = 15_000): Promise<void> => {
    const until = Date.now() + ms;
    while (!test()) {
        if (Date.now() > until) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sign in as a fresh account on its own client (its own realtime socket). */
const signedIn = async (admin: SupabaseClient, email: string): Promise<{ client: SupabaseClient; id: string }> => {
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error || !data.user) {
        throw new Error(`createUser ${email}: ${error?.message}`);
    }
    const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (signInError || !session.session) {
        throw new Error(`sign in ${email}: ${signInError?.message}`);
    }
    await client.realtime.setAuth(session.session.access_token);
    return { client, id: data.user.id };
};

/** The owner's device: the app's own channel class, as PdfViewport wires it. */
const ownerDevice = (client: SupabaseClient, docId: string, userId: string, name: string) => {
    const rows: AnnotationRow[] = [];
    const supabase = client as unknown as TypedSupabaseClient;
    const channel = new DocRealtimeChannel({
        supabase,
        docId,
        self: { userId, name, color: '#123456', page: 0, isAnonymous: false },
        onRemoteInk: () => undefined,
        onDbChange: (row) => rows.push(row),
        onPeers: () => undefined,
        onReconnect: () => undefined,
        onResync: () => undefined,
        fetchTopicEpoch: () => fetchRealtimeTopicEpoch(supabase, docId),
    });
    channel.start();
    return { channel, rows };
};

const joinedTopics = (client: SupabaseClient): string[] =>
    client.realtime
        .getChannels()
        .filter((c) => c.state === 'joined')
        .map((c) => c.topic.replace(/^realtime:/, ''));

const stroke = (device: ReturnType<typeof ownerDevice>, strokeId: string): void => {
    device.channel.publisher.start({ strokeId, page: 0, kind: 'stroke', color: '#000000', w: 0.01 });
    device.channel.publisher.append([0.1, 0.1, 0.5, 0.2, 0.2, 0.5]);
    device.channel.publisher.end();
};

describe.skipIf(!LOCAL || !ANON || !SERVICE)('takedown against the live Realtime server', () => {
    let admin: SupabaseClient;
    const tag = `${Date.now().toString(36)}`;
    const userIds: string[] = [];
    let docId = '';
    let owner: SupabaseClient;
    let ownerId = '';
    let ownerB: SupabaseClient;
    let collaborator: SupabaseClient;
    let collaboratorId = '';
    let moderatorId = '';

    beforeAll(async () => {
        admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
        const o = await signedIn(admin, `owner-${tag}@takedown.test`);
        owner = o.client;
        ownerId = o.id;
        // The owner's second device: same account, its own socket.
        ownerB = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: b } = await ownerB.auth.signInWithPassword({
            email: `owner-${tag}@takedown.test`,
            password: PASSWORD,
        });
        await ownerB.realtime.setAuth(b.session!.access_token);
        const c = await signedIn(admin, `collab-${tag}@takedown.test`);
        collaborator = c.client;
        collaboratorId = c.id;
        const m = await signedIn(admin, `mod-${tag}@takedown.test`);
        moderatorId = m.id;
        userIds.push(ownerId, collaboratorId, moderatorId);

        docId = crypto.randomUUID();
        const { error: docError } = await admin
            .from('documents')
            .insert({ id: docId, owner_id: ownerId, title: 'Live takedown', storage_path: `${docId}/original.pdf` });
        expect(docError).toBeNull();
        const { error: memberError } = await admin
            .from('document_members')
            .insert({ document_id: docId, user_id: collaboratorId, role: 'editor' });
        expect(memberError).toBeNull();
    }, 60_000);

    afterAll(async () => {
        if (!admin) {
            return;
        }
        await owner?.removeAllChannels();
        await ownerB?.removeAllChannels();
        await collaborator?.removeAllChannels();
        if (docId) {
            await admin.from('documents').delete().eq('id', docId);
        }
        for (const id of userIds) {
            await admin.auth.admin.deleteUser(id);
        }
    }, 60_000);

    it('a connected collaborator receives no live ink after the takedown; the owner keeps every device in sync', async () => {
        // The adversarial collaborator: joins doc:{id} and doc-db:{id} before
        // the takedown, is present (so the owner streams to it), and ignores
        // every hint: it never leaves, never re-checks.
        const heard: InkProgressMsg[] = [];
        const committed: string[] = [];
        const live: RealtimeChannel = collaborator.channel(docTopic(docId), {
            config: { private: true, broadcast: { self: false }, presence: { key: collaboratorId } },
        });
        live.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => heard.push(payload as InkProgressMsg));
        const db: RealtimeChannel = collaborator.channel(docDbTopic(docId), { config: { private: true } });
        db.on('broadcast', { event: 'INSERT' }, ({ payload }) =>
            committed.push((payload as { record: { id: string } }).record.id),
        );
        let liveStatus = '';
        let dbStatus = '';
        live.subscribe((status) => {
            liveStatus = status;
            if (status === 'SUBSCRIBED') {
                void live.track({
                    userId: collaboratorId,
                    name: 'Collaborator',
                    color: '#000',
                    page: 0,
                    isAnonymous: false,
                });
            }
        });
        db.subscribe((status) => {
            dbStatus = status;
        });
        await waitFor(
            'the collaborator to join both topics',
            () => liveStatus === 'SUBSCRIBED' && dbStatus === 'SUBSCRIBED',
        );

        const a = ownerDevice(owner, docId, ownerId, 'Owner A');
        const b = ownerDevice(ownerB, docId, ownerId, 'Owner B');
        await waitFor('both owner devices to join generation 0', () =>
            [owner, ownerB].every((client) => joinedTopics(client).length === 2),
        );
        await sleep(1500); // presence sync: each sees the others

        // Before: the harness works — the collaborator hears the owner draw.
        stroke(a, 'before');
        await waitFor('the collaborator to hear the owner before the takedown', () =>
            heard.some((m) => m.strokeId === 'before'),
        );

        // The takedown (service role, as content-moderation calls it).
        const { error: takedownError } = await admin.rpc('apply_content_takedown', {
            p_document: docId,
            p_action: 'restrict',
            p_ground: 'copyright',
            p_legal_basis: '17 U.S.C. 512',
            p_facts: 'Live realtime test',
            p_report: null,
            p_moderator: moderatorId,
        });
        expect(takedownError).toBeNull();

        // Both owner devices move to generation 1 on their own.
        await waitFor('both owner devices to move to generation 1', () =>
            [owner, ownerB].every((client) => {
                const topics = joinedTopics(client);
                return topics.includes(docTopic(docId, 1)) && topics.includes(docDbTopic(docId, 1));
            }),
        );
        // The collaborator is still subscribed to the old topics: Realtime
        // never evicted it, and its app ignored the hints.
        expect(joinedTopics(collaborator)).toEqual(expect.arrayContaining([docTopic(docId), docDbTopic(docId)]));
        await sleep(1500); // presence on generation 1

        const heardBefore = heard.length;
        for (let i = 0; i < 5; i++) {
            stroke(a, `after-${i}`);
            await sleep(120);
        }
        await sleep(1500);
        // Not one batch of the owner's new handwriting reached the collaborator.
        expect(heard.slice(heardBefore)).toEqual([]);

        // It cannot follow to generation 1 either: the join is refused.
        let refused = '';
        const sneak = collaborator.channel(docTopic(docId, 1), { config: { private: true } });
        sneak.subscribe((status) => {
            refused = status;
        });
        await waitFor('the collaborator join on generation 1 to be refused', () => refused === 'CHANNEL_ERROR');
        // realtime-js hands back a topic's existing channel, refused or not.
        await collaborator.removeChannel(sneak);
        expect(await fetchRealtimeTopicEpoch(collaborator as unknown as TypedSupabaseClient, docId)).toBeNull();

        // More marks than the pull's 50-seq overlap while restricted: owner B
        // receives every one live, so it never has a gap to skip.
        const ids: string[] = Array.from({ length: 60 }, () => crypto.randomUUID());
        const { error: insertError } = await owner.from('annotations').insert(
            ids.map((id) => ({
                id,
                document_id: docId,
                page: 0,
                kind: 'stroke' as const,
                color: '#000000',
                payload: { pts: [0, 0, 1], w: 0.01 },
                created_by: ownerId,
            })),
        );
        expect(insertError).toBeNull();
        await waitFor('owner B to receive all 60 committed marks', () =>
            ids.every((id) => b.rows.some((row) => row.id === id)),
        );
        expect(committed.filter((id) => ids.includes(id))).toEqual([]);

        // Lifted: the collaborator's app, opening the score again, reads
        // generation 1, joins it and hears the owner — the new topics work for
        // everyone the score admits. The old channel still hears nothing.
        const { data: takedown } = await admin
            .from('content_takedowns')
            .select('id')
            .eq('document_id', docId)
            .is('lifted_at', null)
            .single();
        const { error: liftError } = await admin.rpc('lift_content_takedown', {
            p_takedown: (takedown as { id: string }).id,
            p_reason: 'Counter-notice',
            p_moderator: moderatorId,
        });
        expect(liftError).toBeNull();
        expect(await fetchRealtimeTopicEpoch(collaborator as unknown as TypedSupabaseClient, docId)).toBe(1);
        const rejoined: InkProgressMsg[] = [];
        let rejoinStatus = '';
        const again = collaborator.channel(docTopic(docId, 1), {
            config: { private: true, broadcast: { self: false }, presence: { key: `${collaboratorId}-again` } },
        });
        again.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => rejoined.push(payload as InkProgressMsg));
        again.subscribe((status) => {
            rejoinStatus = status;
            if (status === 'SUBSCRIBED') {
                void again.track({
                    userId: collaboratorId,
                    name: 'Collaborator',
                    color: '#000',
                    page: 0,
                    isAnonymous: false,
                });
            }
        });
        await waitFor('the collaborator to join generation 1 after the lift', () => rejoinStatus === 'SUBSCRIBED');
        await sleep(1500);
        stroke(a, 'lifted');
        await waitFor('the collaborator to hear the owner on generation 1', () =>
            rejoined.some((m) => m.strokeId === 'lifted'),
        );
        expect(heard.slice(heardBefore)).toEqual([]);

        a.channel.stop();
        b.channel.stop();
    }, 90_000);
});
