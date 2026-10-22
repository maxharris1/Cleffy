// @vitest-environment node
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TypedSupabaseClient } from '@/lib/supabase';
import {
    DocRealtimeChannel,
    docDbTopic,
    docTopic,
    fetchRealtimeTopicEpoch,
    type TopicEpochRead,
} from '@/sync/realtimeChannel';
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
 * And when the owner's generation read fails after the takedown (forced on
 * the client; the server is real), the owner has already left the old topics
 * on the server's hint, and its ink never reaches the adversary there, even
 * after the adversary updates its presence, until a retry succeeds and it
 * joins the new ones; the collaborator's own app, told no, leaves both topics
 * at once.
 *
 * And an archive (20261022120200): every open device of the score -- owner,
 * editor, viewer -- leaves its topics, and once the score is restored joins
 * again by itself, the same mounted channel, no reopen.
 *
 * Local stack only (`npm run cloud:up`); skipped unless pointed at it:
 *
 *     CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LIVE_ANON_KEY=... CLEFFY_LIVE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/live/takedownRealtime.live.test.ts
 *
 * It creates its own throwaway accounts and scores and deletes them after,
 * with the takedowns, the notices they queued and the scores' storage cleanup
 * rows. Two things it causes are out of the API's reach and are left to the
 * local stack: the hints the server broadcast (realtime.messages, dropped
 * with their daily partition) and GoTrue's audit log of the sign-ups.
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

/**
 * A member's device: the app's own channel class, as PdfViewport wires it.
 * `failEpochReads` makes its generation reads fail (a dropped request) while
 * it returns true; the Realtime server is still the real one.
 */
