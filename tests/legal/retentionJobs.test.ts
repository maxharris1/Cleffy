// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The launch retention periods, as the migration schedules them. The SQL itself
 * is proven against a database by tests/sql/launch_consent.sql; this keeps the
 * numbers the privacy policy will quote from drifting without anyone noticing.
 */
const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20261021120300_retention_jobs.sql'), 'utf8');

const defaultOf = (fn: string, param: string): string | undefined =>
    sql.match(
        new RegExp(
            `function\\s+public\\.${fn}\\s*\\([\\s\\S]*?${param}\\s+interval\\s+default\\s+interval\\s+'([^']+)'`,
            'i',
        ),
    )?.[1];

describe('retention periods', () => {
    it.each([
        ['retention_purge_archived_students', 'p_older_than', '12 months'],
        ['retention_purge_stale_guests', 'p_idle', '90 days'],
        ['retention_purge_rate_limits', 'p_idle', '1 day'],
        ['retention_purge_support_messages', 'p_older_than', '24 months'],
    ])('%s keeps %s at %s', (fn, param, period) => {
        expect(defaultOf(fn, param)).toBe(period);
    });

    it('compacts tombstones weekly, after 90 days', () => {
        expect(sql).toMatch(
            /cron\.schedule\s*\(\s*'retention-compact-tombstones',\s*'\d+ \d+ \* \* 0',\s*\$\$select public\.compact_annotation_tombstones \(interval '90 days'\)\$\$/,
        );
    });

    it('runs the other four daily, each calling its own function with its defaults', () => {
        for (const [job, fn] of [
            ['retention-archived-students', 'retention_purge_archived_students'],
            ['retention-stale-guests', 'retention_purge_stale_guests'],
            ['retention-rate-limits', 'retention_purge_rate_limits'],
            ['retention-support-messages', 'retention_purge_support_messages'],
        ]) {
            expect(sql, job).toMatch(
                new RegExp(
                    `cron\\.schedule \\('${job}', '\\d+ \\d+ \\* \\* \\*', \\$\\$select public\\.${fn} \\(\\)\\$\\$\\)`,
                ),
            );
        }
    });

    it('scrubs an archived student’s markings before deleting the account, as Delete student does', () => {
        const body = sql.match(/function public\.retention_purge_archived_students[\s\S]*?\$\$;/)?.[0] ?? '';
        expect(body.indexOf('scrub_student_markings')).toBeGreaterThan(-1);
        expect(body.indexOf('scrub_student_markings')).toBeLessThan(body.indexOf('delete from auth.users'));
    });

    it('never lets a client run a purge', () => {
        for (const fn of [
            'retention_purge_archived_students (interval, int)',
            'retention_purge_stale_guests (interval, int)',
            'retention_purge_rate_limits (interval)',
            'retention_purge_support_messages (interval)',
        ]) {
            const escaped = fn.replace(/[()]/g, '\\$&');
            expect(sql).toMatch(
                new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated;`),
            );
        }
    });
});

/**
 * 20261021120500 replaces the two account purges: each candidate is locked
 * (FOR UPDATE SKIP LOCKED) and re-checked in a statement of its own before it
 * is purged, so a restore or a returning guest after the list was read is
 * kept. The race itself is proven by tests/sql/launch_consent_concurrency.mjs.
 */
describe('retention re-checks each candidate under its lock', () => {
    const recheck = readFileSync(
        resolve(process.cwd(), 'supabase/migrations/20261021120500_retention_recheck_under_lock.sql'),
        'utf8',
    );
    const body = (fn: string): string =>
        recheck.match(new RegExp(`function public\\.${fn} \\([\\s\\S]*?\\$\\$;`))?.[0] ?? '';

    it.each([
        [
            'retention_purge_archived_students',
            'm.archived_at is not null',
            'delete from auth.users where id = v_student',
        ],
        [
            'retention_purge_stale_guests',
            'public.retention_guest_last_active (u.id) < v_cutoff',
            'delete from auth.users where id = candidate.id',
        ],
    ])('%s locks, re-tests eligibility, then deletes', (fn, condition, del) => {
        const b = body(fn);
        const lock = b.indexOf('skip locked');
        // The eligibility test appears twice: in the list and again in the lock.
        expect(b.split(condition).length - 1).toBe(2);
        expect(lock).toBeGreaterThan(b.lastIndexOf(condition));
        expect(b.indexOf(del)).toBeGreaterThan(lock);
        expect(b).toMatch(/if not found then\s+continue;/);
    });

    it('keeps the same defaults and stays the service role’s alone', () => {
        expect(body('retention_purge_archived_students')).toContain(
            "p_older_than interval default interval '12 months'",
        );
        expect(body('retention_purge_stale_guests')).toContain("p_idle interval default interval '90 days'");
        for (const fn of [
            'retention_purge_archived_students (interval, int)',
            'retention_purge_stale_guests (interval, int)',
            'retention_guest_last_active (uuid)',
        ]) {
            expect(recheck).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`);
        }
    });
});
