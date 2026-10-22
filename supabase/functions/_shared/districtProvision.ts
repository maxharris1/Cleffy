/**
 * Which district, if any, a new roster student is provisioned for.
 *
 * A student belongs to a district only on positive evidence: the provisioning
 * call names the district (`districtStudioId`), and the teacher owns or holds a
 * seat in that district studio right now
 * (20261021120800_district_student_attribution.sql). Holding a seat is NOT that
 * evidence on its own — a seated teacher keeps a private studio of their own,
 * and a call that names no district provisions a private student, whom the
 * district's contract-end purge never touches.
 *
 * The database trigger enforces the same rule on every insert. Asking here
 * first is what turns a refusal into a 403 before any auth account is created,
 * instead of a 502 after one has to be undone.
 *
 * NO imports, so vitest and Deno load this exact file.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DistrictChoice =
    { ok: true; districtStudioId: string | null } | { ok: false; status: 400 | 403 | 502; code: string; error: string };

/** Absent (or null) is a private student; anything else must be a studio id. */
export const readDistrictChoice = (input: unknown): DistrictChoice => {
    if (input === undefined || input === null) {
        return { ok: true, districtStudioId: null };
    }
    if (typeof input !== 'string' || !uuidRe.test(input.trim())) {
        return { ok: false, status: 400, code: 'invalid_district', error: 'districtStudioId must be a UUID' };
    }
    return { ok: true, districtStudioId: input.trim().toLowerCase() };
};

/** The one RPC this needs, so a test can stand in for the service-role client. */
export interface DistrictRpc {
    rpc(
        fn: 'district_provisionable',
        args: { p_teacher: string; p_studio: string },
    ): PromiseLike<{ data: boolean | null; error: { message: string } | null }>;
}

/**
 * Proves the teacher may provision into the district they named. A private
 * student needs no proof, and spends no query.
 */
export const checkDistrictChoice = async (
    admin: DistrictRpc,
    teacherId: string,
    input: unknown,
): Promise<DistrictChoice> => {
    const choice = readDistrictChoice(input);
    if (!choice.ok || choice.districtStudioId === null) {
        return choice;
    }
    const { data, error } = await admin.rpc('district_provisionable', {
        p_teacher: teacherId,
        p_studio: choice.districtStudioId,
    });
    if (error) {
        // Fail closed: an unanswerable check must not attribute a student.
        return { ok: false, status: 502, code: 'district_unavailable', error: 'Could not check the district' };
    }
    if (data !== true) {
        return {
            ok: false,
            status: 403,
            code: 'not_in_district',
            error: 'You can only add students for a district you own or hold a seat in.',
        };
    }
    return choice;
};
