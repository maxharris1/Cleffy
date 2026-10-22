// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STRIKE_WINDOW_MONTHS } from '@/features/moderation/moderationRules';

/**
 * Launch re-audit, SF-15 (20261022130100): copyright strikes survive account
 * deletion. tests/sql/content_strikes_survive_deletion.sql proves it against a
 * database; what CI holds here is the shape: the foreign key sets null, each
 * strike keys its uploader's address digest, active_content_strikes() counts a
 * deleted account's strikes for whoever holds that address now, and the
 * migration reruns.
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

describe('strikes survive account deletion (20261022130100)', () => {
    it('replaces the cascading foreign key with one that sets user_id null', () => {
        expect(migration).toMatch(/alter table public\.content_strikes\s+alter column user_id drop not null;/);
        expect(migration).toMatch(
            /add constraint content_strikes_user_id_fkey\s+foreign key \(user_id\) references auth\.users \(id\) on delete set null;/,
        );
        expect(migration).not.toMatch(/on delete cascade/);
    });

    it('keys each strike by sha256(lower(email)), set on insert only, and backfills existing strikes', () => {
        expect(fn('content_strike_subject_key')).toContain("encode(sha256(convert_to(lower(p_email), 'UTF8')), 'hex')");
        expect(migration).toMatch(
            /create trigger content_strikes_set_subject_key before insert on public\.content_strikes\s/,
        );
        expect(fn('content_strikes_set_subject_key')).toContain('security definer');
        expect(migration).toMatch(/update public\.content_strikes s\s+set subject_key = /);
    });

    it('counts a deleted account’s strikes for the address, over the policy’s window', () => {
        const count = fn('active_content_strikes');
        expect(count).toContain('s.user_id = p_user');
        expect(count).toMatch(/s\.user_id is null and s\.subject_key is not null\s+and s\.subject_key = /);
        expect(count).toContain('s.voided_at is null');
        expect(count).toContain(`interval '${STRIKE_WINDOW_MONTHS} months'`);
    });

    it('leaves the takedown’s uploader_id as it is (already ON DELETE SET NULL)', () => {
        expect(migration).not.toMatch(/content_takedowns_uploader_id_fkey|alter table public\.content_takedowns/);
    });

    it('reruns: columns and indexes if missing, the trigger dropped first, the foreign key in a guard', () => {
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

    it('grants no table privilege (launchfix P1 grants content_strikes) and keeps the count the service role’s', () => {
        expect(migration).not.toMatch(/grant [\w, ]+ on table/i);
        expect(migration).toContain(
            'revoke all on function public.active_content_strikes (uuid) from public, anon, authenticated;',
        );
        expect(migration).toContain('grant execute on function public.active_content_strikes (uuid) to service_role;');
        expect(migration).toContain(
            'revoke all on function public.content_strikes_set_subject_key () from public, anon, authenticated;',
        );
    });
});
