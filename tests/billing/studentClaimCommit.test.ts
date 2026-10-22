import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * The one statement that spends a login code.
 *
 * student-claim is the branch's only unauthenticated session-minting endpoint,
 * and studentCodes.ts opens by promising the code "selects the roster row in
 * student-claim exactly once". The spending half of that promise is
 * complete_student_claim (20261022110000_student_claim_reservation.sql), called
 * from index.ts, which vitest cannot load: it imports supabase-js by its Deno
 * `npm:` specifier and calls Deno.serve at load. The control flow around it is
 * in handler.ts and driven by tests/security/studentClaim.test.ts; this guards
 * the wiring the handler cannot see, and pins, against the real client, why
 * the sign-out scope matters.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const SOURCE = readFileSync(resolve(process.cwd(), 'supabase/functions/student-claim/index.ts'), 'utf8');
const HANDLER = readFileSync(resolve(process.cwd(), 'supabase/functions/student-claim/handler.ts'), 'utf8');
const MIGRATION = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261022110000_student_claim_reservation.sql'),
    'utf8',
);

describe('the student-claim commit', () => {
    it('commits through complete_student_claim, which requires the hash and the reservation', () => {
        expect(SOURCE).toContain("admin.rpc('complete_student_claim'");
        expect(SOURCE).toContain("admin.rpc('reserve_student_claim'");
        // The commit's own WHERE: the hash the claim reserved, not archived, not
        // yet claimed -- and the reservation still this request's.
        const complete = MIGRATION.slice(
            MIGRATION.indexOf('create or replace function public.complete_student_claim'),
            MIGRATION.indexOf('create or replace function public.release_student_claim'),
        );
        expect(complete).toMatch(/reservation = p_reservation and kind = 'claim' and login_code_hash = p_code_hash/);
        expect(complete).toMatch(
            /where id = p_student and login_code_hash = p_code_hash and archived_at is null and claimed_at is null/,
        );
        // The handler never writes to managed_students itself any more.
        expect(SOURCE).not.toContain("from('managed_students')\n        .update");
        expect(SOURCE).not.toMatch(/\.update\(\{\s*username/);
    });

    it('signs the student in before it spends the code, and reserves before it writes a password', () => {
        const reserve = HANDLER.indexOf('backend.reserveClaim(');
        const password = HANDLER.indexOf('backend.setPassword(');
        const grant = HANDLER.indexOf('backend.signIn(');
        const spend = HANDLER.indexOf('backend.completeClaim(');
        expect(reserve).toBeGreaterThan(-1);
        expect(reserve).toBeLessThan(password);
        expect(password).toBeLessThan(grant);
        expect(grant).toBeLessThan(spend);
    });

    it('revokes only the session it minted, never every session of that student', () => {
        // QA round 4 review of #57: a 'global' scope revokes every session of
        // that user, a concurrent winner's included. 'others' is the same bug
        // with the arguments the other way round.
        expect(SOURCE).toContain("admin.auth.admin.signOut(accessToken, 'local')");
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
});
