import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { endStudentSessions, type SessionsRpcClient } from '../../supabase/functions/_shared/studentSessions';

/**
 * Archiving or resetting a student ends the sessions they already have open.
 *
 * The SQL half (migration 20261010120300: student_access_revoked() consulted by
 * document_role(), and end_student_sessions) is proved in a rolled-back
 * transaction by tests/sql/student_access_revocation.sql. These pin the edge
 * half: what student-provision sends, how it reads the answer, and that both
 * revoking actions actually call it, in the order that keeps a half-applied
 * reset from handing out a card while old devices stay signed in.
 */

const clientAnswering = (
    answer: { data: unknown; error: unknown } | Error,
): SessionsRpcClient & {
    rpc: ReturnType<typeof vi.fn>;
} => ({
    rpc: vi.fn(async () => {
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    }),
});

describe('endStudentSessions', () => {
    it('asks end_student_sessions for exactly this student', async () => {
        const client = clientAnswering({ data: 2, error: null });

        await expect(endStudentSessions(client, 'student-1')).resolves.toEqual({ ok: true, ended: 2 });
        expect(client.rpc).toHaveBeenCalledWith('end_student_sessions', { p_student: 'student-1' });
    });

    it('reports a refusal instead of claiming the sessions ended', async () => {
        const client = clientAnswering({ data: null, error: { message: 'not a roster student' } });

        await expect(endStudentSessions(client, 'student-1')).resolves.toEqual({
            ok: false,
            message: 'not a roster student',
        });
    });

    it('turns a dropped connection into a refusal rather than a throw', async () => {
        const client = clientAnswering(new Error('fetch failed'));

        await expect(endStudentSessions(client, 'student-1')).resolves.toEqual({ ok: false, message: 'fetch failed' });
    });
});

/** The body of one top-level `const name = async (...) => { ... };` in student-provision. */
const handlerBody = (name: string): string => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-provision/index.ts'), 'utf8');
    const start = source.indexOf(`const ${name} = async`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n};\n', start);
    return source.slice(start, end);
};

describe('student-provision ends sessions where it revokes', () => {
    it('reset: on both paths, after the scramble and before anything is handed out', () => {
        const body = handlerBody('resetStudentAccess');
        const scrambles = [...body.matchAll(/password: generateProvisionPassword\(\)/g)].map((m) => m.index ?? -1);
        const ends = [...body.matchAll(/endStudentSessions\(admin, row\.student_user_id\)/g)].map((m) => m.index ?? -1);
        // The email path and the code path each scramble, then end sessions.
        expect(scrambles).toHaveLength(2);
        expect(ends).toHaveLength(2);
        expect(ends[0]).toBeGreaterThan(scrambles[0] ?? Infinity);
        expect(ends[1]).toBeGreaterThan(scrambles[1] ?? Infinity);
        // Before the reset mail goes out, and before a new code is minted.
        expect(ends[0]).toBeLessThan(body.indexOf('signInWithOtp'));
        expect(ends[1]).toBeLessThan(body.indexOf('generateLoginCode()'));
    });

    it('archive: after the stamp and the ban', () => {
        const body = handlerBody('archiveStudent');
        const ends = body.indexOf('endStudentSessions(admin, owned.row.student_user_id)');
        expect(ends).toBeGreaterThan(body.indexOf('archived_at: new Date().toISOString()'));
        expect(ends).toBeGreaterThan(body.indexOf('ban_duration: ARCHIVE_BAN_DURATION'));
    });
});

/** The latest migration's definition of a function, as realtimeTopicsInSync reads it. */
const latestDefinition = (fn: string): string => {
    const pattern = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$\\$;`, 'i');
    const dir = resolve(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .reverse();
    for (const name of files) {
        const match = readFileSync(resolve(dir, name), 'utf8').match(pattern);
        if (match) {
            return match[0];
        }
    }
    throw new Error(`no migration defines public.${fn}`);
};

describe('document_role refuses a student whose access was withdrawn', () => {
    it('consults student_access_revoked, only for a member with a roster row', () => {
        const body = latestDefinition('document_role');
        expect(body).toMatch(/from public\.managed_students ms/);
        expect(body).toMatch(/public\.student_access_revoked \(\)/);
    });

    it('revokes for the teacher’s archive or reset, not for a session the student ended', () => {
        const body = latestDefinition('student_access_revoked');
        expect(body).toMatch(/archived_at is not null/);
        expect(body).toMatch(/'iat'/);
        expect(body).toMatch(/< v_revoked_at/);
        // GoTrue deletes every session on the student's own global sign-out:
        // a missing session row says nothing about the teacher.
        expect(body).not.toMatch(/auth\.sessions/);
    });

    it('end_student_sessions stamps the revocation, after the sessions are gone', () => {
        const body = latestDefinition('end_student_sessions');
        const stamp = body.indexOf('set access_revoked_at = clock_timestamp()');
        expect(stamp).toBeGreaterThan(body.indexOf('delete from auth.sessions'));
    });
});
