// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Delete student revokes and scrubs in ONE transaction, under the roster row's
 * lock. The races themselves are proven against the local stack by
 * tests/sql/launch_consent_concurrency.mjs (two psql sessions) and the SQL by
 * tests/sql/launch_consent.sql; this pins the shape both rely on, so a later
 * edit cannot quietly split the transaction again.
 */
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20261021120400_delete_student_one_transaction.sql');
const provision = read('supabase/functions/student-provision/index.ts');

const fnBody = (sql: string, name: string): string =>
    sql.match(new RegExp(`function public\\.${name} [\\s\\S]*?\\$\\$;`))?.[0] ?? '';

describe('Delete student', () => {
    it('student-provision deletes through revoke_and_scrub_student, and never scrubs on its own', () => {
        const body = provision.match(/const deleteStudent = [\s\S]*?\n};\n/)?.[0] ?? '';
        expect(body).toContain(`rpc('revoke_and_scrub_student'`);
        expect(body).not.toContain('scrub_student_markings');
        expect(body).not.toContain('endStudentSessions');
        expect(body.indexOf('revoke_and_scrub_student')).toBeLessThan(body.indexOf('deleteUser'));
    });

    it('locks the roster row, then archives, ends sessions and scrubs, in that order', () => {
        const body = fnBody(migration, 'revoke_and_scrub_student');
        const steps = ['for update', 'set archived_at', 'end_student_sessions', 'scrub_student_markings'].map((s) =>
            body.indexOf(s),
        );
        expect(steps.every((at) => at > -1)).toBe(true);
        expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    });

    it('makes every student write re-read the roster row under a share lock, per statement', () => {
        expect(fnBody(migration, 'student_write_allowed')).toMatch(/for share;/);
        for (const table of ['annotations', 'annotation_snapshots']) {
            expect(migration).toMatch(
                new RegExp(
                    `create trigger ${table}_refuse_revoked_student before insert[\\s\\S]*?on public\\.${table}\\s+for each statement`,
                ),
            );
        }
    });

    it('is the service role’s alone', () => {
        expect(migration).toMatch(
            /revoke all on function public\.revoke_and_scrub_student \(uuid\) from public, anon, authenticated;/,
        );
        expect(fnBody(migration, 'revoke_and_scrub_student')).toContain(`<> 'service_role'`);
    });
});
