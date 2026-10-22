import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The district migrations are rerunnable, whole (Codex round-3 review of #61:
 * not only the canonical district_billing block). tests/sql/district_migrations_rerunnable.sql
 * proves it against a database, applying every file twice on top of itself;
 * what CI holds here, without one, is that no statement in them would fail the
 * second time: every table, index and added column is IF NOT EXISTS, every
 * trigger and policy is dropped IF EXISTS just before it is created, and every
 * function is CREATE OR REPLACE.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const MIGRATIONS = [
    '20261020180400_district_seat_overrides.sql',
    '20261020180500_district_seat_cap_and_grace.sql',
    '20261020180600_read_only_seats_enforced.sql',
    '20261020180700_read_only_seats_storage.sql',
    '20261020180800_read_only_seats_live_ink.sql',
    '20261020180900_district_paying_status.sql',
    '20261020181000_district_contract_end_clamp.sql',
    '20261020181100_read_only_seats_grace_deadline.sql',
];

const read = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8');

/** Top-level statements, comments dropped, function bodies ($$ ... $$ and $tag$ ... $tag$) blanked. */
const statements = (sql: string): string[] =>
    sql
        .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$$$')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

describe.each(MIGRATIONS)('%s', (file) => {
    const sql = read(file);
    const stmts = statements(sql);

    it('creates every table and index only if it is missing', () => {
        for (const s of stmts.filter((x) => /^create (unique )?(table|index)\b/i.test(x))) {
            expect(s, s).toMatch(/^create (unique )?(table|index) if not exists /i);
        }
    });

    it('adds every column only if it is missing', () => {
        for (const s of stmts.filter((x) => /^alter table\b/i.test(x) && /\badd column\b/i.test(x))) {
            expect(s, s).toMatch(/\badd column if not exists /i);
        }
    });

    it('drops every trigger and policy just before creating it', () => {
        stmts.forEach((s, i) => {
            const trigger = /^create trigger (\w+) .*? on ([\w.]+) /i.exec(s);
            if (trigger) {
                expect(stmts[i - 1], s).toBe(`drop trigger if exists ${trigger[1]} on ${trigger[2]}`);
            }
            const policy = /^create policy (\w+) on ([\w.]+) /i.exec(s);
            if (policy) {
                expect(stmts[i - 1], s).toBe(`drop policy if exists ${policy[1]} on ${policy[2]}`);
            }
        });
    });

    it('replaces every function rather than creating it', () => {
        for (const s of stmts.filter((x) => /^create (or replace )?function\b/i.test(x))) {
            expect(s, s).toMatch(/^create or replace function /i);
        }
    });

    it('adds no constraint outside a guard that checks for it by name', () => {
        // The canonical district_billing block adds its two inside a DO block
        // that tests pg_constraint first; those bodies are blanked above.
        for (const s of stmts) {
            expect(s, s).not.toMatch(/\badd constraint\b/i);
        }
    });

    it('schedules its cron job by name, which pg_cron updates in place', () => {
        for (const s of stmts.filter((x) => /cron\.schedule/i.test(x))) {
            expect(s, s).toMatch(/cron\.schedule \('[\w-]+',/i);
        }
    });
});
