// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    buildDistrictNotice,
    type DeliverDeps,
    deliverDistrictNotices,
    type MailReservation,
    NOTICE_BATCH,
    noticeIdempotencyKey,
    type DistrictNoticeRow,
} from '../../supabase/functions/_shared/districtNotice';
import { MAIL_CATEGORY_CAPS, MAIL_WINDOW_MS, mailLimit } from '../../supabase/functions/_shared/mailBudget';

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
    created_at: '2026-10-17T03:57:00Z',
    ...overrides,
});

describe('the district export notice', () => {
    it('says what goes, when, what stays, and how to export or stop it', () => {
        const { subject, text } = buildDistrictNotice(row(1));
        expect(subject).toBe("Cleffy will delete Springfield Schools's district data on or after 4 November 2026");
        expect(text).toContain('ended on 30 September 2026');
        expect(text).toContain('On or after 4 November 2026 we will delete');
        expect(text).toMatch(/student accounts your district's teachers added for the district/);
        expect(text).toContain('Students a teacher added to their own private roster');
        expect(text).toMatch(
            /Teachers' own Cleffy accounts and the scores they uploaded are theirs and are not deleted/,
        );
        expect(text).toContain('export it before 4 November 2026');
        expect(text).toContain('support@cleffy.io');
    });
});

const noticeSender = read('supabase/functions/district-retention-notices/index.ts');

/** Every reservation is granted; `released` counts the ones handed back. */
const openBudget = () => {
    const budget = { reserved: 0, released: 0 };
    const reserve = vi.fn(async (): Promise<MailReservation> => {
        budget.reserved += 1;
        return {
            ok: true,
            release: async () => {
                budget.released += 1;
            },
        };
    });
    return { budget, reserve };
};

const deps = (overrides: Partial<DeliverDeps> = {}): DeliverDeps => ({
    claim: async () => [row(1), row(2)],
    reserve: openBudget().reserve,
    hourlyLimit: MAIL_CATEGORY_CAPS.retentionNotice.hour,
    send: vi.fn(async () => 'sent' as const),
    finish: vi.fn(async () => true),
    defer: vi.fn(async () => true),
    ...overrides,
});

describe('delivering notices', () => {
    it('marks a sent notice sent, and a failed one failed (retried next run, never counted as sent)', async () => {
        const finish = vi.fn(async () => true);
        const send = vi.fn(async (to: string): Promise<'sent' | 'failed'> =>
            to === 'owner2@example.invalid' ? 'failed' : 'sent',
        );
        const result = await deliverDistrictNotices(deps({ send, finish }));
        expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, deferred: 0 });
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
        const result = await deliverDistrictNotices(deps({ send, finish }));
        expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, deferred: 0 });
        expect(finish).toHaveBeenNthCalledWith(1, 1, 'send failed');
        expect(finish).toHaveBeenNthCalledWith(2, 2, null);
    });

    it('without a mail key nothing counts as sent', async () => {
        const finish = vi.fn(async () => true);
        await deliverDistrictNotices(deps({ claim: async () => [row(1)], send: async () => 'unconfigured', finish }));
        expect(finish).toHaveBeenCalledWith(1, 'mail is not configured');
    });

    it('claims a bounded batch, no more than an hour of the budget, and reports a failed claim', async () => {
        const claim = vi.fn(async () => null);
        expect(await deliverDistrictNotices(deps({ claim }))).toBeNull();
        expect(claim).toHaveBeenCalledWith(Math.min(NOTICE_BATCH, MAIL_CATEGORY_CAPS.retentionNotice.hour));
        expect(NOTICE_BATCH).toBeLessThanOrEqual(20);
        const none = vi.fn(async () => []);
        expect(await deliverDistrictNotices(deps({ claim: none, hourlyLimit: 0 }))).toEqual({
            claimed: 0,
            sent: 0,
            failed: 0,
            deferred: 0,
        });
        expect(none).not.toHaveBeenCalled();
    });
});

