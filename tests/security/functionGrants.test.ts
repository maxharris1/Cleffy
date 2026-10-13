// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Two function grants the Supabase security advisor flags as low priority, and
 * why neither should be changed — recorded as tests so the question is settled
 * in the tree rather than re-asked by the next hardening pass.
 *
 * The advisor's heuristic is "a SECURITY DEFINER function that looks internal
 * should not be callable by anon or authenticated", and it is a good heuristic.
 * It is wrong about both of these, for different reasons, and in one case
 * acting on it would be an outage rather than a tightening. The reasoning lives
 * next to the assertions because an assertion alone would just read as an
 * arbitrary rule to someone who inherits it.
 *
 * Parsed out of the migration SQL, the technique tests/billing/limitsInSync.ts
 * uses — and resolved as "the migration that most recently defines this
 * function", not a fixed filename, because create-or-replace means the last
 * definition in timestamp order is the one the database is running. These are
 * drift guards over the committed SQL; they do not connect to a database.
 * What was separately confirmed by hand against the live `dev` branch project
 * (read-only, via the Management API) is recorded in each case below.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

/** The newest migration whose SQL defines `name`, by timestamp order. */
const latestDefining = (name: string): string => {
    const defining = readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .filter((file) =>
            new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i').test(
                readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'),
            ),
        );
    const latest = defining.at(-1);
    if (!latest) {
        throw new Error(`no migration defines public.${name}()`);
    }
    return readFileSync(resolve(MIGRATIONS_DIR, latest), 'utf8');
};

describe('document_storage_cleanup_pending keeps its grant to authenticated', () => {
    const sql = latestDefining('document_storage_cleanup_pending');

    it('is granted EXECUTE to authenticated, and that grant is load-bearing', () => {
        // DO NOT REVOKE THIS. The advisor reads the function as internal
        // because only the cleanup path calls it by name. It is not internal:
        // it is called from inside four RLS policies on storage.objects, and
        // PostgreSQL evaluates a policy expression AS THE QUERYING ROLE. A
        // role without EXECUTE therefore does not merely lose the cleanup
        // path: any query whose rows have to be checked against one of those
        // policies aborts with `permission denied for function
        // document_storage_cleanup_pending`. That is ordinary authenticated
        // traffic against the scores and thumbnails buckets — opening a
        // score, listing a library, fetching a thumbnail — not an edge case.
        //
        // What was confirmed directly, on the live dev branch project
        // (qdbnlrgylelelvwbkvnm, read-only via the Management API): the grant
        // to authenticated is in place, anon has none, and four
        // `{authenticated}` SELECT/DELETE policies on storage.objects carry
        // this function in their USING expression. Production does not have
        // this migration applied at all, so the advisory was read off the
        // branch project. The failure mode above follows from PostgreSQL's
        // documented rule that policy expressions run with the querying
        // role's privileges; it was NOT reproduced here, because doing so
        // means revoking a grant on a live project.
        expect(sql).toMatch(
            /grant\s+execute\s+on\s+function\s+public\.document_storage_cleanup_pending\s*\(\s*text\s*\)\s+to\s+authenticated\s*;/i,
        );
    });

    it('is the function four to-authenticated storage policies are built on', () => {
        // The thing that makes the grant load-bearing, asserted rather than
        // asserted-about: if a future migration stops calling it from these
        // policies, revoking becomes safe and this test should be revisited
        // on purpose instead of the grant being removed by guesswork.
        const policies = [
            'scores_cleanup_read',
            'scores_cleanup_delete',
            'thumbnails_cleanup_read',
            'thumbnails_cleanup_delete',
        ];
        for (const policy of policies) {
            const definition = new RegExp(
                `create\\s+policy\\s+${policy}\\s+on\\s+storage\\.objects\\s+for\\s+\\w+\\s+to\\s+authenticated[\\s\\S]*?document_storage_cleanup_pending`,
                'i',
            );
            expect(sql, policy).toMatch(definition);
        }
        // Four call sites, one per policy, plus the definition itself.
        expect(sql.match(/document_storage_cleanup_pending/g)?.length).toBeGreaterThanOrEqual(policies.length + 1);
    });

    it('is still withheld from anon and from PUBLIC, which is the part worth keeping tight', () => {
        // The advisor's instinct applied where it is right: nothing anonymous
        // has a cleanup folder, so nothing anonymous needs to ask.
        expect(sql).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.document_storage_cleanup_pending\s*\(\s*text\s*\)\s+from\s+anon\s*;/i,
        );
        expect(sql).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.document_storage_cleanup_pending\s*\(\s*text\s*\)\s+from\s+public\s*;/i,
        );
        expect(sql).not.toMatch(
            /grant\s+execute\s+on\s+function\s+public\.document_storage_cleanup_pending\s*\([^)]*\)\s+to\s+(anon|public)\s*;/i,
        );
    });

    it('stays SECURITY DEFINER, which is the other half of why it is safe', () => {
        // It has to outrank RLS on public.documents to confirm the score is
        // really gone — a document id is chosen client-side, so if someone has
        // since created a new score under the same id, that folder is theirs
        // and the former owner's tombstone must not reach it. The function
        // takes only a folder name and answers only yes/no about the CALLER's
        // own tombstone (`owner_id = auth.uid()`), so definer rights leak
        // nothing: it cannot be pointed at anybody else's folder.
        const definition = /create\s+or\s+replace\s+function\s+public\.document_storage_cleanup_pending[\s\S]*?\$\$;/i;
        const body = sql.match(definition)?.[0] ?? '';
        expect(body).toMatch(/security\s+definer/i);
        expect(body).toMatch(/auth\.uid\s*\(\s*\)/);
    });
});

