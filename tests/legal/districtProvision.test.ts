// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
    checkDistrictChoice,
    type DistrictRpc,
    readDistrictChoice,
} from '../../supabase/functions/_shared/districtProvision';

/**
 * Which district a new roster student is provisioned for (Codex round 3, #64):
 * only the one the provisioning call names, and only if the teacher owns or is
 * seated in it. Holding a seat is never evidence on its own. The database side
 * of the same rule is proven by tests/sql/district_student_scope.sql.
 */
const DISTRICT = 'e2000000-0000-4000-8000-0000000005da';

const rpcAnswering = (data: boolean | null, error: { message: string } | null = null) => {
    const rpc = vi.fn(async () => ({ data, error }));
    return { client: { rpc } as unknown as DistrictRpc, rpc };
};

describe('the district a student is provisioned for', () => {
    it('is none unless the call names one: a seated teacher’s student is private by default', async () => {
        const { client, rpc } = rpcAnswering(true);
        expect(await checkDistrictChoice(client, 'teacher', undefined)).toEqual({ ok: true, districtStudioId: null });
        expect(await checkDistrictChoice(client, 'teacher', null)).toEqual({ ok: true, districtStudioId: null });
        // No query is spent proving a private student.
        expect(rpc).not.toHaveBeenCalled();
    });

    it('is the named district when the teacher owns or holds a seat in it', async () => {
        const { client, rpc } = rpcAnswering(true);
        expect(await checkDistrictChoice(client, 'teacher', ` ${DISTRICT.toUpperCase()} `)).toEqual({
            ok: true,
            districtStudioId: DISTRICT,
        });
        expect(rpc).toHaveBeenCalledWith('district_provisionable', { p_teacher: 'teacher', p_studio: DISTRICT });
    });

    it('refuses a district the teacher is not in, before any account is created', async () => {
        const { client } = rpcAnswering(false);
        expect(await checkDistrictChoice(client, 'teacher', DISTRICT)).toMatchObject({
            ok: false,
            status: 403,
            code: 'not_in_district',
        });
    });

    it('fails closed when the check cannot be answered', async () => {
        const { client } = rpcAnswering(null, { message: 'down' });
        expect(await checkDistrictChoice(client, 'teacher', DISTRICT)).toMatchObject({ ok: false, status: 502 });
        const { client: silent } = rpcAnswering(null);
        expect(await checkDistrictChoice(silent, 'teacher', DISTRICT)).toMatchObject({ ok: false, status: 403 });
    });

    it('refuses anything that is not a studio id', () => {
        for (const bad of ['', 'district-a', 42, {}, [DISTRICT], true]) {
            expect(readDistrictChoice(bad)).toMatchObject({ ok: false, status: 400, code: 'invalid_district' });
        }
    });
});
