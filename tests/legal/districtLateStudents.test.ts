// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Decision 53(4) / 67 (20261022130300): no student is provisioned into, or
 * outlives, a district whose purge has begun. The database proofs are
 * tests/sql/district_retention_late_student.sql (the verification proof, 6 of
 * 6), district_provision_barrier.sql (the barrier),
 * district_retention_relist_idempotent.sql (the re-list) and
 * district_retention_late_student_race.sql (the lock, between real sessions).
 * What CI holds here, without a database, is the shape: the district's lock is
 * taken before its state is read and before any roster row, the run re-lists
 * on every pass and right before the hard delete's loop, and the refusals carry
 * the barrier's code all the way to student-provision's 409.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261022130300_district_retention_late_students.sql');
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

const KEY_SHARE = 'from public.district_billing b where b.studio_id = new.district_studio_id for key share;';

describe('the barrier (decision 67(a))', () => {
    it('counts a district as being deleted from its soft delete until for good, not during the notice', () => {
        const pending = fn('district_deletion_pending');
        expect(pending).toMatch(/r\.soft_deleted_at is not null or r\.hard_deleted_at is not null/);
        expect(pending).not.toMatch(/notice/);
    });

    it('tells the district’s state to its own teachers only, and district_provisionable follows it', () => {
        const refusal = fn('district_provision_refusal');
        expect(refusal.indexOf("then 'not_in_district'")).toBeGreaterThan(-1);
        expect(refusal.indexOf("then 'district_deletion_pending'")).toBeGreaterThan(
            refusal.indexOf("then 'not_in_district'"),
        );
        expect(fn('district_provisionable')).toMatch(
            /select public\.district_provision_refusal \(p_teacher, p_studio\) is null;/,
        );
    });

    it('locks the district in the roster trigger before reading its state, on insert and on a move into it', () => {
        const trigger = fn('managed_students_district_attribution');
        const insert = trigger.slice(
            trigger.indexOf("if tg_op = 'INSERT' then"),
            trigger.indexOf('elsif new.district'),
        );
        expect(insert.indexOf(KEY_SHARE)).toBeGreaterThan(-1);
        expect(insert.indexOf('public.district_provision_refusal (new.teacher_id')).toBeGreaterThan(
            insert.indexOf(KEY_SHARE),
        );
        expect(insert).toMatch(/raise exception 'district_deletion_pending'\s+using errcode = '55000'/);
        const update = trigger.slice(trigger.indexOf('elsif new.district'));
        expect(update).toMatch(/raise exception 'district attribution is recorded at provisioning/);
        expect(update.indexOf('public.district_deletion_pending (new.district_studio_id)')).toBeGreaterThan(
            update.indexOf(KEY_SHARE),
        );
    });

    it('takes the district’s lock before the roster row’s in the admin correction and the backfill', () => {
        const admin = fn('admin_set_student_district');
        const lock = admin.indexOf('where b.studio_id = p_studio for key share;');
        expect(lock).toBeGreaterThan(-1);
        expect(admin.indexOf('where ms.id = p_managed_student for update;')).toBeGreaterThan(lock);
        expect(admin).toMatch(
            /p_studio is distinct from v_old and public\.district_deletion_pending \(p_studio\) then\s+raise exception 'district_deletion_pending'/,
        );
        const backfill = fn('backfill_district_student_attribution');
        expect(backfill.indexOf('for key share of b;')).toBeGreaterThan(-1);
        expect(backfill.indexOf('update public.managed_students ms')).toBeGreaterThan(
            backfill.indexOf('for key share of b;'),
        );
        expect(backfill).toMatch(/when public\.district_deletion_pending \(l\.studios\[1\]\) then 'district_gone'/);
    });
});

describe('the re-list (decision 67(b) and (c))', () => {
    const run = fn('retention_district_run');
    const hard = run.slice(run.indexOf("elsif v_step = 'hard_delete' then"), run.indexOf('-- The sweep'));
    const sweep = run.slice(run.indexOf('-- The sweep'));

    it('lists only students not on the list yet, and archives and signs out just those', () => {
        const late = fn('district_retention_list_late');
        expect(late).toMatch(/from public\.retention_district_students \(p_studio\) ds/);
        expect(late).toMatch(/where not exists \([\s\S]*?s\.managed_student_id = ds\.id/);
        expect(late).toMatch(/if v_n = 0 then\s+return 0;/);
        expect(late).toMatch(
            /set archived_at = coalesce\(ms\.archived_at, p_now\),\s+access_revoked_at = clock_timestamp\(\)/,
        );
        expect(late).toMatch(/delete from auth\.refresh_tokens/);
        expect(late).toMatch(/delete from auth\.sessions/);
        expect(late).toMatch(/'soft_deleted',[\s\S]*?'event', 'late_students_listed'/);
    });

    it('lists again in the hard delete under the district’s lock, before the loop that deletes', () => {
        const relist = hard.indexOf("public.district_retention_list_late (candidate.studio_id, p_now, 'hard_delete')");
        expect(relist).toBeGreaterThan(-1);
        expect(hard.indexOf('for v_student in')).toBeGreaterThan(relist);
        expect(run.indexOf('for update skip locked;')).toBeLessThan(run.indexOf("elsif v_step = 'hard_delete' then"));
    });

    it('sweeps every soft-deleted district on every run, each under its billing row’s lock', () => {
        expect(sweep).toMatch(/where r\.soft_deleted_at is not null and r\.hard_deleted_at is null/);
        const lock = sweep.indexOf('for update skip locked;');
        expect(lock).toBeGreaterThan(-1);
        expect(
            sweep.indexOf("public.district_retention_list_late (candidate.studio_id, p_now, 'sweep')"),
        ).toBeGreaterThan(lock);
        expect(sweep).toMatch(/= 'cancel' then\s+continue;/);
        // Not limited by the batch: every soft-deleted district, every run.
        expect(sweep.slice(0, sweep.indexOf('loop'))).not.toMatch(/limit/);
    });

    it('keeps 20261022130000’s hard delete: the attribution re-check under the roster row’s lock', () => {
        expect(hard).toMatch(/for update of m;/);
        expect(hard).toMatch(/v_roster\.district_studio_id is distinct from candidate\.studio_id/);
        expect(run).toMatch(/district_reattributed_restore/);
    });
});

describe('20261022130300 reruns and keeps the service role alone', () => {
    it('sorts after 20261022130000, 130100 and 130200', () => {
        const names = readdirSync(resolve(process.cwd(), 'supabase/migrations'))
            .filter((name) => name.startsWith('202610221'))
            .sort();
        const at = names.indexOf('20261022130300_district_retention_late_students.sql');
        expect(at).toBeGreaterThan(names.indexOf('20261022130100_content_strikes_survive_deletion.sql'));
        expect(names.indexOf('20261022130000_district_retention_reattribution.sql')).toBeLessThan(at);
    });

    it('only replaces functions: no table, trigger, policy or constraint', () => {
        for (const s of statements(migration).filter((x) => /^create\b/i.test(x))) {
            expect(s, s).toMatch(/^create or replace function /i);
        }
        for (const s of statements(migration)) {
            expect(s, s).not.toMatch(/\badd constraint\b|^create (table|trigger|policy|index)\b/i);
        }
    });

    it('revokes every function from clients, grants the service role the callable ones, and none the re-list', () => {
        for (const name of [
            'public.district_deletion_pending (uuid)',
            'public.district_provision_refusal (uuid, uuid)',
            'public.district_provisionable (uuid, uuid)',
            'public.managed_students_district_attribution ()',
            'public.admin_set_student_district (uuid, uuid, text)',
            'public.backfill_district_student_attribution ()',
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

    it('adds no step to the district retention log', () => {
        expect(migration).not.toMatch(/district_retention_log_step_check|step in \(/);
    });
});

describe('student-provision answers the barrier with a 409', () => {
    const provision = read('supabase/functions/student-provision/index.ts');

    it('maps the trigger’s refusal of either create path’s roster insert', () => {
        expect(provision.match(/isDistrictDeletionPending\(insertError\)/g)).toHaveLength(2);
        expect(provision.match(/jsonResponse\(DISTRICT_DELETION_PENDING, 409\)/g)).toHaveLength(2);
    });
});
