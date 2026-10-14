/**
 * Ending a provisioned student's open sessions, for student-provision's
 * 'archive' and 'reset'.
 *
 * NO imports, like loginThrottle.ts: Deno loads it with the `.ts` extension and
 * vitest without, so what the function runs is what the tests pin. The client
 * is anything with supabase-js's `rpc` shape (the service-role client).
 *
 * Why it is needed at all. Archiving bans the account and resetting scrambles
 * the password, and both stop the NEXT sign-in — but a device already signed in
 * holds an access token PostgREST honours until it expires, and (for a reset,
 * where nothing is banned) a refresh token that mints new ones indefinitely.
 * end_student_sessions (migration 20261010120300) stamps the roster row, which
 * document_role() then reads as "a token issued before this no longer stands
 * for a sign-in", deletes the student's sessions and refresh tokens so no
 * device can mint a newer one, and pings every score the student has open so
 * the viewer re-checks its access at once.
 */

export interface SessionsRpcClient {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

export type EndSessionsResult = { ok: true; ended: number } | { ok: false; message: string };

const messageOf = (error: unknown): string =>
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error);

/**
 * Ends every session `studentUserId` has. Never throws: a transport failure is
 * an `ok: false` like a refusal, so each caller decides how loud to be.
 */
export const endStudentSessions = async (
    client: SessionsRpcClient,
    studentUserId: string,
): Promise<EndSessionsResult> => {
    try {
        const { data, error } = await client.rpc('end_student_sessions', { p_student: studentUserId });
        if (error) {
            return { ok: false, message: messageOf(error) };
        }
        return { ok: true, ended: typeof data === 'number' ? data : 0 };
    } catch (err) {
        return { ok: false, message: messageOf(err) };
    }
};
