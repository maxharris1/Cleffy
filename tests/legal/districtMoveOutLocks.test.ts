// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Codex's REVISE on 20261022130300, fixed in 20261022130400: a student moved
 * out of a district is never listed by its purge (finding 1), and an admin's
 * correction takes the districts' locks in the run's order, billing rows
 * before roster rows (finding 2). The database proofs are
 * tests/sql/district_retention_moveout_race.sql (the move out against the
 * sweep, the hard delete's re-list and the soft delete, between real
 * sessions) and district_retention_admin_lock_order.sql (no deadlock between a
 * correction and a run). What CI holds here, without a database, is the shape:
 * every listing locks the roster rows before it lists, and only lists rows
 * still attributed under those locks; every correction locks both districts
 * before the roster row, or does not wait once it holds the row.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261022130400_district_retention_moveout_locks.sql');
const fn = (name: string): string =>
    migration.match(new RegExp(`function public\\.${name} [\\s\\S]*?\\$\\$;`))?.[0] ?? '';

/** Top-level statements, comments dropped, function and DO bodies blanked. */
const statements = (sql: string): string[] =>
    sql
        .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '$$$$')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean);

const LOCK_ROSTER = /order by ms\.id\s+for update of ms\s+\) l;/;

describe('a student moved out is never listed (finding 1)', () => {
    it('the re-list locks the unlisted students’ roster rows, then lists only those still attributed', () => {
        const late = fn('district_retention_list_late');
        const lock = late.search(LOCK_ROSTER);
        expect(lock).toBeGreaterThan(-1);
        const insert = late.indexOf('insert into public.district_retention_students');
        expect(insert).toBeGreaterThan(lock);
        expect(late.slice(insert)).toMatch(
            /from public\.retention_district_students \(p_studio\) ds\s+where ds\.id = any \(v_locked\)/,
        );
        // Archiving and signing out come after, for the rows listed.
        expect(late.indexOf('access_revoked_at = clock_timestamp()')).toBeGreaterThan(insert);
        expect(late.indexOf('delete from auth.sessions')).toBeGreaterThan(insert);
    });

    it('the soft delete’s own listing does the same', () => {
        const run = fn('retention_district_run');
        const soft = run.slice(
            run.indexOf("elsif v_step = 'soft_delete' then"),
            run.indexOf("elsif v_step = 'hard_delete'"),
        );
        const lock = soft.search(LOCK_ROSTER);
        expect(lock).toBeGreaterThan(-1);
        const insert = soft.indexOf('insert into public.district_retention_students');
        expect(insert).toBeGreaterThan(lock);
        expect(soft.slice(insert)).toMatch(/where ds\.id = any \(v_locked\)/);
    });

    it('keeps the run otherwise as 20261022130300 left it: the sweep and the hard delete’s re-list', () => {
        const run = fn('retention_district_run');
        expect(run).toContain("public.district_retention_list_late (candidate.studio_id, p_now, 'hard_delete')");
        expect(run).toContain("public.district_retention_list_late (candidate.studio_id, p_now, 'sweep')");
        expect(run).toMatch(/where r\.soft_deleted_at is not null and r\.hard_deleted_at is null/);
        expect(run).toMatch(/v_roster\.district_studio_id is distinct from candidate\.studio_id/);
    });
});

describe('corrections lock in the run’s order (finding 2)', () => {
    it('admin_set_student_district locks the district left and the one joined, in studio order, before the row', () => {
        const admin = fn('admin_set_student_district');
        const lock = admin.search(
            /where b\.studio_id in \(v_old, p_studio\)\s+order by b\.studio_id\s+for key share of b;/,
        );
        expect(lock).toBeGreaterThan(-1);
        expect(admin.indexOf('where ms.id = p_managed_student for update;')).toBeGreaterThan(lock);
        expect(admin).toMatch(/if v_now is distinct from v_old then[\s\S]*?using errcode = '40001'/);
        expect(admin).toMatch(
            /p_studio is distinct from v_old and public\.district_deletion_pending \(p_studio\) then\s+raise exception 'district_deletion_pending'/,
        );
    });

    it('the roster trigger takes both districts’ locks NOWAIT on a move, and refuses with 55P03 when a run holds one', () => {
        const trigger = fn('managed_students_district_attribution');
        const update = trigger.slice(trigger.indexOf('elsif new.district'));
        const lock = update.search(
            /where b\.studio_id in \(old\.district_studio_id, new\.district_studio_id\)\s+order by b\.studio_id\s+for key share of b nowait;/,
        );
        expect(lock).toBeGreaterThan(-1);
        expect(update).toMatch(
            /when lock_not_available then\s+raise exception 'district_busy'\s+using errcode = '55P03'/,
        );
        expect(update.indexOf('public.district_deletion_pending (new.district_studio_id)')).toBeGreaterThan(lock);
        // The insert path is 20261022130300's: the district's lock, waited for.
        const insert = trigger.slice(0, trigger.indexOf('elsif new.district'));
        expect(insert).toContain(
            'from public.district_billing b where b.studio_id = new.district_studio_id for key share;',
        );
        expect(insert).not.toMatch(/nowait/);
    });
});

describe('20261022130400 reruns and keeps the service role alone', () => {
    it('sorts right after 20261022130300', () => {
        const names = readdirSync(resolve(process.cwd(), 'supabase/migrations'))
            .filter((name) => name.startsWith('202610221'))
            .sort();
        expect(names.indexOf('20261022130400_district_retention_moveout_locks.sql')).toBe(
            names.indexOf('20261022130300_district_retention_late_students.sql') + 1,
        );
        // 20261022130200 stays dropped (decision 67(2)).
        expect(names.filter((name) => name.startsWith('20261022130200'))).toEqual([]);
    });

    it('only replaces functions: no table, trigger, policy or constraint, and no step', () => {
        for (const s of statements(migration).filter((x) => /^create\b/i.test(x))) {
            expect(s, s).toMatch(/^create or replace function /i);
        }
        for (const s of statements(migration)) {
            expect(s, s).not.toMatch(/\badd constraint\b|^create (table|trigger|policy|index)\b/i);
        }
        expect(migration).not.toMatch(/district_retention_log_step_check|step in \(/);
    });

    it('revokes every function from clients, grants the service role the callable ones, and none the re-list', () => {
        for (const name of [
            'public.managed_students_district_attribution ()',
            'public.admin_set_student_district (uuid, uuid, text)',
            'public.retention_district_run (timestamptz, int)',
        ]) {
            expect(migration).toContain(`'${name}'`);
        }
        expect(migration).toContain(
            "execute format('revoke all on function %s from public, anon, authenticated', fn);",
        );
        expect(migration).toContain("execute format('grant execute on function %s to service_role', fn);");
        expect(migration).toMatch(
            /revoke all on function public\.district_retention_list_late \(uuid, timestamptz, text\)\s+from public, anon, authenticated, service_role;/,
        );
    });
});
