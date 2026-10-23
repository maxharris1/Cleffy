import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CHECKOUT_ATTEMPT_STALE_AFTER } from '../../supabase/functions/_shared/checkoutFlow';
import {
    ACCOUNT_DELETION_PENDING,
    accountDeletionPending,
    DELETION_CHECK_UNAVAILABLE,
} from '../../supabase/functions/_shared/deletionPending';

/**
 * The deletion-pending marker (20261022110100_account_deletion_pending.sql)
 * from the two Deno entry points vitest cannot load: delete-account binds the
 * ports accountDeletion.test.ts drives, and student-provision refuses a new
 * student for a teacher whose account is being deleted before it creates any
 * auth account. tests/sql/account_deletion_pending.sql proves the SQL.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** `check` comes before `first` in `body`, and both exist. */
const before = (body: string, check: string, first: string) => {
    const at = body.indexOf(check);
    expect(at, check).toBeGreaterThan(-1);
    expect(body.indexOf(first), first).toBeGreaterThan(at);
};

describe('deletion-pending wiring', () => {
    it('delete-account binds the marker ports to their RPCs', () => {
        const source = read('supabase/functions/delete-account/index.ts');
        expect(source).toContain("admin.rpc('begin_account_deletion_attempt', { p_user: userId })");
        expect(source).toContain("admin.rpc('mark_account_deletion_destructive', {");
        expect(source).toContain("admin.rpc('settle_account_deletion_attempt', {");
        expect(source).toContain('p_attempt: attempt');
    });

    it('student-provision registers its intent (refused while deletion is pending) before any Auth account exists', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        const create = source.slice(source.indexOf('const createStudent = async'));
        const begin = create.indexOf("admin.rpc('begin_student_provision'");
        expect(begin).toBeGreaterThan(-1);
        expect(begin).toBeLessThan(create.indexOf('createCodeStudent('));
        expect(begin).toBeLessThan(create.indexOf('createEmailStudent('));
        expect(create.slice(begin, begin + 900)).toContain('jsonResponse(DELETION_PENDING, 409)');
        expect(create.slice(begin, begin + 400)).toContain('syntheticStudentEmail(rosterId)');
    });

    it('student-provision records the new Auth account on its intent before the roster insert, and undoes it if swept', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        for (const [fn, creator] of [
            ['const createCodeStudent = async', 'admin.auth.admin.createUser('],
            ['const createEmailStudent = async', 'admin.auth.admin.inviteUserByEmail('],
        ] as const) {
            const body = source.slice(source.indexOf(fn));
            const created = body.indexOf(creator);
            const attached = body.indexOf('await attachProvision(admin, rosterId,');
            const inserted = body.indexOf(".from('managed_students').insert(");
            expect(created).toBeGreaterThan(-1);
            expect(attached).toBeGreaterThan(created);
            expect(attached).toBeLessThan(inserted);
            expect(body.slice(attached, attached + 400)).toContain('await undoCreatedStudent(admin,');
        }
        // An undo that worked clears the intent; one that failed leaves it naming the orphan.
        const undo = source.slice(source.indexOf('const undoCreatedStudent = async'));
        expect(undo.slice(0, 500)).toMatch(/if \(error\) \{[\s\S]*?return;[\s\S]*?finishProvision\(admin, rosterId\)/);
    });

    it('student-provision answers the trigger’s refusal as the same 409, after undoing the account', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        expect(source.match(/isDeletionPending\(insertError\)/g)).toHaveLength(2);
        for (const at of [...source.matchAll(/isDeletionPending\(insertError\)/g)].map((m) => m.index ?? 0)) {
            const before = source.slice(Math.max(0, at - 600), at);
            expect(before).toContain('admin.auth.admin.deleteUser(');
        }
    });

    it('delete-account binds the barrier ports: checkout in flight, provisioning intents', () => {
        const source = read('supabase/functions/delete-account/index.ts');
        expect(source).toContain("admin.rpc('checkout_attempt_in_flight', { p_user: userId })");
        // The variant with proof (A), 20261022140400: nothing else is deleted on.
        expect(source).toContain("admin.rpc('student_provision_intents_proven', { p_teacher: teacherId })");
        expect(source).toContain("admin.rpc('finish_student_provision', { p_roster_id: rosterId })");
    });

    it('stripe-checkout reads the barrier’s refusal of the lease as deletion_pending, not a failure', () => {
        const source = read('supabase/functions/stripe-checkout/index.ts');
        const begin = source.slice(source.indexOf('beginAttempt: async'));
        expect(begin.slice(0, 1500)).toMatch(/error\.code === '55000' && \/account_deletion_pending\//);
        expect(begin.slice(0, 1500)).toContain("reason: 'deletion_pending'");
    });

    it('the barrier covers Storage writes in both buckets, memberships, checkout leases and provisioning', () => {
        const sql = read('supabase/migrations/20261022110600_account_deletion_barrier.sql');
        for (const op of ['insert', 'update']) {
            expect(sql).toMatch(
                new RegExp(
                    `storage_refuse_during_account_deletion_${op} on storage\\.objects as restrictive for ${op}`,
                ),
            );
        }
        expect(sql).toContain("bucket_id not in ('scores', 'thumbnails')");
        expect(sql).toMatch(/before insert on public\.document_members\s+for each row execute function/);
        expect(sql).toMatch(/before insert or update on public\.checkout_attempts\s+for each row execute function/);
        expect(sql).toMatch(
            /after insert on public\.managed_students\s+for each row execute function public\.clear_student_provision_intent/,
        );
    });

    it('the in-flight check uses the lease length checkout itself uses', () => {
        const sql = read('supabase/migrations/20261022110600_account_deletion_barrier.sql');
        const fn = sql.slice(sql.indexOf('function public.checkout_attempt_in_flight'));
        expect(fn.slice(0, 600)).toContain(`interval '${CHECKOUT_ATTEMPT_STALE_AFTER}'`);
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

describe('service-role writers ask account_deletion_pending() first (Codex r2 on #70)', () => {
    const rpcAnswering = (answer: { data: unknown; error: unknown } | Error) =>
        vi.fn(async () => {
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        });

    it('the helper asks the one predicate, and fails closed', async () => {
        const pending = rpcAnswering({ data: true, error: null });
        expect(await accountDeletionPending({ rpc: pending }, 'user-1')).toEqual({ ok: true, pending: true });
        expect(pending).toHaveBeenCalledWith('account_deletion_pending', { p_user: 'user-1' });
        expect(await accountDeletionPending({ rpc: rpcAnswering({ data: false, error: null }) }, 'u')).toEqual({
            ok: true,
            pending: false,
        });
        // Only a literal true is pending; an error or a throw is no answer at all.
        expect(await accountDeletionPending({ rpc: rpcAnswering({ data: null, error: null }) }, 'u')).toEqual({
            ok: true,
            pending: false,
        });
        expect(
            await accountDeletionPending({ rpc: rpcAnswering({ data: null, error: { message: 'boom' } }) }, 'u'),
        ).toEqual({ ok: false, message: 'boom' });
        expect(await accountDeletionPending({ rpc: rpcAnswering(new Error('down')) }, 'u')).toEqual({
            ok: false,
            message: 'down',
        });
        expect(ACCOUNT_DELETION_PENDING.code).toBe('account_deletion_pending');
    });

    it('student-provision: before any action runs (Auth writes no trigger can refuse)', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        const serve = source.slice(source.indexOf('Deno.serve('));
        before(serve, 'await accountDeletionPending(admin, userId)', 'switch (body.action)');
        expect(serve).toContain('jsonResponse(ACCOUNT_DELETION_PENDING, 409)');
    });

    it('stripe-checkout: before the lease, and so before any Stripe customer or session', () => {
        const source = read('supabase/functions/stripe-checkout/index.ts');
        const begin = source.slice(source.indexOf('beginAttempt: async'));
        before(begin, 'await accountDeletionPending(billing(mode).admin, userId)', "rpc('begin_checkout_attempt'");
        expect(begin.slice(0, 900)).toContain(
            "if (pending.pending) {\n                return { ok: false, reason: 'deletion_pending' };",
        );
    });

    it('imslp-download: before the import runs (quota, licence cache, documents row, upload)', () => {
        const source = read('supabase/functions/imslp-download/index.ts');
        before(source, 'await accountDeletionPending(admin, userId)', 'await runImslpImport(');
        expect(source).toContain('jsonResponse(ACCOUNT_DELETION_PENDING, 409)');
    });

    it('score-analyze: before the owner is metered or a job is enqueued for them', () => {
        const source = read('supabase/functions/score-analyze/index.ts');
        before(source, 'await accountDeletionPending(admin, doc.owner_id as string)', 'await enforce(admin');
        before(source, 'await accountDeletionPending(admin, doc.owner_id as string)', "rpc('omr_enqueue_job'");
    });

    it('a failed check is a refusal, never a pass', () => {
        for (const path of [
            'supabase/functions/student-provision/index.ts',
            'supabase/functions/stripe-checkout/index.ts',
            'supabase/functions/imslp-download/index.ts',
            'supabase/functions/score-analyze/index.ts',
            'supabase/functions/student-claim/index.ts',
        ]) {
            const source = read(path);
            const at = source.indexOf('await accountDeletionPending(');
            expect(source.slice(at, at + 400), path).toMatch(/if \(!pending\.ok\) \{[\s\S]{0,250}?return /);
        }
    });

    it('a failed check is a 503 with a retry message, not a bare 502 (decision 60(b))', () => {
        expect(DELETION_CHECK_UNAVAILABLE.code).toBe('deletion_check_unavailable');
        expect(DELETION_CHECK_UNAVAILABLE.error).toMatch(/try again in a minute/i);
        for (const path of [
            'supabase/functions/student-provision/index.ts',
            'supabase/functions/imslp-download/index.ts',
            'supabase/functions/score-analyze/index.ts',
        ]) {
            const source = read(path);
            const sites = [...source.matchAll(/await accountDeletionPending\(/g)].map((m) => m.index ?? 0);
            expect(sites.length, path).toBeGreaterThan(0);
            for (const at of sites) {
                // What the `!pending.ok` branch returns: the 503 itself, or a
                // port's 'unknown' that the code using it answers with one.
                const returned = /if \(!pending\.ok\) \{[\s\S]*?return ([^;]*);/.exec(source.slice(at, at + 500))?.[1];
                expect(returned, path).toMatch(
                    /^jsonResponse\(\{? ?(?:ok: false, \.\.\.)?DELETION_CHECK_UNAVAILABLE(?: \})?, 503\)$|^'unknown'$/,
                );
            }
        }
        const provision = read('supabase/functions/student-provision/index.ts');
        expect(provision).toContain(
            "case 'deletion_unknown':\n            return jsonResponse({ ...DELETION_CHECK_UNAVAILABLE, resetToken: outcome.resetToken }, 503);",
        );
        // stripe-checkout hands the failure to checkoutFlow, which answers 503.
        const checkout = read('supabase/functions/stripe-checkout/index.ts');
        const begin = checkout.slice(checkout.indexOf('beginAttempt: async'));
        expect(begin.slice(0, 900)).toContain("reason: 'deletion_check_failed'");
        const flow = read('supabase/functions/_shared/checkoutFlow.ts');
        expect(flow).toMatch(
            /start\.reason === 'deletion_check_failed'\) \{[\s\S]{0,160}?deps\.json\(CHECKOUT_DELETION_CHECK_UNAVAILABLE, 503\)/,
        );
        // student-claim's handler answers the port's 'unknown' with its own 503.
        const claim = read('supabase/functions/student-claim/handler.ts');
        expect(claim).toContain('json(CLAIM_CHECK_UNAVAILABLE, 503)');
    });
});

describe('the deletion check is asked again right before the later Auth writes (decision 61)', () => {
    it('student-provision: before the reset scramble on both paths, and before the restore unban', () => {
        const source = read('supabase/functions/student-provision/index.ts');
        const reset = source.slice(
            source.indexOf('const resetStudentAccess = async'),
            source.indexOf('const archiveStudent'),
        );
        // Both paths run the worker now (the email one since 20261022140800),
        // which asks right before its scramble (below); the email ports are the
        // code ports' with their deletion check.
        expect(reset).toContain('runCodeReset(emailResetPorts(admin, userId)');
        expect(source).toContain('...codeResetPorts(admin, userId),');
        expect(reset).not.toContain('admin.auth.admin.updateUserById(row.student_user_id, {');
        const restore = source.slice(source.indexOf('const restoreStudent = async'));
        before(restore, 'await deletionRefusal(admin, userId)', "ban_duration: 'none'");
        // The code path: the worker's port, asked after the reservation and before the first fence.
        const ports = source.slice(
            source.indexOf('const codeResetPorts = '),
            source.indexOf('const resetStudentAccess'),
        );
        expect(ports).toMatch(
            /deletionPending: async \(\) => \{\s+const pending = await accountDeletionPending\(admin, userId\);/,
        );
        const worker = read('supabase/functions/_shared/studentCodeReset.ts');
        const run = worker.slice(worker.indexOf('export const runCodeReset'));
        before(run, 'await ports.reserveReset(', 'await ports.deletionPending()');
        before(run, 'await ports.deletionPending()', 'await fenced(ports, studentId, lease)');
    });

    it('student-claim: for the card’s teacher, after the reservation and before the password write', () => {
        const index = read('supabase/functions/student-claim/index.ts');
        const port = index.slice(index.indexOf('teacherDeletionPending: async'));
        expect(port.slice(0, 800)).toContain(".select('teacher_id')");
        expect(port.slice(0, 800)).toContain('await accountDeletionPending(admin, data.teacher_id as string)');
        const handler = read('supabase/functions/student-claim/handler.ts');
        const flow = handler.slice(handler.indexOf('export const handleStudentClaim'));
        before(flow, 'await backend.reserveClaim(', 'await backend.teacherDeletionPending(studentId)');
        before(flow, 'await backend.teacherDeletionPending(studentId)', 'await backend.setPassword(');
    });
});