describe('the shared mail budget (Codex round 2, new major 2)', () => {
    it('reserves before every send, and never sends without a reservation', async () => {
        const order: string[] = [];
        const result = await deliverDistrictNotices(
            deps({
                reserve: async () => {
                    order.push('reserve');
                    return { ok: true, release: async () => undefined };
                },
                send: async () => {
                    order.push('send');
                    return 'sent';
                },
            }),
        );
        expect(result?.sent).toBe(2);
        expect(order).toEqual(['reserve', 'send', 'reserve', 'send']);
    });

    it('once the budget is spent, defers that notice and every one after it, unsent and retryable', async () => {
        let granted = 1;
        const send = vi.fn(async () => 'sent' as const);
        const finish = vi.fn(async () => true);
        const defer = vi.fn(async () => true);
        const reserve = vi.fn(async (): Promise<MailReservation> =>
            granted-- > 0 ? { ok: true, release: async () => undefined } : { ok: false, retryAfterSec: 900 },
        );
        const result = await deliverDistrictNotices(
            deps({ claim: async () => [row(1), row(2), row(3)], reserve, send, finish, defer }),
        );
        expect(result).toEqual({ claimed: 3, sent: 1, failed: 0, deferred: 2 });
        expect(send).toHaveBeenCalledTimes(1);
        expect(finish).toHaveBeenCalledTimes(1);
        expect(defer.mock.calls).toEqual([[2], [3]]);
        // Asked once more after the first refusal? No: the window will not reopen mid-batch.
        expect(reserve).toHaveBeenCalledTimes(2);
    });

    it('a reservation that errors is a spent budget, never a send', async () => {
        const send = vi.fn(async () => 'sent' as const);
        const defer = vi.fn(async () => true);
        const result = await deliverDistrictNotices(
            deps({ reserve: async () => Promise.reject(new Error('rpc down')), send, defer }),
        );
        expect(result).toEqual({ claimed: 2, sent: 0, failed: 0, deferred: 2 });
        expect(send).not.toHaveBeenCalled();
    });

    it('hands the reservation back when no mail went out, and keeps it when the send may have', async () => {
        const { budget, reserve } = openBudget();
        const outcomes = ['failed', 'unconfigured', 'throw', 'sent'] as const;
        let i = 0;
        const send = vi.fn(async (): Promise<'sent' | 'failed' | 'unconfigured'> => {
            const outcome = outcomes[i++];
            if (outcome === 'throw') {
                throw new Error('connection reset after the request was written');
            }
            return outcome!;
        });
        await deliverDistrictNotices(deps({ claim: async () => [row(1), row(2), row(3), row(4)], reserve, send }));
        expect(budget).toEqual({ reserved: 4, released: 2 });
    });

    it('gives every delivery a provider idempotency key, stable for the notice, new for a new cycle', async () => {
        const send = vi.fn(async () => 'sent' as const);
        await deliverDistrictNotices(deps({ claim: async () => [row(7)], send }));
        const key = noticeIdempotencyKey(row(7));
        expect(send).toHaveBeenCalledWith('owner7@example.invalid', buildDistrictNotice(row(7)), key);
        expect(noticeIdempotencyKey(row(7))).toBe(key);
        expect(noticeIdempotencyKey(row(7, { created_at: '2026-11-01T00:00:00Z' }))).not.toBe(key);
        expect(noticeIdempotencyKey(row(8))).not.toBe(key);
    });

    it('integration: against the real retentionNotice windows, never more than its hour and day caps go out', async () => {
        // A sliding-window limiter like check_edge_rate_limit, keyed as the
        // sender keys it, sized by mailLimit() from the canonical split.
        let now = Date.parse('2026-10-21T00:00:00Z');
        const buckets = new Map<string, number[]>();
        const windows = (['hour', 'day'] as const).map((w) => ({ key: w, ...mailLimit('retentionNotice', w) }));
        const reserve = async (): Promise<MailReservation> => {
            const taken: string[] = [];
            for (const { key, limit, windowMs } of windows) {
                const hits = (buckets.get(key) ?? []).filter((t) => t > now - windowMs);
                if (hits.length >= limit) {
                    for (const k of taken) {
                        buckets.get(k)!.pop();
                    }
                    return { ok: false, retryAfterSec: 60 };
                }
                buckets.set(key, [...hits, now]);
                taken.push(key);
            }
            return { ok: true, release: async () => taken.forEach((k) => buckets.get(k)!.pop()) };
        };
        // Sixty districts' notices queued at once; the sender is woken every 10 minutes for two days.
        const queue = Array.from({ length: 60 }, (_, i) => row(i + 1));
        const sentAt: number[] = [];
        for (let tick = 0; tick < 6 * 48; tick += 1) {
            await deliverDistrictNotices(
                deps({
                    claim: async (limit) => queue.splice(0, limit),
                    reserve,
                    hourlyLimit: windows[0]!.limit,
                    send: async () => {
                        sentAt.push(now);
                        return 'sent';
                    },
                    defer: async (id) => {
                        queue.unshift(row(id));
                        return true;
                    },
                }),
            );
            now += 10 * 60_000;
        }
        const most = (windowMs: number): number =>
            Math.max(...sentAt.map((t) => sentAt.filter((u) => u >= t && u < t + windowMs).length));
        expect(MAIL_CATEGORY_CAPS.retentionNotice).toEqual({ hour: 5, day: 25 });
        expect(most(MAIL_WINDOW_MS.hour)).toBeLessThanOrEqual(5);
        expect(most(MAIL_WINDOW_MS.day)).toBeLessThanOrEqual(25);
        // And the budget is used, not just respected: 25 the first day, the rest the next.
        expect(sentAt.length).toBe(50);
        expect(queue).toHaveLength(10);
    });

    it('the Deno sender reserves the retentionNotice share before calling Resend, with the idempotency key', () => {
        expect(noticeSender).toContain("mailLimit('retentionNotice', 'hour', env)");
        expect(noticeSender).toContain("mailLimit('retentionNotice', 'day', env)");
        expect(noticeSender).toMatch(/const gate = await checkRateLimit\(key, limit, windowMs\);/);
        expect(noticeSender).toContain("'Idempotency-Key': idempotencyKey");
        expect(noticeSender).toMatch(/reserve,\s+hourlyLimit: BUDGET\[0\]\[1\]\.limit,\s+send,/);
        expect(noticeSender).toContain("admin.rpc('defer_district_retention_notice'");
        // One call site to Resend, inside the send deliverDistrictNotices only reaches with a reservation.
        expect(noticeSender.match(/api\.resend\.com/g)).toHaveLength(1);
        expect(noticeSender.match(/fetch\(/g)).toHaveLength(1);
    });

    it('a deferral hands the claim back without spending an attempt (20261021120900)', () => {
        const defer = read('supabase/migrations/20261021120900_district_notice_mail_budget.sql');
        expect(defer).toMatch(/set lease_until = null,\s+attempts = greatest\(attempts - 1, 0\)/);
        expect(defer).toMatch(/where id = p_id and sent_at is null;/);
        expect(defer).toContain(
            'grant execute on function public.defer_district_retention_notice (bigint) to service_role;',
        );
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

    it('records a district only when provisioning names one the teacher owns or is seated in', () => {
        const trigger = fn('managed_students_district_attribution');
        // Positive evidence only: the trigger never derives a district from membership.
        expect(trigger).not.toMatch(/district_studio_for_teacher|:= public\.district/);
        expect(trigger).toMatch(
            /if tg_op = 'INSERT' then[\s\S]*?new\.district_attribution := 'provisioned';\s+if new\.district_studio_id is not null\s+and not public\.district_provisionable \(new\.teacher_id, new\.district_studio_id\) then\s+raise exception[^;]*errcode = '42501';/,
        );
        const provisionable = fn('district_provisionable');
        expect(provisionable).toMatch(/join public\.studios st on st\.id = b\.studio_id/);
        expect(provisionable).toMatch(/st\.owner_id = p_teacher/);
        expect(provisionable).toMatch(/sm\.studio_id = p_studio and sm\.user_id = p_teacher/);
        expect(scope).toMatch(
            /create trigger managed_students_district_attribution before insert or update on public\.managed_students/,
        );
        expect(scope).toContain("'public.district_provisionable (uuid, uuid)'");
    });

    it('marks every pre-existing row legacy without an UPDATE, and every new row provisioned', () => {
        expect(scope).toMatch(
            /add column if not exists district_attribution text not null default 'legacy';\s+alter table public\.managed_students\s+alter column district_attribution set default 'provisioned';/,
        );
        expect(scope).toMatch(/check \(district_attribution in \('provisioned', 'legacy', 'backfilled', 'admin'\)\)/);
    });

    it('student-provision asks before any account exists, and writes the checked district on both paths', () => {
        const provision = read('supabase/functions/student-provision/index.ts');
        const create = provision.slice(provision.indexOf('const createStudent = async'));
        const check = create.indexOf('checkDistrictChoice(');
        expect(check).toBeGreaterThan(-1);
        expect(create.indexOf('checkRosterStock(')).toBeGreaterThan(check);
        expect(create.indexOf('createEmailStudent(admin')).toBeGreaterThan(check);
        expect(provision.match(/district_studio_id: districtStudioId,/g)).toHaveLength(2);
    });

    it('refuses to change the record by UPDATE except through the logged admin correction', () => {
        expect(fn('managed_students_district_attribution')).toMatch(/errcode = '42501'/);
        const admin = fn('admin_set_student_district');
        expect(admin).toContain("set_config('cleffy.district_attribution', 'admin', true)");
        expect(admin).toMatch(/'attribution_changed'/);
        expect(scope).toContain("'public.admin_set_student_district (uuid, uuid, text)'");
    });

    it('backfills legacy rows only, never a row decided at provisioning', () => {
        const backfill = fn('backfill_district_student_attribution');
        expect(backfill).toMatch(/where ms\.district_attribution = 'legacy'/);
        expect(backfill).toMatch(/district_attribution = 'backfilled'/);
    });

    it('backfills on recorded evidence only, never on a seat or ownership alone', () => {
        const backfill = fn('backfill_district_student_attribution');
        expect(backfill).toMatch(/from public\.district_student_evidence e/);
        expect(backfill).not.toMatch(/studio_members|owner_id/);
        expect(scope).toContain('drop function if exists public.district_studio_for_teacher (uuid, timestamptz);');
        expect(scope).not.toMatch(/create or replace function public\.district_studio_for_teacher/);
    });

    it('bounds the evidence by the seat’s whole tenure, which outlives the seat', () => {
        const inTenure = fn('district_evidence_in_tenure');
        expect(inTenure).toMatch(
            /t\.started_at <= ms\.created_at\s+and \(t\.ended_at is null or ms\.created_at < t\.ended_at\)/,
        );
        expect(inTenure).not.toMatch(/studio_members/);
        const tenure = fn('studio_members_seat_tenure');
        expect(tenure).toMatch(/values \(new\.studio_id, new\.user_id, new\.created_at\)/);
        expect(tenure).toMatch(/set ended_at = greatest\(now\(\), t\.started_at\)/);
        expect(scope).toMatch(
            /create trigger studio_members_seat_tenure after insert or delete on public\.studio_members/,
        );
        expect(scope).toMatch(/grant select on table public\.studio_seat_tenures to service_role;/);
    });

    it('is proven against a database for a private roster, a departed teacher and two districts', () => {
        for (const check of [
            'a private student provisioned before the teacher joined a district belongs to no district',
            'a seated teacher who names no district provisions a private student',
            'a teacher cannot provision into a district they are not in',
            "a backfill never revisits a row decided at provisioning, a seated teacher''s private student included",
            'a seat or ownership when the student was created is not evidence: with no record, no legacy row is attributed',
            "a departed teacher''s legacy student is attributed within the seat''s tenure, start to end",
            'but never on evidence outside the tenure: before the seat started, or once it ended',
            "the hard delete removes the districts'' students, the departed teacher''s l1 included",
            "and never a private student (p1 from before joining, p2 added privately while seated, l2 from after leaving, oa0 from before the district), nor Q''s",
        ]) {
            expect(sqlProof).toContain(check);
        }
    });
});
