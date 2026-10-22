import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The deletion-pending marker (20261022110100_account_deletion_pending.sql)
 * from the two Deno entry points vitest cannot load: delete-account binds the
 * ports accountDeletion.test.ts drives, and student-provision refuses a new
 * student for a teacher whose account is being deleted before it creates any
 * auth account. tests/sql/account_deletion_pending.sql proves the SQL.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('deletion-pending wiring', () => {
    it('delete-account binds the marker ports to their RPCs', () => {
        const source = read('supabase/functions/delete-account/index.ts');
        expect(source).toContain("admin.rpc('begin_account_deletion_attempt', { p_user: userId })");
        expect(source).toContain("admin.rpc('mark_account_deletion_destructive', {");
        expect(source).toContain("admin.rpc('settle_account_deletion_attempt', {");
        expect(source).toContain('p_attempt: attempt');
    });

    it('student-provision checks the marker before it creates any student account', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        const create = source.slice(source.indexOf('const createStudent = async'));
        const check = create.indexOf("admin.rpc('account_deletion_pending'");
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(create.indexOf('createCodeStudent('));
        expect(check).toBeLessThan(create.indexOf('createEmailStudent('));
        expect(create.slice(check, check + 600)).toContain('jsonResponse(DELETION_PENDING, 409)');
    });

    it('student-provision answers the trigger’s refusal as the same 409, after undoing the account', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        expect(source.match(/isDeletionPending\(insertError\)/g)).toHaveLength(2);
        for (const at of [...source.matchAll(/isDeletionPending\(insertError\)/g)].map((m) => m.index ?? 0)) {
            const before = source.slice(Math.max(0, at - 600), at);
            expect(before).toContain('admin.auth.admin.deleteUser(');
        }
    });

    it('the triggers cover both tables a deletion sweeps', () => {
        const sql = read('supabase/migrations/20261022110100_account_deletion_pending.sql');
        expect(sql).toMatch(
            /before insert on public\.documents\s+for each row execute function public\.refuse_insert_during_account_deletion/,
        );
        expect(sql).toMatch(
            /before insert on public\.managed_students\s+for each row execute function public\.refuse_insert_during_account_deletion/,
        );
    });
});
