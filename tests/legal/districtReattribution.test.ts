// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Launch re-audit, Codex A4 (20261022130000): a student re-attributed after the
 * district soft delete is not hard deleted under the district they left, and
 * gets back what that purge took (Codex round 1 on #66, minor 2).
 * tests/sql/district_retention_reattribution.sql proves it against a database,
 * and tests/sql/migrations_ordered_replay.sql that the migrations replay in
 * order over its log rows (minor 1); what CI holds here, without one, is the
 * shape: the hard delete re-checks the roster row's district and account under
 * its lock, the admin correction drops the student from other districts' purge
 * lists, both restore through the same plan check and log the skip as
 * attribution_changed (no new step), and the migration reruns.
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

    it('takes a skipped student off the list, restores a moved one, and logs the skip with its counts', () => {
        expect(hard).toMatch(
            /delete from public\.district_retention_students\s+where studio_id = candidate\.studio_id and managed_student_id = v_student\.managed_student_id;/,
        );
        expect(hard).toContain(
            'else public.district_reattributed_restore (v_student.managed_student_id, candidate.studio_id) end;',
        );
        expect(hard).toMatch(
            /insert into public\.district_retention_log[^;]*'attribution_changed'[^;]*'event', 'skipped_reattributed'[^;]*'students_skipped'/,
        );
    });

    it('retries the carried-over restores on cancel, and clears them with the lists', () => {
        const cancel = run.slice(run.indexOf("if v_step = 'cancel' then"), run.indexOf("elsif v_step = 'notice' then"));
        expect(cancel).toContain(
            "if public.district_reattributed_restore (v_carried.managed_student_id, candidate.studio_id) = 'restored' then",
        );
        expect(cancel).toContain(
            'delete from public.district_retention_restores where studio_id = candidate.studio_id;',
        );
        expect(hard).toContain('delete from public.district_retention_restores where studio_id = candidate.studio_id;');
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
        expect(admin).toMatch(
            /insert into public\.district_retention_log[^;]*'attribution_changed'[^;]*'event', 'skipped_reattributed'/,
        );
    });

    it('un-archives a student the purge archived, or carries the restore over', () => {
        expect(admin).toContain(
            "v_restore := case when v_drop.was_archived then 'was_archived'\n                          else public.district_reattributed_restore (p_managed_student, v_drop.studio_id) end;",
        );
        expect(admin).toMatch(
            /if v_restore in \('on_another_purge', 'no_roster_plan', 'roster_full'\) then\s+insert into public\.district_retention_restores/,
        );
    });

    it('still logs the correction itself', () => {
        expect(admin).toMatch(/'attribution_changed'/);
        expect(admin).toContain("set_config('cleffy.district_attribution', 'admin', true)");
    });
});

describe('the restore is student-provision’s roster check (20261022130000)', () => {
    const restore = fn('district_reattributed_restore');

    it('locks the row, skips another district’s purge, and checks the teacher’s plan and count', () => {
        expect(restore).toContain('where ms.id = p_managed_student for update;');
        expect(restore).toContain('s.studio_id is distinct from p_left_studio');
        expect(restore).toContain("(public.resolve_entitlements (v_row.teacher_id) -> 'limits' ->> 'students')::int");
        expect(restore).toMatch(/if v_limit is null or v_limit = 0 then\s+return 'no_roster_plan';/);
        expect(restore).toMatch(/if v_active >= v_limit then\s+return 'roster_full';/);
        // The update comes after every check.
        expect(restore.indexOf('set archived_at = null')).toBeGreaterThan(restore.indexOf("return 'roster_full'"));
    });

    it('mirrors the edge function’s gate (limits.students: 0 refuses, -1 is unlimited)', () => {
        const provision = read('supabase/functions/student-provision/index.ts');
        expect(provision).toContain('const limit = entitlements.limits.students;');
        expect(provision).toContain(".is('archived_at', null);");
        expect(provision).toContain('return count >= limit ? refusal() : { ok: true };');
    });
});

describe('no migration logs a step 20261021120800’s replay would refuse', () => {
    it('only 20261021120800 rebuilds the step check, and 20261022130000 does not touch it', () => {
        const dir = resolve(process.cwd(), 'supabase/migrations');
        const rebuilders = readdirSync(dir)
            .filter((name) => name.endsWith('.sql') && !/_imslp_works_catalog\.sql$/.test(name))
            .filter((name) =>
                /add constraint district_retention_log_step_check/.test(read(`supabase/migrations/${name}`)),
            );
        expect(rebuilders).toEqual(['20261021120800_district_student_attribution.sql']);
        expect(migration).not.toMatch(/'skipped_reattributed'\s*\)|step in \(/);
    });

    it('the ordered replay proof replays, in order, every rerunnable migration through this one', () => {
        const proof = read('tests/sql/migrations_ordered_replay.sql');
        const included = [...proof.matchAll(/^\\ir \.\.\/\.\.\/supabase\/migrations\/(\S+)$/gm)].map((m) => m[1]);
        expect(included[0]).toBe('20261020160300_cancel_link_token_lifetime.sql');
        expect(included).toEqual([...included].sort());
        expect(included).toContain('20261021120800_district_student_attribution.sql');
        expect(included.slice(-3)).toEqual([
            '20261022130000_district_retention_reattribution.sql',
            '20261022130100_content_strikes_survive_deletion.sql',
            '20261022130300_district_retention_late_students.sql',
        ]);
        for (const name of included) expect(() => read(`supabase/migrations/${name}`), name).not.toThrow();
    });
});

describe('20261022130000 reruns and keeps the service role alone', () => {
    const stmts = statements(migration);

    it('only replaces functions, creates its table if missing, and adds no constraint', () => {
        for (const s of stmts.filter((x) => /^create (or replace )?function\b/i.test(x))) {
            expect(s, s).toMatch(/^create or replace function /i);
        }
        for (const s of stmts.filter((x) => /^create (unique )?(table|index)\b/i.test(x))) {
            expect(s, s).toMatch(/^create (unique )?(table|index) if not exists /i);
        }
        for (const s of stmts) {
            expect(s, s).not.toMatch(/\badd constraint\b|^create (trigger|policy)\b/i);
        }
    });

    it('keeps the carried-over restores the service role’s, with RLS on', () => {
        expect(migration).toContain('alter table public.district_retention_restores enable row level security;');
        expect(migration).toContain(
            'revoke all on table public.district_retention_restores from public, anon, authenticated;',
        );
        expect(migration).toContain(
            'revoke all on function public.district_reattributed_restore (uuid, uuid) from public, anon, authenticated;',
        );
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
