// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Launch re-audit, Codex A4 (20261022130000): a student re-attributed after the
 * district soft delete is not hard deleted under the district they left.
 * tests/sql/district_retention_reattribution.sql proves it against a database;
 * what CI holds here, without one, is the shape: the hard delete re-checks the
 * roster row's district and account under its lock, the admin correction drops
 * the student from other districts' purge lists, both log 'skipped_reattributed',
 * and the migration reruns.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261022130000_district_retention_reattribution.sql');
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

describe('the hard delete re-checks attribution (20261022130000)', () => {
    const run = fn('retention_district_run');
    const hard = run.slice(run.indexOf("elsif v_step = 'hard_delete' then"));

    it('locks the roster row, then requires the purged district and the listed account', () => {
        const lock = hard.indexOf('for update of m;');
        expect(lock).toBeGreaterThan(-1);
        const check = hard.indexOf('v_roster.district_studio_id is distinct from candidate.studio_id');
        expect(check).toBeGreaterThan(lock);
        expect(hard).toContain('or v_roster.student_user_id is distinct from v_student.student_user_id then');
        // The skip comes before any scrub or delete.
        expect(hard.indexOf('perform public.scrub_student_markings')).toBeGreaterThan(check);
        expect(hard.indexOf('delete from auth.users')).toBeGreaterThan(check);
    });

    it('keeps the archived and still-a-student re-check', () => {
        expect(hard).toMatch(/v_roster\.archived_at is not null and exists \(/);
        expect(hard).toContain("u.raw_app_meta_data ->> 'user_type' = 'student'");
    });

    it('takes a skipped student off the list and logs the skip with its counts', () => {
        expect(hard).toMatch(
            /delete from public\.district_retention_students\s+where studio_id = candidate\.studio_id and managed_student_id = v_student\.managed_student_id;/,
        );
        expect(hard).toMatch(
            /insert into public\.district_retention_log[^;]*'skipped_reattributed'[^;]*'students_skipped'/,
        );
    });

    it('leaves the hard delete’s own log counts as they were', () => {
        expect(hard).toContain(
            "jsonb_build_object('students_deleted', v_n, 'members_removed', v_members, 'studios', 1)",
        );
    });

    it('is 20261021120700’s run otherwise: same signature, same lock on the billing record', () => {
        expect(migration).toContain(
            'create or replace function public.retention_district_run (p_now timestamptz default now(), p_batch int default 20)',
        );
        expect(run).toContain('for update skip locked');
        expect(run.indexOf('v_step := public.retention_district_next_step')).toBeGreaterThan(
            run.indexOf('for update skip locked'),
        );
    });
});

describe('the admin correction drops other districts’ purge entries (20261022130000)', () => {
    const admin = fn('admin_set_student_district');

    it('deletes every list entry but the named district’s, after the row lock, and logs each', () => {
        const lock = admin.indexOf('for update;');
        const drop = admin.indexOf('delete from public.district_retention_students s');
        expect(lock).toBeGreaterThan(-1);
        expect(drop).toBeGreaterThan(lock);
        expect(admin).toContain('and s.studio_id is distinct from p_studio');
        expect(admin).toMatch(/insert into public\.district_retention_log[^;]*'skipped_reattributed'/);
    });

    it('still logs the correction itself', () => {
        expect(admin).toMatch(/'attribution_changed'/);
        expect(admin).toContain("set_config('cleffy.district_attribution', 'admin', true)");
    });
});

describe('20261022130000 reruns and keeps the service role alone', () => {
    const stmts = statements(migration);

    it('only replaces functions, and adds its constraint inside a DO block', () => {
        for (const s of stmts.filter((x) => /^create (or replace )?function\b/i.test(x))) {
            expect(s, s).toMatch(/^create or replace function /i);
        }
        for (const s of stmts) {
            expect(s, s).not.toMatch(/\badd constraint\b|^create (table|index|trigger|policy)\b/i);
        }
        expect(migration).toMatch(
            /drop constraint if exists district_retention_log_step_check;\s+alter table public\.district_retention_log\s+add constraint district_retention_log_step_check/,
        );
    });

    it('keeps every step 20261021120800 allows, and adds skipped_reattributed', () => {
        const check = migration.match(/add constraint district_retention_log_step_check check \(([\s\S]*?)\);/)?.[1];
        for (const step of [
            'notice_queued',
            'notice_sent',
            'soft_deleted',
            'hard_deleted',
            'cancelled',
            'attribution_changed',
            'attribution_backfilled',
            'attribution_backfill_run',
            'skipped_reattributed',
        ]) {
            expect(check).toContain(`'${step}'`);
        }
    });

    it('revokes from clients and grants the service role both functions', () => {
        expect(migration).toContain("'public.admin_set_student_district (uuid, uuid, text)'");
        expect(migration).toContain("'public.retention_district_run (timestamptz, int)'");
        expect(migration).toContain(
            "execute format('revoke all on function %s from public, anon, authenticated', fn);",
        );
        expect(migration).toContain("execute format('grant execute on function %s to service_role', fn);");
    });

    it('schedules nothing: retention-district stays Max’s to schedule', () => {
        expect(migration).not.toMatch(/^\s*select cron\.schedule/m);
    });
});
