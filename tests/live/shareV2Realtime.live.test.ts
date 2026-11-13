// @vitest-environment node
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { docDbTopic, docTopic } from '@/sync/realtimeChannel';
import { INK_PROGRESS_EVENT, TOPIC_ROTATED_EVENT } from '@/sync/wire';

/**
 * Share v2's signed-out viewer against the real Realtime server and the real
 * share-session function (#104): the owner opens "Anyone with the link:
 * Viewer"; a visitor with no account trades the link for a 10-minute viewer
 * token and
 *   - receives the owner's in-progress ink on doc:{id} and saved marks on
 *     doc-view:{id};
 *   - cannot send ink, and is refused doc-db:{id};
 *   - shows up in the owner's presence;
 *   - after the owner restricts the score, is told topic_rotated, is refused
 *     the new topics, and its token renewal is refused.
 *
 * Local stack only, with the functions served and the switch on:
 *
 *     printf 'SHARE_V2_ENABLED=1\nSHARE_JWT_SECRET=<JWT_SECRET from supabase status>\n' > /tmp/share.env
 *     npx supabase functions serve --env-file /tmp/share.env &
 *     CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LIVE_ANON_KEY=... CLEFFY_LIVE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/live/shareV2Realtime.live.test.ts
 *
 * It deletes its accounts and score afterwards; `bash scripts/live-tests-cleanup.sh`
 * removes the realtime hints and GoTrue audit rows (@takedown.test addresses).
 */
const URL = process.env.CLEFFY_LIVE_SUPABASE_URL ?? '';
const ANON = process.env.CLEFFY_LIVE_ANON_KEY ?? '';
const SERVICE = process.env.CLEFFY_LIVE_SERVICE_ROLE_KEY ?? '';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL);

const PASSWORD = 'live-share-v2-test-1';

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

type Joined = {
    channel: RealtimeChannel;
    status: string;
    events: Array<{ event: string; payload: unknown }>;
    present: Set<string>;
};

const join = async (client: SupabaseClient, topic: string, presenceKey = ''): Promise<Joined> => {
    const events: Joined['events'] = [];
    const present = new Set<string>();
    const channel = client.channel(topic, {
        config: { private: true, broadcast: { self: false, ack: true }, presence: { key: presenceKey } },
    });
    channel.on('broadcast', { event: '*' }, (msg) => events.push({ event: msg.event, payload: msg.payload }));
    channel.on('presence', { event: 'sync' }, () => {
        for (const key of Object.keys(channel.presenceState())) present.add(key);
    });
    const status = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('TIMED_OUT'), 10_000);
        channel.subscribe((state) => {
            if (state === 'SUBSCRIBED' || state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
                clearTimeout(timer);
                resolve(state);
            }
        });
    });
    return { channel, status, events, present };
};

type Session = { state: string; role?: string; session_jwt?: string; exp?: number; pdf_url?: string };

const shareSession = async (body: Record<string, unknown>): Promise<{ status: number; body: Session }> => {
    const res = await fetch(`${URL}/functions/v1/share-session`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Session };
};

