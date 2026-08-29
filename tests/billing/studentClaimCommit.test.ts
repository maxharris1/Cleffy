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

/** From the commit's own comment to the sign-in that follows it. */
const commitStatement = (): string => {
    const start = SOURCE.indexOf('// The commit:');
    const end = SOURCE.indexOf('// A FRESH anon-key client');
    expect(start, 'the commit UPDATE was not found — was its comment reworded?').toBeGreaterThan(-1);
    expect(end, 'the anon sign-in was not found — was its comment reworded?').toBeGreaterThan(start);
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
        expect(commit).toMatch(/if \(!claimed\) \{/);
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
