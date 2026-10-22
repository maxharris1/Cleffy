import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every public table a migration creates names service_role in a grant of its
 * own (launch re-audit BL-3).
 *
 * Fifteen tables used to rely on the default ACL for objects `postgres` creates
 * in `public`, which today happens to give service_role everything. Supabase
 * has announced a change to default grants for new tables; on a project built
 * after it, a fresh replay would leave the service role with 42501 on those
 * tables, and the Edge Functions that write them directly would fail.
 * 20261022100000_explicit_service_role_grants.sql grants the fifteen, and
 * tests/sql/explicit_grants.sql proves it against a database with the default
 * ACL revoked. This holds every table added later to the same rule, which a
 * database built with the permissive default can never show.
 *
 * Resolved from the project root, like tests/migrationRecoverability.test.ts.
 */
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

/** `--` comments go, string literals survive (same reader as migrationRecoverability). */
const statements = (sql: string): string =>
    sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, (match) => (match.startsWith("'") ? match : ''));

const migrations = (): { name: string; sql: string }[] =>
    readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql') && !/imslp_works_catalog/.test(name))
        .sort()
        .map((name) => ({ name, sql: statements(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')) }));

describe('explicit service_role grants', () => {
    it('cover every public table a migration creates', () => {
        const created = new Map<string, string>();
        const dropped = new Set<string>();
        const granted = new Set<string>();
        for (const { name, sql } of migrations()) {
            for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)) {
                const table = match[1] ?? '';
                if (!created.has(table)) {
                    created.set(table, name);
                }
                dropped.delete(table);
            }
            for (const match of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?public\.([a-z0-9_]+)/gi)) {
                dropped.add(match[1] ?? '');
            }
            // `grant <privileges> on [table] public.a, public.b to <roles>;`
            for (const match of sql.matchAll(/grant\s+[^;]*?\s+on\s+(?:table\s+)?([^;]*?)\s+to\s+([^;]*);/gi)) {
                if (!/\bservice_role\b/i.test(match[2] ?? '')) {
                    continue;
                }
                for (const table of (match[1] ?? '').matchAll(/public\.([a-z0-9_]+)/gi)) {
                    granted.add(table[1] ?? '');
                }
            }
        }
        const missing = [...created]
            .filter(([table]) => !dropped.has(table) && !granted.has(table))
            .map(([table, name]) => `${table} (created in ${name})`);
        expect(missing).toEqual([]);
    });

    it('include the fifteen BL-3 tables in 20261022100000', () => {
        const sql = migrations().find(({ name }) => name === '20261022100000_explicit_service_role_grants.sql')?.sql;
        for (const table of [
            'billing_customers',
            'studios',
            'studio_members',
            'usage_counters',
            'assignments',
            'practice_notes',
            'edge_rate_buckets',
            'pdf_export_claims',
            'content_moderators',
            'content_reports',
            'content_takedowns',
            'content_strikes',
            'content_notice_log',
            'content_notice_outbox',
            'document_realtime_epochs',
        ]) {
            expect(sql, table).toMatch(new RegExp(`public\\.${table}\\b`));
        }
        // It grants the service role and nothing else: anon and authenticated
        // stay exactly as they were.
        expect(sql).not.toMatch(/\b(anon|authenticated)\b/i);
    });
});
