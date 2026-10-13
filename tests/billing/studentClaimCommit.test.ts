import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * The one statement that spends a login code.
 *
 * student-claim is the branch's only unauthenticated session-minting endpoint,
 * and studentCodes.ts opens by promising the code "selects the roster row in
 * student-claim exactly once". The spending half of that promise lives in a
 * single UPDATE, which vitest cannot drive: index.ts imports supabase-js by its
 * Deno `npm:` specifier and calls Deno.serve at load. So this guards the shape of
 * that statement instead, the way limitsInSync.test.ts guards tier_limits() —
 * and pins, against the real client, the reason the shape matters.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const SOURCE = readFileSync(resolve(process.cwd(), 'supabase/functions/student-claim/index.ts'), 'utf8');

/** From the commit's own comment to the throttle clear that follows it. */
const commitStatement = (): string => {
    const start = SOURCE.indexOf('// The commit:');
    const end = SOURCE.indexOf('// The card is spent');
    expect(start, 'the commit UPDATE was not found — was its comment reworded?').toBeGreaterThan(-1);
    expect(end, 'the post-commit throttle clear was not found — was its comment reworded?').toBeGreaterThan(start);
    return SOURCE.slice(start, end);
};

/**
 * PostgREST, in the only two answers this statement can get: 204 and no body
 * when an UPDATE asks for nothing back, 200 and a list when it does.
 */
const fakePostgrest = (matched: unknown[]) =>
    createClient('https://example.supabase.co', 'anon', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
            fetch: async (input: RequestInfo | URL) =>
                String(input).includes('select=')
                    ? new Response(JSON.stringify(matched), {
                          status: 200,
                          headers: { 'Content-Type': 'application/json' },
                      })
                    : new Response(null, { status: 204 }),
        },
    });

describe('the student-claim commit', () => {
    it('asks the UPDATE which row it actually changed', () => {
        const commit = commitStatement();

        // Without these two lines the filters below are decoration: a request
        // that matched no row is handed a session for an account it did not
        // claim, under a username the roster never stored.
        expect(commit).toContain(".select('id')");
        expect(commit).toMatch(/if \(claimError \|\| !claimed\) \{/);
        expect(commit).toMatch(/return reject\(\);/);
    });

    it('commits under the same conditions the lookup selected on', () => {
        const commit = commitStatement();

        // A row claimed or archived between the lookup and here is not one this
        // request may still write to, and the WHERE clause is the only thing that
        // knows that — the CHECK constraint only speaks about rows that move.
        expect(commit).toContain(".is('claimed_at', null)");
        expect(commit).toContain(".is('archived_at', null)");
    });

    it('signs the student in before it spends the code, and drops the session if the commit does not land', () => {
        // The order is the fix for a captcha refusal costing a child their card
        // (QA round 4 review of #57): GoTrue verifies the Turnstile token at
        // the password grant, so a grant that runs AFTER the commit judges the
        // token when the code is already spent — the account exists, the card
        // is dead, and the student is told to go and sign in instead. Before
        // the commit, every way the grant can fail leaves the row Invited and
        // the code live.
        const grant = SOURCE.indexOf('signInWithPassword(');
        const spend = SOURCE.indexOf('login_code_hash: null');
        expect(grant, 'the password grant was not found').toBeGreaterThan(-1);
        expect(spend, 'the statement that spends the code was not found').toBeGreaterThan(-1);
        expect(grant).toBeLessThan(spend);
        // And the session minted a moment earlier must not be handed out when
        // the commit found no row to write: that row is somebody else's claim.
        const commit = commitStatement();
        expect(commit).toContain('signOutQuietly(admin, signIn.session.access_token)');
        expect(commit).toMatch(/code: 'username_taken'/);
    });

    it('revokes only the session it minted, never every session of that student', () => {
        // QA round 4 review of #57. Two children typing the same card at once
        // both get past the lookup, both mint a session for the SAME auth user,
        // and exactly one commits. The loser reaches signOutQuietly -- and a
        // 'global' scope there revokes every session of that user, the winner's
        // included, with the card already spent and no retry left that fixes it.
        const quietly = SOURCE.slice(SOURCE.indexOf('const signOutQuietly'), SOURCE.indexOf('Deno.serve('));
        expect(quietly, 'signOutQuietly was not found').not.toBe('');
        expect(quietly).toContain("admin.auth.admin.signOut(accessToken, 'local')");
        // 'others' is the same bug with the arguments the other way round: it
        // revokes everything EXCEPT the token we are trying to drop.
        expect(SOURCE).not.toMatch(/signOut\(accessToken, '(?:global|others)'\)/);
    });

    it('scopes the sign-out on the wire, so local and global are different requests', async () => {
        // The mechanism the test above exists for, against the real client:
        // supabase-js puts the scope in the query string of /auth/v1/logout, so
        // what GoTrue deletes is decided by that one word. 'local' deletes the
        // session the presented JWT belongs to; 'global' deletes all of the
        // user's.
        const scopeOf = async (scope: 'local' | 'global') => {
            let seen = '';
            const admin = createClient('https://example.supabase.co', 'service-role', {
                auth: { persistSession: false, autoRefreshToken: false },
                global: {
                    fetch: async (input: RequestInfo | URL) => {
                        seen = String(input);
                        return new Response(null, { status: 204 });
                    },
                },
            });
            await admin.auth.admin.signOut('the-losers-access-token', scope);
            return seen;
        };

        expect(await scopeOf('local')).toContain('/auth/v1/logout?scope=local');
        expect(await scopeOf('global')).toContain('/auth/v1/logout?scope=global');
    });

    it('cannot tell a lost race from a won one without asking for the row', async () => {
        // The mechanism the two cases above exist for, against the real client.
        // supabase-js sends Prefer: return=minimal unless .select() is chained, so
        // PostgREST answers 204 whether the UPDATE moved one row or none, and
        // `error` is null either way. Both of these read as success:
        const blind = (rows: unknown[]) =>
            fakePostgrest(rows).from('managed_students').update({ claimed_at: 'now' }).eq('id', 'row-1');
        expect(await blind([{ id: 'row-1' }])).toMatchObject({ data: null, error: null });
        expect(await blind([])).toMatchObject({ data: null, error: null });

        // Asking for the row back is what separates them.
        const asking = (rows: unknown[]) =>
            fakePostgrest(rows)
                .from('managed_students')
                .update({ claimed_at: 'now' })
                .eq('id', 'row-1')
                .select('id')
                .maybeSingle();
        expect((await asking([{ id: 'row-1' }])).data).toEqual({ id: 'row-1' });
        expect((await asking([])).data).toBeNull();
    });
});
