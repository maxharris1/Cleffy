// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    buildDistrictNotice,
    deliverDistrictNotices,
    NOTICE_BATCH,
    type DistrictNoticeRow,
} from '../../supabase/functions/_shared/districtNotice';

/**
 * District retention (decision 1): the export notice and the purge's shape.
 * The purge itself is proven against a database by tests/sql/district_retention.sql
 * (notice, soft delete, cancel on renewal, restore wins, hard delete, counts).
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261021120700_district_retention.sql');

const row = (id: number, overrides: Partial<DistrictNoticeRow> = {}): DistrictNoticeRow => ({
    id,
    to_email: `owner${id}@example.invalid`,
    studio_name: 'Springfield Schools',
    contract_ends_at: '2026-09-30T00:00:00Z',
    purge_not_before: '2026-11-04T00:00:00Z',
    ...overrides,
});

describe('the district export notice', () => {
    it('says what goes, when, what stays, and how to export or stop it', () => {
        const { subject, text } = buildDistrictNotice(row(1));
        expect(subject).toBe("Cleffy will delete Springfield Schools's district data on or after 4 November 2026");
        expect(text).toContain('ended on 30 September 2026');
        expect(text).toContain('On or after 4 November 2026 we will delete');
        expect(text).toMatch(/student accounts your district's teachers created/);
        expect(text).toMatch(
            /Teachers' own Cleffy accounts and the scores they uploaded are theirs and are not deleted/,
        );
        expect(text).toContain('export it before 4 November 2026');
        expect(text).toContain('support@cleffy.io');
    });
});

describe('delivering notices', () => {
    it('marks a sent notice sent, and a failed one failed (retried next run, never counted as sent)', async () => {
        const finish = vi.fn(async () => true);
        const send = vi.fn(async (to: string): Promise<'sent' | 'failed'> =>
            to === 'owner2@example.invalid' ? 'failed' : 'sent',
        );
        const result = await deliverDistrictNotices({ claim: async () => [row(1), row(2)], send, finish });
        expect(result).toEqual({ claimed: 2, sent: 1, failed: 1 });
        expect(finish).toHaveBeenCalledWith(1, null);
        expect(finish).toHaveBeenCalledWith(2, 'send failed');
    });

    it('a send that throws is a failure, and the rest still go', async () => {
        const finish = vi.fn(async () => true);
        let calls = 0;
        const send = vi.fn(async () => {
            calls += 1;
            if (calls === 1) {
                throw new Error('network');
            }
            return 'sent' as const;
        });
        const result = await deliverDistrictNotices({ claim: async () => [row(1), row(2)], send, finish });
        expect(result).toEqual({ claimed: 2, sent: 1, failed: 1 });
        expect(finish).toHaveBeenNthCalledWith(1, 1, 'send failed');
        expect(finish).toHaveBeenNthCalledWith(2, 2, null);
    });

    it('without a mail key nothing counts as sent', async () => {
        const finish = vi.fn(async () => true);
        await deliverDistrictNotices({ claim: async () => [row(1)], send: async () => 'unconfigured', finish });
        expect(finish).toHaveBeenCalledWith(1, 'mail is not configured');
    });

    it('claims a bounded batch, and reports a failed claim', async () => {
        const claim = vi.fn(async () => null);
        expect(await deliverDistrictNotices({ claim, send: vi.fn(), finish: vi.fn() })).toBeNull();
        expect(claim).toHaveBeenCalledWith(NOTICE_BATCH);
        expect(NOTICE_BATCH).toBeLessThanOrEqual(20);
    });
});

describe('the district purge (20261021120700)', () => {
    it('ships paused: the migration schedules nothing', () => {
        expect(migration).not.toMatch(/^\s*select cron\.schedule/m);
        expect(migration).toMatch(/--\s+select cron\.schedule \('retention-district'/);
    });

    it('purges 30 days after contract_ends_at, notices at 16, waits 14 days after a SENT notice, hard deletes 7 days after soft', () => {
        const step = migration.match(/function public\.retention_district_next_step[\s\S]*?\$\$;/)?.[0] ?? '';
        expect(step).toContain("p_notice_after interval default interval '16 days'");
        expect(step).toContain("p_purge_after interval default interval '30 days'");
        expect(step).toContain("p_notice_lead interval default interval '14 days'");
        expect(step).toContain("p_hard_after interval default interval '7 days'");
        expect(step).toMatch(/when p_contract_ends_at is null then null/);
        expect(step).toMatch(/p_state\.notice_sent_at is not null\s+and p_now >= greatest/);
    });

    it('has a counts-only dry run, and everything is the service role’s alone', () => {
        expect(migration).toMatch(
            /function public\.retention_district_dry_run \(p_now timestamptz default now\(\)\) returns jsonb\s+language plpgsql stable/,
        );
        expect(migration).toContain("execute format('revoke all on function %s from public, anon, authenticated', fn)");
        expect(migration).toMatch(
            /revoke all on table public\.district_billing from public, anon, authenticated, service_role;\s+grant select on table public\.district_billing to service_role;/,
        );
    });

    it('logs every step with counts', () => {
        for (const step of ['notice_queued', 'notice_sent', 'soft_deleted', 'hard_deleted', 'cancelled']) {
            expect(migration).toMatch(new RegExp(`insert into public\\.district_retention_log[^;]*'${step}'`));
        }
    });

    it('re-checks each district under its billing record’s lock', () => {
        const run = migration.match(/function public\.retention_district_run[\s\S]*?\$\$;/)?.[0] ?? '';
        const lock = run.indexOf('for update skip locked');
        expect(lock).toBeGreaterThan(-1);
        expect(run.indexOf('v_step := public.retention_district_next_step')).toBeGreaterThan(lock);
    });

    it('declares district_billing with #61’s canonical block, contract_ends_at nullable', () => {
        // tests/legal/districtBillingCanonical.test.ts pins the block's bytes.
        expect(migration).toContain('-- >>> canonical public.district_billing >>>');
        expect(migration).toMatch(
            /create table if not exists public\.district_billing \([\s\S]*?contract_ends_at timestamptz,/,
        );
        expect(migration).not.toMatch(/add column if not exists contract_ends_at/);
        expect(migration).not.toMatch(/grant all on table public\.district_billing\b/);
    });
});

describe('the district purge’s scope (20261021120800)', () => {
    const scope = read('supabase/migrations/20261021120800_district_student_attribution.sql');
    const sqlProof = read('tests/sql/district_student_scope.sql');
    const fn = (name: string): string =>
        scope.match(new RegExp(`function public\\.${name}[\\s\\S]*?\\$\\$;`))?.[0] ?? '';

    it('selects on the district each student was provisioned under, never on current membership', () => {
        const students = fn('retention_district_students');
        expect(students).toMatch(/where ms\.district_studio_id = p_studio/);
        expect(students).not.toMatch(/studio_members|owner_id/);
    });

    it('records the district at provisioning, by trigger, whatever the caller supplies', () => {
        const trigger = fn('managed_students_district_attribution');
        expect(trigger).toMatch(
            /if tg_op = 'INSERT' then\s+new\.district_studio_id := public\.district_studio_for_teacher \(new\.teacher_id, now\(\)\);/,
        );
        expect(scope).toMatch(
            /create trigger managed_students_district_attribution before insert or update on public\.managed_students/,
        );
    });

    it('counts only district studios, the owner’s first, then the seat held longest', () => {
        const rule = fn('district_studio_for_teacher');
        expect(rule.match(/join public\.district_billing b/g)).toHaveLength(2);
        expect(rule).toMatch(/sm\.created_at <= p_at/);
        expect(rule).toMatch(/order by d\.rank, d\.since, d\.studio_id\s+limit 1/);
    });

    it('refuses to change the record by UPDATE except through the logged admin correction', () => {
        expect(fn('managed_students_district_attribution')).toMatch(/errcode = '42501'/);
        const admin = fn('admin_set_student_district');
        expect(admin).toContain("set_config('cleffy.district_attribution', 'admin', true)");
        expect(admin).toMatch(/'attribution_changed'/);
        expect(scope).toContain("'public.admin_set_student_district (uuid, uuid, text)'");
    });

    it('backfills only from a seat held since before the student was created, and only unattributed rows', () => {
        const backfill = fn('backfill_district_student_attribution');
        expect(backfill).toMatch(/district_studio_for_teacher \(ms\.teacher_id, ms\.created_at\)/);
        expect(backfill).toMatch(/where ms\.district_studio_id is null/);
    });

    it('is proven against a database for a private roster, a departed teacher and two districts', () => {
        for (const check of [
            'a private student provisioned before the teacher joined a district belongs to no district',
            'a teacher seated in two districts provisions into the seat held longest (B), not both',
            "the hard delete removes the districts'' students, the departed teacher''s l1 included",
            "and never the teacher''s private students (p1 from before joining, l2 from after leaving), nor Q''s",
        ]) {
            expect(sqlProof).toContain(check);
        }
    });
});
