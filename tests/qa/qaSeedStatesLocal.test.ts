import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * The QA seeded states (docs/qa-lane.md, "Seeded states") signed in with
 * GoTrue's password grant, the call LoginPage makes, then read back as that
 * user under RLS. tests/sql/qa_seed_states.sql proves the rows and the reseed; this proves
 * GoTrue accepts each account and the app sees the state the doc names.
 *
 * Needs a seeded local stack; CI's supabase-local job runs it with
 * CLEFFY_REQUIRE_LOCAL_DB=1.
 *
 *     eval "$(npx supabase status -o env | grep -E '^(API_URL|ANON_KEY)=')"
 *     CLEFFY_LOCAL_SUPABASE_URL="$API_URL" CLEFFY_LOCAL_ANON_KEY="$ANON_KEY" \
 *         npx vitest run tests/qa/qaSeedStatesLocal.test.ts
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const ANON_KEY = process.env.CLEFFY_LOCAL_ANON_KEY ?? '';
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';
const CONFIGURED = Boolean(URL && ANON_KEY);

if (REQUIRED && !CONFIGURED) {
    throw new Error('CLEFFY_REQUIRE_LOCAL_DB=1 but the local Supabase URL or anon key is missing');
}

const PASSWORD = 'cleffy-local-test';

const STATES = [
    { email: 'qa-new@cleffy.test', tier: 'free', source: 'none', scores: [] },
    { email: 'qa-one-score@cleffy.test', tier: 'free', source: 'none', scores: ['Satie — Gymnopédie No. 1 (seed)'] },
    { email: 'qa-subscribed@cleffy.test', tier: 'personal', source: 'subscription', scores: [] },
    { email: 'qa-lapsed@cleffy.test', tier: 'free', source: 'none', scores: [] },
] as const;

const client = (): SupabaseClient =>
    createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

describe.skipIf(!CONFIGURED)('QA seeded states sign in', () => {
    it.each(STATES)('$email lands on $tier with its scores', async (state) => {
        const user = client();
        const { data: auth, error: authError } = await user.auth.signInWithPassword({
            email: state.email,
            password: PASSWORD,
        });
        expect(authError).toBeNull();
        expect(auth.user?.email).toBe(state.email);

        const { data: ent, error: entError } = await user.rpc('get_entitlements');
        expect(entError).toBeNull();
        expect(ent).toMatchObject({ tier: state.tier, source: state.source });

        const { data: docs, error: docsError } = await user
            .from('documents')
            .select('title, page_count, archived_at')
            .eq('owner_id', auth.user!.id);
        expect(docsError).toBeNull();
        expect((docs ?? []).map((d) => d.title)).toEqual(state.scores);
        for (const doc of docs ?? []) {
            expect(doc.page_count).toBeGreaterThan(0);
            expect(doc.archived_at).toBeNull();
        }
    });
});