describe.skipIf(!LOCAL || !ANON || !SERVICE)('Share v2 viewer against the live Realtime server', () => {
    let admin: SupabaseClient;
    let owner: SupabaseClient;
    let ownerId = '';
    let viewer: SupabaseClient;
    let docId = '';
    let linkToken = '';
    let viewerJwt = '';
    let live: Joined;
    let view: Joined;

    beforeAll(async () => {
        admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
        const email = `share-v2-owner-${Date.now().toString(36)}@takedown.test`;
        const { data, error } = await admin.auth.admin.createUser({
            email,
            password: PASSWORD,
            email_confirm: true,
            user_metadata: { age_gate: { country: 'US', min_age: 13, source: 'self', v: 1 } },
        });
        if (error || !data.user) {
            throw new Error(`createUser: ${error?.message}`);
        }
        ownerId = data.user.id;
        owner = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: session } = await owner.auth.signInWithPassword({ email, password: PASSWORD });
        await owner.realtime.setAuth(session.session!.access_token);

        docId = crypto.randomUUID();
        const { error: docError } = await admin.from('documents').insert({
            id: docId,
            owner_id: ownerId,
            title: 'Live share v2',
            storage_path: `${docId}/original.pdf`,
            page_count: 2,
        });
        expect(docError).toBeNull();
        const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');
        const { error: uploadError } = await admin.storage
            .from('scores')
            .upload(`${docId}/original.pdf`, pdf, { contentType: 'application/pdf' });
        expect(uploadError).toBeNull();

        const { data: link, error: linkError } = await owner.rpc('set_general_access', {
            p_document: docId,
            p_mode: 'anyone',
            p_role: 'viewer',
        });
        expect(linkError).toBeNull();
        linkToken = (link as Array<{ token: string }>)[0]!.token;
    }, 60_000);

    afterAll(async () => {
        if (!admin) {
            return;
        }
        await owner?.removeAllChannels();
        await viewer?.removeAllChannels();
        if (docId) {
            await admin.storage.from('scores').remove([`${docId}/original.pdf`]);
            await admin.from('documents').delete().eq('id', docId);
            await admin.from('document_storage_cleanup').delete().eq('document_id', docId);
        }
        if (ownerId) {
            await admin.auth.admin.deleteUser(ownerId);
        }
    }, 60_000);

    it('mints a viewer token for the link, and none for a made-up one', async () => {
        const minted = await shareSession({ token: linkToken });
        expect(minted.status).toBe(200);
        expect(minted.body.state).toBe('live');
        expect(minted.body.role).toBe('viewer');
        expect(minted.body.session_jwt).toBeTruthy();
        viewerJwt = minted.body.session_jwt!;
        const claims = JSON.parse(Buffer.from(viewerJwt.split('.')[1]!, 'base64url').toString()) as Record<
            string,
            unknown
        >;
        expect(claims).toMatchObject({ iss: 'cleffy-share', role: 'anon', cleffy_link: { doc: docId, v: 1 } });
        expect(claims).not.toHaveProperty('sub');

        expect((await shareSession({ token: 'AAAAAAAAAAAAAAAAAAAAAA' })).body).toEqual({ state: 'invalid' });

        viewer = createClient(URL, ANON, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${viewerJwt}` } },
        });
        await viewer.realtime.setAuth(viewerJwt);
        const { data: access } = await viewer.rpc('link_view_access');
        expect(access).toMatchObject({ status: 'open', epoch: 0, doc: docId });
    });

    it('hears the owner live, gets saved marks on doc-view, cannot send ink, and is refused doc-db', async () => {
        const ownerLive = await join(owner, docTopic(docId), ownerId);
        expect(ownerLive.status).toBe('SUBSCRIBED');

        live = await join(viewer, docTopic(docId), 'anon-otter');
        view = await join(viewer, `doc-view:${docId}`);
        const db = await join(viewer, docDbTopic(docId));
        expect(live.status).toBe('SUBSCRIBED');
        expect(view.status).toBe('SUBSCRIBED');
        expect(db.status).toBe('CHANNEL_ERROR');

        expect(await live.channel.track({ name: 'Anonymous Otter' })).toBe('ok');
        await waitFor('the owner to see the viewer', () => ownerLive.present.has('anon-otter'));
        await sleep(500);
        expect(live.present.size).toBe(0);

        await ownerLive.channel.send({ type: 'broadcast', event: INK_PROGRESS_EVENT, payload: { strokeId: 's1' } });
        await waitFor('the viewer to hear live ink', () => live.events.some((e) => e.event === INK_PROGRESS_EVENT));

        const markId = crypto.randomUUID();
        const { error: markError } = await owner.from('annotations').insert({
            id: markId,
            document_id: docId,
            page: 0,
            kind: 'stroke',
            color: '#000000',
            payload: { pts: [0.1, 0.1, 0.5], w: 0.01 },
            created_by: ownerId,
        });
        expect(markError).toBeNull();
        await waitFor('the saved mark on doc-view', () =>
            view.events.some((e) => e.event === 'mark' && (e.payload as { id?: string }).id === markId),
        );

        const forged = await live.channel.send({
            type: 'broadcast',
            event: INK_PROGRESS_EVENT,
            payload: { forged: true },
        });
        expect(forged).not.toBe('ok');
        await sleep(1_000);
        expect(ownerLive.events.filter((e) => e.event === INK_PROGRESS_EVENT)).toHaveLength(0);
    }, 60_000);

    it('after Restricted: topic_rotated, refused on rejoin, renewal refused', async () => {
        const rotated = (joined: Joined) => joined.events.some((e) => e.event === TOPIC_ROTATED_EVENT);
        const { error } = await owner.rpc('set_general_access', { p_document: docId, p_mode: 'restricted' });
        expect(error).toBeNull();
        await waitFor('topic_rotated on doc and doc-view', () => rotated(live) && rotated(view));

        const { data: access } = await viewer.rpc('link_view_access');
        expect(access).toEqual({ status: 'revoked' });
        // A viewer app that ignores the hint and joins the new generation anyway,
        // each topic on a fresh socket.
        for (const topic of [docTopic(docId, 1), `doc-view:${docId}:1`]) {
            const fresh = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
            await fresh.realtime.setAuth(viewerJwt);
            const again = await join(fresh, topic);
            await fresh.removeAllChannels();
            expect(again.status, topic).toBe('CHANNEL_ERROR');
        }

        const renewal = await shareSession({ token: linkToken, renew: viewerJwt });
        expect(renewal.body).toEqual({ state: 'revoked' });
    }, 60_000);
});
