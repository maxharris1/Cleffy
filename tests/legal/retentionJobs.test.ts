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