describe('peek_share_link is meant to be callable by anon', () => {
    const sql = latestDefining('peek_share_link');

    it('is granted to anon on purpose: its whole job is to answer before a session exists', () => {
        // Intended and safe, and the grant should stay. The join page asks
        // this BEFORE signing a guest in, which is the only reason a dead
        // share link does not leave an orphaned anonymous auth user behind for
        // every failed join (JoinPage.tsx). A caller with no session is the
        // normal case, so anon is not an oversight — it is the requirement.
        //
        // Confirmed on the live dev branch project (read-only): anon and
        // authenticated both hold EXECUTE, PUBLIC does not.
        expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.peek_share_link\s*\(\s*text\s*\)\s+to\s+anon\s*;/i);
        expect(sql).toMatch(
            /grant\s+execute\s+on\s+function\s+public\.peek_share_link\s*\(\s*text\s*\)\s+to\s+authenticated\s*;/i,
        );
        // Revoked from PUBLIC first so the grant list is exactly the two API
        // roles rather than "everyone, plus two redundant grants".
        expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.peek_share_link\s*\(\s*text\s*\)\s+from\s+public\s*;/i);
    });

    it('answers only whether a link works and at what role — never which document', () => {
        // This is what makes the anon grant safe, and it is the thing to
        // protect: the signature leaks no document identity, no title, no
        // owner, no member list. Someone holding a share token learns only
        // what redeeming it would tell them anyway, one step earlier; someone
        // guessing tokens learns "no" and nothing else.
        //
        // If a future edit adds a column here, the anon grant has to be
        // reconsidered at the same time — which is exactly why the signature
        // is pinned rather than merely described.
        expect(sql).toMatch(
            /create\s+or\s+replace\s+function\s+public\.peek_share_link\s*\(\s*p_token\s+text\s*\)\s+returns\s+table\s*\(\s*valid\s+boolean\s*,\s*role\s+text\s*\)/i,
        );
    });

    it('cannot be turned into a token-length oracle or a wildcard match', () => {
        // The body matches an exact token, bounded in length, and only a link
        // that is unrevoked and unexpired. No LIKE, no prefix match: a partial
        // token is simply not a link.
        const body = sql.match(/create\s+or\s+replace\s+function\s+public\.peek_share_link[\s\S]*?\$\$;/i)?.[0] ?? '';
        expect(body).toMatch(/l\.token\s*=\s*p_token/i);
        expect(body).toMatch(/length\s*\(\s*p_token\s*\)\s+between/i);
        expect(body).toMatch(/revoked_at\s+is\s+null/i);
        expect(body).toMatch(/expires_at\s+is\s+null\s+or\s+l\.expires_at\s*>\s*now\s*\(\s*\)/i);
        expect(body).not.toMatch(/\blike\b|\bilike\b|~\*/i);
    });

    it('is the one share-link function anon may call — redeem is not', () => {
        // The boundary that makes the grant above a narrow exception rather
        // than a policy. Redeeming writes a membership and needs an identity
        // to write it for, so it is authenticated-only; peeking writes
        // nothing.
        const redeem = latestDefining('redeem_share_link');
        expect(redeem).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.redeem_share_link\s*\(\s*text\s*\)\s+from\s+anon\s*;/i,
        );
        expect(redeem).not.toMatch(
            /grant\s+execute\s+on\s+function\s+public\.redeem_share_link\s*\([^)]*\)\s+to\s+anon\s*;/i,
        );
    });

    it('is documented client-side as working without a session, so the grant is not a mystery', () => {
        // Keeps the two ends of the decision findable from each other: the
        // next person to wonder why anon can call this finds the answer in
        // whichever file they happen to open.
        const service = readFileSync(resolve(process.cwd(), 'src/features/share/shareService.ts'), 'utf8');
        expect(service).toMatch(/no session at all/i);
    });
});
