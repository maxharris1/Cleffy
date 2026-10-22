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
 * A district whose data is being deleted (its contract ended and the purge has
 * soft deleted it: 20261022130300_district_retention_late_students.sql) takes
 * no new students, its own teachers' included: a 409, code
 * `district_deletion_pending`, in the account-deletion barrier's style. The
 * trigger refuses the insert the same way if the purge begins after this check
 * (student-provision answers that with the same 409).
 *
 * NO imports, so vitest and Deno load this exact file.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DistrictChoice =
    | { ok: true; districtStudioId: string | null }
    | { ok: false; status: 400 | 403 | 409 | 502; code: string; error: string };

/**
 * The refusal while the district is being deleted, with the code the roster
 * trigger's refusal carries (SQLSTATE 55000, 'district_deletion_pending').
 */
export const DISTRICT_DELETION_PENDING = {
    error: 'This district is being deleted, so no new students can be added to it.',
    code: 'district_deletion_pending',
} as const;

/** Whether a roster insert was refused by the district barrier (the trigger). */
export const isDistrictDeletionPending = (error: { code?: string; message?: string } | null): boolean =>
    error?.code === '55000' && /district_deletion_pending/.test(error.message ?? '');

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

/** The two RPCs this needs, so a test can stand in for the service-role client. */
export interface DistrictRpc {
    rpc(
        fn: 'district_provisionable',
        args: { p_teacher: string; p_studio: string },
    ): PromiseLike<{ data: boolean | null; error: { message: string } | null }>;
    rpc(
        fn: 'district_provision_refusal',
        args: { p_teacher: string; p_studio: string },
    ): PromiseLike<{ data: string | null; error: { message: string } | null }>;
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
        // Why not: asked only when refused, and told only to the district's
        // own teachers (district_provision_refusal() answers anyone else
        // 'not_in_district').
        const why = await admin.rpc('district_provision_refusal', {
            p_teacher: teacherId,
            p_studio: choice.districtStudioId,
        });
        if (why.error) {
            return { ok: false, status: 502, code: 'district_unavailable', error: 'Could not check the district' };
        }
        if (why.data === 'district_deletion_pending') {
            return { ok: false, status: 409, ...DISTRICT_DELETION_PENDING };
        }
        return {
            ok: false,
            status: 403,
            code: 'not_in_district',
            error: 'You can only add students for a district you own or hold a seat in.',
        };
    }
    return choice;
};
