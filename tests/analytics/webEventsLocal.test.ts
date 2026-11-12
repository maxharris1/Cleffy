// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * web_events and signup_attribution through the real stack: GoTrue's tokens
 * and PostgREST, not the claims tests/sql/web_events.sql sets by hand. What
 * this proves that the SQL proof cannot: that GoTrue's own JWTs carry
 * is_anonymous and app_metadata.user_type the way record_web_events reads
 * them, and that a real sign-up's user_metadata reaches the trigger.
 *
 * Needs the local stack; CI's supabase-local job runs it with
 * CLEFFY_REQUIRE_LOCAL_DB=1. Every account it makes is deleted at the end.
 *
 *     eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
 *     CLEFFY_LOCAL_SUPABASE_URL="$API_URL" CLEFFY_LOCAL_ANON_KEY="$ANON_KEY" \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
 *         npx vitest run tests/analytics/webEventsLocal.test.ts
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const ANON_KEY = process.env.CLEFFY_LOCAL_ANON_KEY ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';
const CONFIGURED = Boolean(URL && ANON_KEY && SERVICE_KEY);

if (REQUIRED && !CONFIGURED) {
    throw new Error('CLEFFY_REQUIRE_LOCAL_DB=1 but the local Supabase URL or keys are missing');
}

const gate = { country: 'US', min_age: 13, source: 'self', v: 1 };
const PASSWORD = `pw-${randomUUID()}`;

const client = (key: string): SupabaseClient =>
    createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

const created: string[] = [];
const sessionKeys: string[] = [];

const event = () => {
    const key = randomUUID();
    sessionKeys.push(key);
    return { event: 'demo_visit', path: '/try', session_key: key, device_class: 'mobile', utm_campaign: 'e2e_web' };
};

const rowsFor = async (sessionKey: string) => {
    const { data, error } = await client(SERVICE_KEY)
        .from('web_events')
        .select('user_id, event, utm_campaign')
        .eq('session_key', sessionKey);
    expect(error).toBeNull();
    return data ?? [];
};

/** A confirmed account made by the admin API, signed in with a password. */
const signedIn = async (appMetadata: Record<string, unknown>, ageGate: Record<string, unknown> = gate) => {
    const email = `web-events-${randomUUID()}@example.invalid`;
    const admin = client(SERVICE_KEY);
    const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        app_metadata: appMetadata,
        user_metadata: { age_gate: ageGate },
    });
    expect(error).toBeNull();
    created.push(data.user!.id);
    const user = client(ANON_KEY);
    const signIn = await user.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signIn.error).toBeNull();
    return { user, id: data.user!.id };
};

afterAll(async () => {
    if (!CONFIGURED) {
        return;
    }
    const admin = client(SERVICE_KEY);
    for (const id of created) {
        await admin.auth.admin.deleteUser(id);
    }
    if (sessionKeys.length > 0) {
        await admin.from('web_events').delete().in('session_key', sessionKeys);
    }
});

describe.skipIf(!CONFIGURED)('web events against the local stack', () => {
    it('a sign-up carrying attribution gets its signup_attribution row', async () => {
        const anon = client(ANON_KEY);
        const { data, error } = await anon.auth.signUp({
            email: `web-events-${randomUUID()}@example.invalid`,
            password: PASSWORD,
            options: {
                data: {
                    age_gate: gate,
                    attribution: {
                        utm_campaign: 'launch_v1',
                        utm_content: 'hero_a',
                        utm_source: 'bad value!',
                        landing_path: '/try',
                        first_seen_at: new Date().toISOString(),
                    },
                },
            },
        });
        expect(error).toBeNull();
        created.push(data.user!.id);

        const row = await client(SERVICE_KEY)
            .from('signup_attribution')
            .select('utm_campaign, utm_content, utm_source, landing_path')
            .eq('user_id', data.user!.id)
            .single();
        expect(row.error).toBeNull();
        expect(row.data).toEqual({
            utm_campaign: 'launch_v1',
            utm_content: 'hero_a',
            utm_source: null,
            landing_path: '/try',
        });
    });

    it('a visitor with no session records an event with no user id', async () => {
        const e = event();
        const { error } = await client(ANON_KEY).rpc('record_web_events', { p_events: [e] });
        expect(error).toBeNull();
        expect(await rowsFor(e.session_key)).toEqual([{ user_id: null, event: 'demo_visit', utm_campaign: 'e2e_web' }]);
    });

    it('a signed-in teacher records an event under their own id', async () => {
        const { user, id } = await signedIn({});
        const e = event();
        const { error } = await user.rpc('record_web_events', { p_events: [e] });
        expect(error).toBeNull();
        expect(await rowsFor(e.session_key)).toEqual([{ user_id: id, event: 'demo_visit', utm_campaign: 'e2e_web' }]);
    });

    it('a roster student’s events are dropped', async () => {
        const { user } = await signedIn({ user_type: 'student' }, { ...gate, source: 'teacher' });
        const e = event();
        const { error } = await user.rpc('record_web_events', { p_events: [e] });
        expect(error).toBeNull();
        expect(await rowsFor(e.session_key)).toEqual([]);
    });

    it('a guest’s (anonymous sign-in) events are dropped', async () => {
        const guest = client(ANON_KEY);
        const { data, error } = await guest.auth.signInAnonymously({ options: { data: { age_gate: gate } } });
        expect(error).toBeNull();
        created.push(data.user!.id);
        const e = event();
        const sent = await guest.rpc('record_web_events', { p_events: [e] });
        expect(sent.error).toBeNull();
        expect(await rowsFor(e.session_key)).toEqual([]);
    });

    it('neither client role can read the tables directly', async () => {
        const anonRead = await client(ANON_KEY).from('web_events').select('id').limit(1);
        expect(anonRead.error?.code).toBe('42501');
        const { user } = await signedIn({});
        const userRead = await user.from('signup_attribution').select('user_id').limit(1);
        expect(userRead.error?.code).toBe('42501');
    });
});
