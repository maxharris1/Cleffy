// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STRIKE_WINDOW_MONTHS } from '@/features/moderation/moderationRules';

/**
 * Launch re-audit, SF-15 (20261022130100): copyright strikes survive account
 * deletion. tests/sql/content_strikes_survive_deletion.sql proves it against a
 * database; what CI holds here is the shape: the foreign key sets null, a
 * strike is keyed only when its account is deleted, from the address the
 * account has then (Codex round 1 on #66, major 1), with a versioned HMAC whose
 * pepper is read from Vault and fails closed (major 2), active_content_strikes()
 * counts a deleted account's strikes for whoever holds that address now, a
 * daily job purges them 12 months after the newest, the policies say so, and
 * the migration reruns.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261022130100_content_strikes_survive_deletion.sql');
const fn = (name: string): string =>
    migration.match(new RegExp(`function public\\.${name}[\\s\\S]*?\\$\\$;`))?.[0] ?? '';

/** Top-level statements, comments dropped, function and DO bodies blanked. */
const statements = (sql: string): string[] =>
    sql
        .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$$$')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

const window = `interval '${STRIKE_WINDOW_MONTHS} months'`;

describe('strikes survive account deletion (20261022130100)', () => {
    it('replaces the cascading foreign key with one that sets user_id null', () => {
        expect(migration).toMatch(/alter table public\.content_strikes\s+alter column user_id drop not null;/);
        expect(migration).toMatch(
            /add constraint content_strikes_user_id_fkey\s+foreign key \(user_id\) references auth\.users \(id\) on delete set null;/,
        );
        expect(migration).not.toMatch(/on delete cascade/);
    });

    it('keys with a versioned hmac-sha256 whose pepper is the Vault secret, never a plain digest', () => {
        const key = fn('content_strike_subject_key');
        expect(key).toContain("extensions.hmac(convert_to(lower(btrim(p_email)), 'UTF8'),");
        expect(key).toContain("convert_to(public.content_strike_pepper (p_version), 'UTF8'), 'sha256')");
        expect(migration).not.toMatch(/\bsha256\(convert_to/);
        expect(migration).toContain('add column if not exists subject_key_version smallint;');
        const pepper = fn('content_strike_pepper');
        expect(pepper).toContain("where s.name = 'content_strike_pepper'");
        expect(pepper).toContain("using errcode = '55000'");
        // Fails closed without echoing anything secret.
        expect(pepper).not.toMatch(/raise (notice|warning|log)|%'[^;]*v_pepper/);
    });

    it('keys a strike when its account is deleted, from that row’s address, not at insert', () => {
        expect(migration).toMatch(
            /create trigger content_strikes_key_on_account_delete before delete on auth\.users\s+for each row/,
        );
        const onDelete = fn('content_strikes_key_on_account_delete');
        expect(onDelete).toContain('security definer');
        expect(onDelete).toContain('public.content_strike_subject_key (old.email, 1::smallint)');
        expect(onDelete).toContain(`s.voided_at is null and s.created_at > now() - ${window}`);
        const onInsert = fn('content_strikes_set_subject_key');
        expect(onInsert).toContain('new.subject_key := null;');
        expect(onInsert).toContain('new.subject_key_version := null;');
        expect(migration).not.toMatch(
            /update public\.content_strikes s\s+set subject_key = public\.content_strike_subject_key \(u\.email/,
        );
    });

    it('counts a deleted account’s strikes for the address, over the policy’s window', () => {
        const count = fn('active_content_strikes');
        expect(count).toContain('where s.user_id = p_user and s.voided_at is null');
        expect(count).toContain('v_key := public.content_strike_subject_key (v_email, v_version);');
        expect(count).toContain('s.subject_key = v_key and s.subject_key_version = v_version');
        expect(count.split(window).length - 1).toBe(3);
    });

    it('purges a deleted account’s strikes 12 months after the newest, daily', () => {
        const purge = fn('retention_purge_content_strikes');
        expect(purge).toContain(`p_older_than interval default ${window}`);
        expect(purge).toContain('n.created_at >= now() - p_older_than');
        expect(purge).toContain('where s.user_id is null');
        expect(purge).not.toMatch(/content_takedowns/);
        expect(migration).toContain(
            "select cron.schedule ('retention-content-strikes', '7 4 * * *', $$select public.retention_purge_content_strikes ()$$);",
        );
        expect(migration).toContain(
            "perform cron.unschedule (jobid) from cron.job where jobname = 'retention-content-strikes';",
        );
    });

    it('carries the DEPLOY note for the pepper, and the local seed sets a non-secret one', () => {
        expect(migration).toMatch(
            /-- DEPLOY: set the Vault secret `content_strike_pepper` on production before\s+-- go-live/,
        );
        const seed = read('supabase/seed.sql');
        expect(seed).toMatch(
            /vault\.create_secret \(\s+'cleffy-local-dev-content-strike-pepper-not-a-secret',\s+'content_strike_pepper',/,
        );
    });

    it('is disclosed in the privacy and copyright policies', () => {
        const privacy = read('src/features/legal/privacyPolicy.ts');
        expect(privacy).toContain('a keyed hash of your email address (not the address itself) for up to 12 months');
        const copyright = read('src/features/legal/copyrightPolicy.ts');
        expect(copyright).toContain(
            'a keyed hash of the account’s email address for up to ${STRIKE_WINDOW_MONTHS} months',
        );
    });

    it('leaves the takedown’s uploader_id as it is (already ON DELETE SET NULL)', () => {
        expect(migration).not.toMatch(/content_takedowns_uploader_id_fkey|alter table public\.content_takedowns/);
    });

    it('reruns: columns and indexes if missing, triggers dropped first, the foreign key in a guard', () => {
        const stmts = statements(migration);
        stmts.forEach((s, i) => {
            if (/^create (unique )?(table|index)\b/i.test(s)) expect(s, s).toMatch(/ if not exists /i);
            if (/\badd column\b/i.test(s)) expect(s, s).toMatch(/\badd column if not exists /i);
            if (/^create (or replace )?function\b/i.test(s)) expect(s, s).toMatch(/^create or replace function /i);
            expect(s, s).not.toMatch(/\badd constraint\b/i);
            const trigger = /^create trigger (\w+) .*? on ([\w.]+) /i.exec(s);
            if (trigger) expect(stmts[i - 1], s).toBe(`drop trigger if exists ${trigger[1]} on ${trigger[2]}`);
        });
        expect(migration).toMatch(/conname = 'content_strikes_user_id_fkey'\s+and confdeltype = 'n'/);
    });

    it('grants no table privilege (launchfix P1 grants content_strikes); the key and pepper are no role’s', () => {
        expect(migration).not.toMatch(/grant [\w, ]+ on table/i);
        expect(migration).toContain(
            'revoke all on function public.active_content_strikes (uuid) from public, anon, authenticated;',
        );
        expect(migration).toContain('grant execute on function public.active_content_strikes (uuid) to service_role;');
        expect(migration).toContain(
            'revoke all on function public.content_strike_pepper (smallint) from public, anon, authenticated, service_role;',
        );
        expect(migration).toContain(
            'revoke all on function public.content_strike_subject_key (text, smallint) from public, anon, authenticated, service_role;',
        );
        expect(migration).toContain(
            'revoke all on function public.content_strikes_key_on_account_delete () from public, anon, authenticated;',
        );
    });
});
