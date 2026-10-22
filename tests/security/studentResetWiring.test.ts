import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * student-provision's code reset (a Deno entry point vitest cannot load)
 * against 20261022110500_student_code_reset_holder.sql: it reserves with a
 * holder token before anything is revoked, writes the new code only through
 * that token, and hands the token back when it fails part-way.
 * tests/sql/student_claim_reservation.sql proves the SQL;
 * tests/security/studentClaim.test.ts drives the interleavings.
 */
const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-provision/index.ts'), 'utf8');
const reset = source.slice(source.indexOf('const resetStudentAccess = async'), source.indexOf('const archiveStudent'));
const codePath = reset.slice(reset.indexOf("admin.rpc('reserve_student_code_reset'"));

describe('student-provision code reset wiring', () => {
    it('reserves with a holder token before the scramble, and resumes only with its own token', () => {
        const reserve = reset.indexOf("admin.rpc('reserve_student_code_reset'");
        expect(reserve).toBeGreaterThan(-1);
        expect(reserve).toBeLessThan(reset.lastIndexOf('password: generateProvisionPassword()'));
        expect(codePath).toContain('p_reservation: resumeToken');
        expect(reset).toContain('uuidRe.test(body.resetToken)');
    });

    it('writes the new code only through complete_student_code_reset, never a direct update', () => {
        expect(codePath).toContain("admin.rpc('complete_student_code_reset'");
        expect(codePath).toContain('p_reservation: resetToken');
        expect(codePath).not.toMatch(/update\(\{\s*login_code_hash/);
        expect(codePath.indexOf("admin.rpc('complete_student_code_reset'")).toBeGreaterThan(
            codePath.indexOf('endStudentSessions('),
        );
    });

    it('a live reset or claim is refused, not taken over', () => {
        expect(codePath).toContain("code: 'reset_in_progress'");
        expect(codePath).toContain("code: 'claim_in_progress'");
        expect(source).not.toContain('begin_student_code_reset');
    });

    it('a part-way failure keeps the hold, says it lasts up to 10 minutes, and returns the token', () => {
        expect(source).toMatch(/RESET_INCOMPLETE_MESSAGE =\s+'[^']*held for up to 10 minutes/);
        expect(codePath).toContain("code: 'reset_incomplete'");
        expect(codePath).toContain('resetToken,');
        // Every failure after the reservation goes through incomplete().
        const afterReserve = codePath.slice(codePath.indexOf('const incomplete'));
        expect(afterReserve.match(/return incomplete\(\);/g)).toHaveLength(3);
        expect(afterReserve).not.toMatch(/release_student_code_reset/);
    });
});
