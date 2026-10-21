// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { attestationFor } from '@/features/roster/rosterService';
import {
    readTeacherAttestation,
    teacherAttestationText,
    TEACHER_ATTESTATION_VERSION,
} from '../../supabase/functions/_shared/consentAge';

/**
 * What student-provision accepts as a teacher vouching for a student's age, and
 * that it asks on every path that admits a student.
 *
 * student-provision itself cannot load under vitest (it calls Deno.serve at
 * module scope), so its wiring is read as source below, the way
 * tests/security/functionGrants.test.ts reads migrations: a drift guard over
 * the committed code, not an execution of it.
 */

const valid = (country: string, countryName: string, age: number) => ({
    country,
    countryName,
    confirmed: true,
    wording: teacherAttestationText(age, countryName),
    version: TEACHER_ATTESTATION_VERSION,
});

describe('readTeacherAttestation', () => {
    it('accepts the sentence for the country’s own age, and reports that age', () => {
        expect(readTeacherAttestation(valid('de', 'Germany', 16))).toEqual({
            ok: true,
            attestation: {
                country: 'DE',
                minAge: 16,
                wording: 'I confirm this student is at least 16 years old, the minimum age to use Cleffy in Germany.',
                version: TEACHER_ATTESTATION_VERSION,
            },
        });
    });

    it('is exactly what the browser builds', () => {
        const built = attestationFor('FR', 'France');
        expect(readTeacherAttestation(built)).toMatchObject({ ok: true, attestation: { country: 'FR', minAge: 15 } });
    });

    it('refuses a missing or unticked attestation', () => {
        expect(readTeacherAttestation(undefined)).toMatchObject({
            ok: false,
            status: 400,
            code: 'attestation_required',
        });
        expect(readTeacherAttestation({ ...valid('US', 'United States', 13), confirmed: false })).toMatchObject({
            ok: false,
            code: 'attestation_unconfirmed',
        });
        expect(readTeacherAttestation({ ...valid('US', 'United States', 13), confirmed: 'yes' })).toMatchObject({
            ok: false,
            code: 'attestation_unconfirmed',
        });
    });

    it('refuses a country that is not a two-letter code, or has no name', () => {
        expect(readTeacherAttestation({ ...valid('US', 'United States', 13), country: 'USA' })).toMatchObject({
            ok: false,
            code: 'attestation_country',
        });
        expect(readTeacherAttestation({ ...valid('US', 'United States', 13), countryName: '' })).toMatchObject({
            ok: false,
            code: 'attestation_country',
        });
    });

    it('refuses wording that names a lower age than the country requires', () => {
        // An old build, or a hand-written request, vouching for 13 in Germany.
        expect(readTeacherAttestation(valid('DE', 'Germany', 13))).toMatchObject({
            ok: false,
            status: 409,
            code: 'attestation_outdated',
        });
    });

    it('refuses another wording version, as a reload', () => {
        expect(readTeacherAttestation({ ...valid('US', 'United States', 13), version: '2020-01-01' })).toMatchObject({
            ok: false,
            status: 409,
        });
    });
});

describe('student-provision asks for it, and deletes in a safe order', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-provision/index.ts'), 'utf8');
    const body = (name: string): string => {
        const start = source.indexOf(`const ${name} = async`);
        expect(start, name).toBeGreaterThan(-1);
        const next = source.indexOf('\nconst ', start + 1);
        return source.slice(start, next === -1 ? undefined : next);
    };

    it('checks the attestation on create and restore before the seat check or any write', () => {
        for (const name of ['createStudent', 'restoreStudent']) {
            const fn = body(name);
            const check = fn.indexOf('attestationRefusal(body)');
            expect(check, name).toBeGreaterThan(-1);
            expect(check, name).toBeLessThan(fn.indexOf('checkRosterStock('));
        }
    });

    it('records the attestation and carries it into the account on both create paths', () => {
        for (const name of ['createCodeStudent', 'createEmailStudent']) {
            const fn = body(name);
            expect(fn, name).toMatch(/age_gate: ageGateOf\(attestation\)/);
            expect(fn, name).toMatch(/recordAttestation\(admin, userId, rosterId, 'create', attestation\)/);
            expect(fn, name).toMatch(/\.\.\.attestationColumns\(attestation\)/);
        }
    });

    it('scrubs a deleted student’s markings before the account goes', () => {
        const fn = body('deleteStudent');
        const scrub = fn.indexOf("rpc('scrub_student_markings'");
        expect(scrub).toBeGreaterThan(-1);
        expect(scrub).toBeLessThan(fn.indexOf('admin.auth.admin.deleteUser('));
        expect(source).toMatch(/case 'delete':\s*return await deleteStudent\(admin, userId, body\);/);
    });
});
