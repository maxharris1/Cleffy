import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * A throwaway district on the local stack, for the live read-only-seat tests:
 * an owner on a Stripe Invoicing Academy subscription with a 10-seat override,
 * and six teachers seated oldest first, so clearing the override (back to
 * Academy's 5) makes the sixth read-only and setting it again makes them active.
 *
 * Local stack only (`npm run cloud:up`); the tests that use it are skipped
 * unless pointed at it:
 *
 *     CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LIVE_ANON_KEY=... CLEFFY_LIVE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/live/
 */
export const LIVE_URL = process.env.CLEFFY_LIVE_SUPABASE_URL ?? '';
export const LIVE_ANON = process.env.CLEFFY_LIVE_ANON_KEY ?? '';
export const LIVE_SERVICE = process.env.CLEFFY_LIVE_SERVICE_ROLE_KEY ?? '';
export const LIVE_LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(LIVE_URL) && !!LIVE_ANON && !!LIVE_SERVICE;

const PASSWORD = 'live-district-seat-1';

export interface LiveUser {
    client: SupabaseClient;
    id: string;
    email: string;
}

export interface LiveDistrict {
    admin: SupabaseClient;
    owner: LiveUser;
    teachers: LiveUser[];
    studioId: string;
    subscriptionId: string;
    /** Clear the override: the sixth teacher is past Academy's 5, read-only. */
    lapse(): Promise<void>;
    /** Set it again: every seat active. */
    restore(): Promise<void>;
    cleanup(): Promise<void>;
}

const must = <T>(result: { data: T; error: { message: string } | null }, what: string): T => {
    if (result.error) {
        throw new Error(`${what}: ${result.error.message}`);
    }
    return result.data;
};

export const signIn = async (admin: SupabaseClient, email: string): Promise<LiveUser> => {
    const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (created.error || !created.data.user) {
        throw new Error(`createUser ${email}: ${created.error?.message}`);
    }
    const client = createClient(LIVE_URL, LIVE_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error || !data.session) {
        throw new Error(`sign in ${email}: ${error?.message}`);
    }
    await client.realtime.setAuth(data.session.access_token);
    return { client, id: created.data.user.id, email };
};

export const createLiveDistrict = async (tag: string): Promise<LiveDistrict> => {
    const admin = createClient(LIVE_URL, LIVE_SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    const owner = await signIn(admin, `owner-${tag}@district.test`);
    const teachers: LiveUser[] = [];
    for (let i = 1; i <= 6; i++) {
        teachers.push(await signIn(admin, `t${i}-${tag}@district.test`));
    }
    const studioId = crypto.randomUUID();
    const subscriptionId = `sub_live_${tag}`;
    must(await admin.from('studios').insert({ id: studioId, owner_id: owner.id, name: `District ${tag}` }), 'studio');

    // The webhook's write, as stripe-webhook makes it.
    const holder = must(
        await admin.rpc('claim_subscription_write', { p_subscription_id: subscriptionId, p_stale_after: '5 minutes' }),
        'claim',
    );
    must(
        await admin.rpc('write_subscription_under_lock', {
            p_holder: holder,
            p_subscription_id: subscriptionId,
            p_user: owner.id,
            p_mode: 'test',
            p_tier: 'academy',
            p_status: 'active',
            p_price_id: 'price_district_custom',
            p_current_period_end: new Date(Date.now() + 365 * 86_400_000).toISOString(),
            p_cancel_at_period_end: false,
            p_last_event_created_at: new Date().toISOString(),
            p_collection_method: 'send_invoice',
        }),
        'subscription',
    );
    must(
        await admin.rpc('release_subscription_write', { p_subscription_id: subscriptionId, p_holder: holder }),
        'release',
    );

    const restore = async () => {
        must(
            await admin.rpc('admin_set_studio_seat_override', {
                p_studio: studioId,
                p_seat_limit: 10,
                p_stripe_subscription_id: subscriptionId,
                p_actor: 'live test',
                p_reason: 'live test',
            }),
            'override',
        );
    };
    await restore();
    for (const [i, t] of teachers.entries()) {
        must(
            await admin.from('studio_members').insert({
                studio_id: studioId,
                user_id: t.id,
                created_at: new Date(Date.now() - 86_400_000 + i * 60_000).toISOString(),
            }),
            'seat',
        );
    }

    return {
        admin,
        owner,
        teachers,
        studioId,
        subscriptionId,
        restore,
        lapse: async () => {
            must(
                await admin.rpc('admin_clear_studio_seat_override', {
                    p_studio: studioId,
                    p_actor: 'live test',
                    p_reason: 'live test',
                }),
                'clear override',
            );
        },
        cleanup: async () => {
            for (const u of [owner, ...teachers]) {
                await u.client.removeAllChannels();
            }
            await admin.from('documents').delete().eq('owner_id', teachers[5]!.id);
            await admin.from('studios').delete().eq('id', studioId);
            for (const u of [owner, ...teachers]) {
                await admin.auth.admin.deleteUser(u.id);
            }
        },
    };
};
