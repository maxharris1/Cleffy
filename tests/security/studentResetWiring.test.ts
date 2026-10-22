import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * student-provision's code reset (a Deno entry point vitest cannot load)
 * against 20261022110500_student_code_reset_holder.sql and
 * 20261022110700_student_code_reset_worker.sql (and 20261022110800's
 * quarantine): the worker in
 * ../_shared/studentCodeReset.ts does the reset (tests/security/studentClaim.test.ts
 * drives its interleavings); the entry point only binds its ports and maps the
 * outcome. tests/sql/student_claim_reservation.sql proves the SQL.
 */
const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-provision/index.ts'), 'utf8');
const reset = source.slice(source.indexOf('const resetStudentAccess = async'), source.indexOf('const archiveStudent'));
const codePath = reset.slice(reset.indexOf('const resumeToken'));
const ports = source.slice(
    source.indexOf('const codeResetPorts = '),
    source.indexOf('const resetStudentAccess = async'),
);
const worker = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/studentCodeReset.ts'), 'utf8');

describe('student-provision code reset wiring', () => {
    it('runs the code path through runCodeReset, resuming only with a well-formed token', () => {
        expect(codePath).toContain('runCodeReset(codeResetPorts(admin, userId)');
        expect(reset).toContain('uuidRe.test(body.resetToken)');
        // No Auth or code write of its own on the code path.
        expect(codePath).not.toContain('updateUserById');
        expect(codePath).not.toContain('endStudentSessions(');
        expect(codePath).not.toMatch(/update\(\{\s*login_code_hash/);
    });

    it('every port passes the worker lease: fence, complete and stop carry worker and epoch', () => {
        expect(ports).toContain("admin.rpc('reserve_student_code_reset'");
        for (const rpc of [
            'fence_student_code_reset',
            'complete_student_code_reset',
            'stop_student_code_reset_worker',
        ]) {
            const at = ports.indexOf(`admin.rpc('${rpc}'`);
            expect(at).toBeGreaterThan(-1);
            const call = ports.slice(at, ports.indexOf('});', at));
            expect(call).toContain('p_worker: lease.worker');
            expect(call).toContain('p_epoch: lease.epoch');
        }
        expect(ports).toContain('password: generateProvisionPassword()');
        expect(source).not.toContain('begin_student_code_reset');
        // The session revocation checks the lease in its own transaction.
        expect(ports).toContain('endStudentSessionsFenced(admin, studentId, lease)');
        expect(ports).not.toContain('endStudentSessions(admin');
    });

    it('the scramble carries its worker marker, and only a definite refusal counts as one', () => {
        const scramble = ports.slice(ports.indexOf('scramblePassword: async'), ports.indexOf('passwordWriteLanded:'));
        expect(scramble).toContain('password: generateProvisionPassword()');
        expect(scramble).toContain('app_metadata: { [MARKER_KEY]: lease.worker }');
        expect(scramble).toContain('definite: definiteRefusal((error as { status?: unknown }).status)');
        const landed = ports.slice(ports.indexOf('passwordWriteLanded: async'), ports.indexOf('endSessions:'));
        expect(landed).toContain('admin.auth.admin.getUserById(studentUserId)');
        expect(landed).toContain('app_metadata?.[MARKER_KEY] === worker');
    });

    it('an ambiguous password write is quarantined: no report-back unless it is seen to have landed', () => {
        const run = worker.slice(worker.indexOf('export const runCodeReset'));
        const failed = run.slice(run.indexOf('if (!scrambled.ok) {'), run.indexOf('const beforeSessions'));
        expect(failed).toMatch(/if \(scrambled\.definite\) \{\s+return incomplete\(\);/);
        expect(failed).toMatch(
            /if \(!\(await landed\(ports, studentUserId, lease\.worker\)\)\) \{\s+return \{ kind: 'unconfirmed'/,
        );
        expect(failed.match(/incomplete\(\)/g)).toHaveLength(1);
        expect(codePath).toContain("code: 'reset_unconfirmed', resetToken: outcome.resetToken");
        expect(source).toMatch(
            /RESET_UNCONFIRMED_MESSAGE =\s+'[^']*held for up to 10 minutes\. Try the reset again in a few minutes\./,
        );
    });

    it('the worker fences immediately before each Auth side effect', () => {
        const run = worker.slice(worker.indexOf('export const runCodeReset'));
        const scramble = run.indexOf('ports.scramblePassword(');
        const sessions = run.indexOf('ports.endSessions(');
        const fences = [...run.matchAll(/await fenced\(ports, studentId, lease\)/g)].map((m) => m.index ?? -1);
        expect(fences).toHaveLength(2);
        expect(fences[0]).toBeLessThan(scramble);
        expect(fences[1]).toBeGreaterThan(scramble);
        expect(fences[1]).toBeLessThan(sessions);
        expect(run.indexOf('ports.complete(')).toBeGreaterThan(sessions);
    });

    it('a live reset or claim is refused, not taken over; a fenced-out try says so', () => {
        expect(codePath).toContain("code: 'reset_in_progress'");
        expect(codePath).toContain("code: 'claim_in_progress'");
        expect(codePath).toContain("code: 'reset_lost'");
    });

    it('a part-way failure keeps the hold, says it lasts up to 10 minutes, and returns the token', () => {
        expect(source).toMatch(/RESET_INCOMPLETE_MESSAGE =\s+'[^']*held for up to 10 minutes/);
        expect(codePath).toContain("code: 'reset_incomplete', resetToken: outcome.resetToken");
        expect(source).not.toMatch(/release_student_code_reset/);
    });
});