const ownerDevice = (
    client: SupabaseClient,
    docId: string,
    userId: string,
    name: string,
    failEpochReads: () => boolean = () => false,
) => {
    const rows: AnnotationRow[] = [];
    const inks: InkProgressMsg[] = [];
    const epochReads: Array<TopicEpochRead['status']> = [];
    let membershipChecks = 0;
    const supabase = client as unknown as TypedSupabaseClient;
    const channel = new DocRealtimeChannel({
        supabase,
        docId,
        self: { userId, name, color: '#123456', page: 0, isAnonymous: false },
        onRemoteInk: (msg) => inks.push(msg),
        onDbChange: (row) => rows.push(row),
        onPeers: () => undefined,
        onReconnect: () => undefined,
        onResync: () => undefined,
        onMembershipChanged: () => {
            membershipChecks += 1;
        },
        fetchTopicEpoch: async () => {
            const read: TopicEpochRead = failEpochReads()
                ? { status: 'failed' }
                : await fetchRealtimeTopicEpoch(supabase, docId);
            epochReads.push(read.status);
            return read;
        },
    });
    channel.start();
    return { channel, rows, inks, epochReads, membershipChecks: () => membershipChecks };
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
    const extraDocIds: string[] = [];
    const extraClients: SupabaseClient[] = [];

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
        for (const client of extraClients) {
            await client.removeAllChannels();
        }
        const docIds = [docId, ...extraDocIds].filter(Boolean);
        // The takedowns' notices (apply/lift_content_takedown queue and log
        // them), before the scores take the takedown rows with them.
        const { data: takedowns } = await admin.from('content_takedowns').select('id').in('document_id', docIds);
        const takedownIds = (takedowns ?? []).map((t: { id: string }) => t.id);
        if (takedownIds.length > 0) {
            await admin.from('content_notice_outbox').delete().in('takedown_id', takedownIds);
            await admin.from('content_notice_log').delete().in('takedown_id', takedownIds);
        }
        for (const id of docIds) {
            await admin.from('documents').delete().eq('id', id);
        }
        // What deleting a score queues for its storage objects (there are none),
        // and the takedown records a deleted score keeps (document_id cleared).
        await admin.from('document_storage_cleanup').delete().in('document_id', docIds);
        if (takedownIds.length > 0) {
            await admin.from('content_takedowns').delete().in('id', takedownIds);
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
        expect(await fetchRealtimeTopicEpoch(collaborator as unknown as TypedSupabaseClient, docId)).toEqual({
            status: 'denied',
        });

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
        expect(await fetchRealtimeTopicEpoch(collaborator as unknown as TypedSupabaseClient, docId)).toEqual({
            status: 'epoch',
            epoch: 1,
        });
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

    it('a failing generation read keeps the owner’s ink off the old topic; a denial closes the collaborator’s channels', async () => {
        // A score of its own, at generation 0.
        const scoreId = crypto.randomUUID();
        extraDocIds.push(scoreId);
        const { error: docError } = await admin.from('documents').insert({
            id: scoreId,
            owner_id: ownerId,
            title: 'Live epoch hold',
            storage_path: `${scoreId}/original.pdf`,
        });
        expect(docError).toBeNull();
        const { error: memberError } = await admin
            .from('document_members')
            .insert({ document_id: scoreId, user_id: collaboratorId, role: 'editor' });
        expect(memberError).toBeNull();

        // The adversary, on its own socket: on doc:{id} before the takedown,
        // present, deaf to every hint, and free to update its presence.
        const adversary = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: adv } = await adversary.auth.signInWithPassword({
            email: `collab-${tag}@takedown.test`,
            password: PASSWORD,
        });
        await adversary.realtime.setAuth(adv.session!.access_token);
        extraClients.push(adversary);
        const heard: InkProgressMsg[] = [];
        let advStatus = '';
        const advLive: RealtimeChannel = adversary.channel(docTopic(scoreId), {
            config: { private: true, broadcast: { self: false }, presence: { key: `${collaboratorId}-adv` } },
        });
        const advPresence = (page: number) =>
            advLive.track({ userId: collaboratorId, name: 'Adversary', color: '#000', page, isAnonymous: false });
        advLive.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) => heard.push(payload as InkProgressMsg));
        advLive.subscribe((status) => {
            advStatus = status;
            if (status === 'SUBSCRIBED') {
                void advPresence(0);
            }
        });

        // The collaborator's app, on another socket: it follows the hints.
        const collabApp = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: app } = await collabApp.auth.signInWithPassword({
            email: `collab-${tag}@takedown.test`,
            password: PASSWORD,
        });
        await collabApp.realtime.setAuth(app.session!.access_token);
        extraClients.push(collabApp);
        const collab = ownerDevice(collabApp, scoreId, collaboratorId, 'Collaborator');

        // The owner, whose generation reads fail on demand.
        let failing = false;
        const a = ownerDevice(owner, scoreId, ownerId, 'Owner A', () => failing);
        const scoreTopics = (client: SupabaseClient) => joinedTopics(client).filter((topic) => topic.includes(scoreId));
        await waitFor(
            'everyone to join generation 0',
            () => advStatus === 'SUBSCRIBED' && scoreTopics(owner).length === 2,
        );
        await waitFor('the collaborator app to join generation 0', () => scoreTopics(collabApp).length === 2);
        await sleep(1500);
        stroke(a, 'before');
        await waitFor('the adversary to hear the owner before the takedown', () =>
            heard.some((m) => m.strokeId === 'before'),
        );

        // The owner's reads start failing, then the takedown.
        failing = true;
        const readsBefore = a.epochReads.length;
        const { error: takedownError } = await admin.rpc('apply_content_takedown', {
            p_document: scoreId,
            p_action: 'restrict',
            p_ground: 'copyright',
            p_legal_basis: '17 U.S.C. 512',
            p_facts: 'Live epoch-hold test',
            p_report: null,
            p_moderator: moderatorId,
        });
        expect(takedownError).toBeNull();

        // The read failed, and a retry failed too. The owner left the old
        // topics, where the adversary sits, the moment the server's hint
        // arrived (20261022120100), and joins nothing until a read succeeds.
        await waitFor('two failed reads on the owner', () => a.epochReads.slice(readsBefore).length >= 2, 20_000);
        expect(a.epochReads.slice(readsBefore).every((status) => status === 'failed')).toBe(true);
        expect(scoreTopics(owner)).toEqual([]);

        // The adversary updates its presence (b8adc513 let that restore the
        // owner's audience), and the owner draws.
        await advPresence(1);
        await sleep(1500);
        const heardBefore = heard.length;
        for (let i = 0; i < 5; i++) {
            stroke(a, `held-${i}`);
            await sleep(120);
        }
        await sleep(1500);
        expect(heard.slice(heardBefore)).toEqual([]);

        // The collaborator's app was told no: it left both topics at once and
        // asked the app to re-check (the restricted state).
        await waitFor('the collaborator app to leave both topics', () => scoreTopics(collabApp).length === 0);
        expect(collab.epochReads).toContain('denied');
        expect(collab.membershipChecks()).toBeGreaterThan(0);

        // The owner's reads work again: the next retry moves it to generation 1.
        failing = false;
        await waitFor(
            'the owner to move to generation 1',
            () => {
                const topics = scoreTopics(owner);
                return topics.includes(docTopic(scoreId, 1)) && topics.includes(docDbTopic(scoreId, 1));
            },
            40_000,
        );
        await sleep(1500);
        for (let i = 0; i < 3; i++) {
            stroke(a, `moved-${i}`);
            await sleep(120);
        }
        await sleep(1500);
        expect(heard.slice(heardBefore)).toEqual([]);

        a.channel.stop();
        collab.channel.stop();
    }, 120_000);

    /**
     * 20261022120000: losing access rotates the score too, not only a
     * takedown. The removed member's channels and the demoted editor's channel
     * were joined before the change and ignore every hint.
     */
    it('a member removed while connected hears nothing more, and an editor made viewer reaches nobody', async () => {
        const o2 = await signedIn(admin, `owner2-${tag}@takedown.test`);
        const stay = await signedIn(admin, `stay-${tag}@takedown.test`);
        const demoted = await signedIn(admin, `demoted-${tag}@takedown.test`);
        userIds.push(o2.id, stay.id, demoted.id);
        extraClients.push(o2.client, stay.client, demoted.client);
        const scoreId = crypto.randomUUID();
        extraDocIds.push(scoreId);
        const { error: docError } = await admin.from('documents').insert({
            id: scoreId,
            owner_id: o2.id,
            title: 'Live revocation',
            storage_path: `${scoreId}/original.pdf`,
        });
        expect(docError).toBeNull();
        const { error: memberError } = await admin.from('document_members').insert([
            { document_id: scoreId, user_id: collaboratorId, role: 'editor' },
            { document_id: scoreId, user_id: stay.id, role: 'editor' },
            { document_id: scoreId, user_id: demoted.id, role: 'editor' },
        ]);
        expect(memberError).toBeNull();

        /** A raw channel that never leaves, never re-checks, and is present. */
        const adversary = (client: SupabaseClient, userId: string, topic: string, key: string) => {
            const heard: InkProgressMsg[] = [];
            const committed: string[] = [];
            let status = '';
            const channel = client.channel(topic, {
                config: { private: true, broadcast: { self: false }, presence: { key } },
            });
            channel.on('broadcast', { event: INK_PROGRESS_EVENT }, ({ payload }) =>
                heard.push(payload as InkProgressMsg),
            );
            channel.on('broadcast', { event: 'INSERT' }, ({ payload }) =>
                committed.push((payload as { record: { id: string } }).record.id),
            );
            channel.subscribe((s) => {
                status = s;
                if (s === 'SUBSCRIBED' && topic.startsWith('doc:')) {
                    void channel.track({ userId, name: key, color: '#000', page: 0, isAnonymous: false });
                }
            });
            const ink = (strokeId: string) =>
                channel.send({
                    type: 'broadcast',
                    event: INK_PROGRESS_EVENT,
                    payload: {
                        strokeId,
                        userId,
                        page: 0,
                        kind: 'stroke',
                        color: '#000000',
                        w: 0.01,
                        pts: [0.3, 0.3, 0.5],
                        done: true,
                    } satisfies InkProgressMsg,
                });
            return { heard, committed, ink, status: () => status };
        };
        const removedLive = adversary(collaborator, collaboratorId, docTopic(scoreId), 'removed');
        const removedDb = adversary(collaborator, collaboratorId, docDbTopic(scoreId), 'removed-db');
        const demotedLive = adversary(demoted.client, demoted.id, docTopic(scoreId), 'demoted');

        // The owner and the member who stays run the app's own channel.
        const ownerApp = ownerDevice(o2.client, scoreId, o2.id, 'Owner');
        const stayApp = ownerDevice(stay.client, scoreId, stay.id, 'Stays');
        const scoreTopics = (client: SupabaseClient) => joinedTopics(client).filter((topic) => topic.includes(scoreId));
        const onGeneration = (client: SupabaseClient, n: number) => {
            const topics = scoreTopics(client);
            return topics.includes(docTopic(scoreId, n)) && topics.includes(docDbTopic(scoreId, n));
        };
        await waitFor(
            'everyone to join generation 0',
            () =>
                [removedLive, removedDb, demotedLive].every((c) => c.status() === 'SUBSCRIBED') &&
                onGeneration(o2.client, 0) &&
                onGeneration(stay.client, 0),
        );
        await sleep(1500);
        stroke(ownerApp, 'before');
        await waitFor('the removed member and the demoted editor to hear the owner before', () =>
            [removedLive, demotedLive].every((c) => c.heard.some((m) => m.strokeId === 'before')),
        );
        await demotedLive.ink('demoted-before');
        await waitFor('the owner to hear the editor before', () =>
            ownerApp.inks.some((m) => m.strokeId === 'demoted-before'),
        );

        // The owner removes a member (its own request, so its own commit).
        const { error: removeError } = await o2.client.rpc('remove_document_member', {
            p_document: scoreId,
            p_user: collaboratorId,
        });
        expect(removeError).toBeNull();
        await waitFor(
            'the owner and the member who stays to move to generation 1',
            () => onGeneration(o2.client, 1) && onGeneration(stay.client, 1),
        );
        expect(ownerApp.membershipChecks()).toBe(0);
        // Still subscribed where it was: Realtime never evicted it.
        expect(joinedTopics(collaborator)).toEqual(expect.arrayContaining([docTopic(scoreId), docDbTopic(scoreId)]));
        await sleep(1500);

        const heardBefore = removedLive.heard.length;
        for (let i = 0; i < 3; i++) {
            stroke(ownerApp, `after-remove-${i}`);
            await sleep(120);
        }
        // More marks than the pull's overlap: the member who stays gets every one.
        const ids: string[] = Array.from({ length: 60 }, () => crypto.randomUUID());
        const { error: insertError } = await o2.client.from('annotations').insert(
            ids.map((id) => ({
                id,
                document_id: scoreId,
                page: 0,
                kind: 'stroke' as const,
                color: '#000000',
                payload: { pts: [0, 0, 1], w: 0.01 },
                created_by: o2.id,
            })),
        );
        expect(insertError).toBeNull();
        await waitFor('the member who stays to receive all 60 committed marks', () =>
            ids.every((id) => stayApp.rows.some((row) => row.id === id)),
        );
        await waitFor('the member who stays to hear the owner on generation 1', () =>
            stayApp.inks.some((m) => m.strokeId === 'after-remove-2'),
        );
        await sleep(1000);
        // Not one batch of ink and not one committed mark reached the removed member.
        expect(removedLive.heard.slice(heardBefore)).toEqual([]);
        expect(removedDb.committed.filter((id) => ids.includes(id))).toEqual([]);
        expect(await fetchRealtimeTopicEpoch(collaborator as unknown as TypedSupabaseClient, scoreId)).toEqual({
            status: 'denied',
        });
        let refused = '';
        const sneak = collaborator.channel(docDbTopic(scoreId, 1), { config: { private: true } });
        sneak.subscribe((s) => {
            refused = s;
        });
        await waitFor('the removed member join on generation 1 to be refused', () => refused === 'CHANNEL_ERROR');
        await collaborator.removeChannel(sneak);

        // The demoted editor's old channel kept the send permission Realtime
        // cached at join; the owner moves, so it reaches nobody.
        const { error: roleError } = await o2.client.rpc('set_document_member_role', {
            p_document: scoreId,
            p_user: demoted.id,
            p_role: 'viewer',
        });
        expect(roleError).toBeNull();
        await waitFor(
            'the owner and the member who stays to move to generation 2',
            () => onGeneration(o2.client, 2) && onGeneration(stay.client, 2),
        );
        await sleep(1500);
        const ownerInksBefore = ownerApp.inks.length;
        for (let i = 0; i < 3; i++) {
            await demotedLive.ink(`demoted-old-${i}`);
            await sleep(120);
        }
        // Joining generation 2 afresh, it is a viewer: it may join, not send.
        const fresh = adversary(demoted.client, demoted.id, docTopic(scoreId, 2), 'demoted-fresh');
        await waitFor('the demoted viewer to join generation 2', () => fresh.status() === 'SUBSCRIBED');
        for (let i = 0; i < 3; i++) {
            await fresh.ink(`demoted-new-${i}`);
            await sleep(120);
        }
        // The owner's own ink still reaches the member who stays...
        stroke(ownerApp, 'after-demote');
        await waitFor('the member who stays to hear the owner on generation 2', () =>
            stayApp.inks.some((m) => m.strokeId === 'after-demote'),
        );
        await sleep(1500);
        // ...and nothing the demoted viewer sent reached anyone.
        expect(ownerApp.inks.slice(ownerInksBefore).filter((m) => m.userId === demoted.id)).toEqual([]);
        expect(
            stayApp.inks.filter((m) => m.strokeId.startsWith('demoted-old') || m.strokeId.startsWith('demoted-new')),
        ).toEqual([]);

        ownerApp.channel.stop();
        stayApp.channel.stop();
    }, 120_000);
    /**
     * 20261022120200: archiving is temporary. The plan's score cap archives an
     * open score; every device on it leaves both topics and asks again every
     * 15-45 s, and after the restore joins the current generation by itself.
     */
    it('an archived score’s open devices leave its topics, and rejoin by themselves once it is restored', async () => {
        const o3 = await signedIn(admin, `owner3-${tag}@takedown.test`);
        const ed = await signedIn(admin, `editor3-${tag}@takedown.test`);
        const vw = await signedIn(admin, `viewer3-${tag}@takedown.test`);
        userIds.push(o3.id, ed.id, vw.id);
        extraClients.push(o3.client, ed.client, vw.client);
        const scoreId = crypto.randomUUID();
        extraDocIds.push(scoreId);
        const { error: docError } = await admin.from('documents').insert({
            id: scoreId,
            owner_id: o3.id,
            title: 'Live archive',
            storage_path: `${scoreId}/original.pdf`,
        });
        expect(docError).toBeNull();
        const { error: memberError } = await admin.from('document_members').insert([
            { document_id: scoreId, user_id: ed.id, role: 'editor' },
            { document_id: scoreId, user_id: vw.id, role: 'viewer' },
        ]);
        expect(memberError).toBeNull();

        const ownerApp = ownerDevice(o3.client, scoreId, o3.id, 'Owner');
        const editorApp = ownerDevice(ed.client, scoreId, ed.id, 'Editor');
        const viewerApp = ownerDevice(vw.client, scoreId, vw.id, 'Viewer');
        const devices = [
            { client: o3.client, app: ownerApp },
            { client: ed.client, app: editorApp },
            { client: vw.client, app: viewerApp },
        ];
        const scoreTopics = (client: SupabaseClient) => joinedTopics(client).filter((topic) => topic.includes(scoreId));
        const onGeneration = (client: SupabaseClient, n: number) => {
            const topics = scoreTopics(client);
            return topics.includes(docTopic(scoreId, n)) && topics.includes(docDbTopic(scoreId, n));
        };
        await waitFor('every device to join generation 0', () => devices.every((d) => onGeneration(d.client, 0)));
        await sleep(1500);
        stroke(ownerApp, 'before');
        await waitFor('the editor and the viewer to hear the owner before', () =>
            [editorApp, viewerApp].every((app) => app.inks.some((m) => m.strokeId === 'before')),
        );

        // Archived (service role, as the plan's score cap does it).
        const { error: archiveError } = await admin
            .from('documents')
            .update({ archived_at: new Date().toISOString(), archived_reason: 'plan_lapse' })
            .eq('id', scoreId);
        expect(archiveError).toBeNull();
        await waitFor('every device to leave both topics', () =>
            devices.every((d) => scoreTopics(d.client).length === 0 && d.app.epochReads.includes('archived')),
        );
        // Each was told the score is archived, not that it lost it, and the app re-checks.
        for (const { app } of devices) {
            expect(app.epochReads).not.toContain('denied');
            expect(app.membershipChecks()).toBeGreaterThan(0);
        }
        stroke(ownerApp, 'while-archived');
        await sleep(1500);
        expect(devices.every((d) => scoreTopics(d.client).length === 0)).toBe(true);
        expect(editorApp.inks.some((m) => m.strokeId === 'while-archived')).toBe(false);
        const checksWhileArchived = devices.map((d) => d.app.membershipChecks());

        // Restored: nobody reopens anything; the next recheck (15-45 s) rejoins.
        const { error: restoreError } = await admin
            .from('documents')
            .update({ archived_at: null, archived_reason: null })
            .eq('id', scoreId);
        expect(restoreError).toBeNull();
        await waitFor(
            'every device to rejoin generation 1 by itself',
            () => devices.every((d) => onGeneration(d.client, 1)),
            60_000,
        );
        devices.forEach((d, i) => {
            expect(d.app.epochReads.at(-1)).toBe('epoch');
            // The viewer re-reads the score and leaves its archived state.
            expect(d.app.membershipChecks()).toBeGreaterThan(checksWhileArchived[i]!);
        });
        await sleep(1500);

        // Live ink both ways, and committed marks, on the same mounted channels.
        stroke(ownerApp, 'restored');
        await waitFor('the editor and the viewer to hear the owner after the restore', () =>
            [editorApp, viewerApp].every((app) => app.inks.some((m) => m.strokeId === 'restored')),
        );
        stroke(editorApp, 'editor-restored');
        await waitFor('the owner to hear the editor after the restore', () =>
            ownerApp.inks.some((m) => m.strokeId === 'editor-restored'),
        );
        const markId = crypto.randomUUID();
        const { error: insertError } = await o3.client.from('annotations').insert({
            id: markId,
            document_id: scoreId,
            page: 0,
            kind: 'stroke' as const,
            color: '#000000',
            payload: { pts: [0, 0, 1], w: 0.01 },
            created_by: o3.id,
        });
        expect(insertError).toBeNull();
        await waitFor('the editor and the viewer to receive the committed mark', () =>
            [editorApp, viewerApp].every((app) => app.rows.some((row) => row.id === markId)),
        );

        for (const { app } of devices) {
            app.channel.stop();
        }
    }, 150_000);
});
