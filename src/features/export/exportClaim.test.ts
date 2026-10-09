import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EntitlementsServiceModule from '@/features/billing/entitlementsService';

import { FREE_LIMITS } from '@/features/billing/entitlementsService';
import type { Entitlements } from '@/types/database';

const rpc = vi.fn();
const readCachedEntitlements = vi.fn();

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));

// Only the Dexie read is replaced; isUnlimited and FREE_LIMITS stay real.
vi.mock('@/features/billing/entitlementsService', async (importOriginal) => ({
    ...(await importOriginal<typeof EntitlementsServiceModule>()),
    readCachedEntitlements: (...args: unknown[]) => readCachedEntitlements(...args),
}));

import {
    EXPORT_CLAIM_FAILED_MESSAGE,
    EXPORT_GUEST_CLAIM_FAILED_MESSAGE,
    EXPORT_GUEST_LIMIT_MESSAGE,
    EXPORT_GUEST_OFFLINE_MESSAGE,
    EXPORT_OFFLINE_MESSAGE,
    claimPdfExport,
    exportAttemptKey,
    markExportDelivered,
    type ExportClaim,
} from '@/features/export/exportClaim';

const sessionOf = (overrides: { anonymous?: boolean; student?: boolean } = {}): Session =>
    ({
        user: {
            id: 'teacher-1',
            is_anonymous: overrides.anonymous === true,
            app_metadata: overrides.student ? { user_type: 'student' } : {},
        },
    }) as unknown as Session;

const plan = (tier: Entitlements['tier'], pdfExports: number): Entitlements => ({
    user_id: 'teacher-1',
    tier,
    status: tier === 'free' ? null : 'active',
    source: tier === 'free' ? 'none' : 'subscription',
    current_period_end: null,
    limits: { ...FREE_LIMITS, pdf_exports: pdfExports },
});

const setOnline = (online: boolean) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
};

const messageOf = (claim: ExportClaim): string | null => (!claim.ok && 'message' in claim ? claim.message : null);

describe('claimPdfExport', () => {
    beforeEach(() => {
        rpc.mockReset();
        readCachedEntitlements.mockReset();
        readCachedEntitlements.mockResolvedValue(plan('free', 1));
        setOnline(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('goes ahead once the server grants the claim', async () => {
        rpc.mockResolvedValue({ data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        await expect(claimPdfExport(sessionOf(), 'doc-1')).resolves.toEqual({ ok: true });
        expect(rpc).toHaveBeenCalledWith('claim_pdf_export', {});
    });

    it('turns a refusal into the typed limit, on the tier the server saw', async () => {
        rpc.mockResolvedValue({ data: { ok: false, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(claim.ok).toBe(false);
        expect(!claim.ok && 'limit' in claim ? claim.limit : null).toMatchObject({
            metric: 'pdf_exports',
            limit: 1,
            tier: 'free',
        });
    });

    it('fails closed when the server answers with an error', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'internal error' } });
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(claim.ok).toBe(false);
        expect(messageOf(claim)).toBe(EXPORT_CLAIM_FAILED_MESSAGE);
    });

    it('falls back to consume_pdf_export while the server predates claim_pdf_export', async () => {
        // A bundle live ahead of its migration: the old name still counts and
        // refuses in one statement, so it decides in the new name's place.
        rpc.mockImplementation((fn: string) =>
            Promise.resolve(
                fn === 'claim_pdf_export'
                    ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
                    : { data: { ok: true, count: 1, limit: 1 }, error: null },
            ),
        );
        await expect(claimPdfExport(sessionOf(), 'doc-1')).resolves.toEqual({ ok: true });
        expect(rpc).toHaveBeenNthCalledWith(1, 'claim_pdf_export', {});
        expect(rpc).toHaveBeenNthCalledWith(2, 'consume_pdf_export', {});
    });

    it('keeps the fallback refusal a refusal, worded for the free plan', async () => {
        rpc.mockImplementation((fn: string) =>
            Promise.resolve(
                fn === 'claim_pdf_export'
                    ? {
                          data: null,
                          error: { code: '42883', message: 'function public.claim_pdf_export() does not exist' },
                      }
                    : { data: { ok: false, count: 1, limit: 1 }, error: null },
            ),
        );
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(!claim.ok && 'limit' in claim ? claim.limit : null).toMatchObject({
            metric: 'pdf_exports',
            limit: 1,
            tier: 'free',
        });
    });

    it('fails closed when the fallback errors too, and never falls back on other errors', async () => {
        rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_CLAIM_FAILED_MESSAGE);

        rpc.mockReset();
        rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'internal error' } });
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_CLAIM_FAILED_MESSAGE);
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a malformed answer', async () => {
        rpc.mockResolvedValue({ data: { count: 1 }, error: null });
        expect((await claimPdfExport(sessionOf(), 'doc-1')).ok).toBe(false);
        rpc.mockResolvedValue({ data: null, error: null });
        expect((await claimPdfExport(sessionOf(), 'doc-1')).ok).toBe(false);
    });

    it('fails closed when the call itself throws', async () => {
        rpc.mockRejectedValue(new Error('boom'));
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(messageOf(claim)).toBe(EXPORT_CLAIM_FAILED_MESSAGE);
    });

    it('explains that a connection is needed when the fetch never landed', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'TypeError: Failed to fetch' } });
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_OFFLINE_MESSAGE);
        rpc.mockRejectedValue(new TypeError('Load failed'));
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_OFFLINE_MESSAGE);
    });

    it('does not even try while the device is offline on a metered plan', async () => {
        setOnline(false);
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(messageOf(claim)).toBe(EXPORT_OFFLINE_MESSAGE);
        expect(rpc).not.toHaveBeenCalled();
    });

    it('treats an unknown plan as metered: offline with no cached plan is refused', async () => {
        readCachedEntitlements.mockResolvedValue(null);
        setOnline(false);
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_OFFLINE_MESSAGE);
        readCachedEntitlements.mockRejectedValue(new Error('IndexedDB unavailable'));
        expect(messageOf(await claimPdfExport(sessionOf(), 'doc-1'))).toBe(EXPORT_OFFLINE_MESSAGE);
    });

    it('lets an unlimited plan export offline, with nothing to claim', async () => {
        readCachedEntitlements.mockResolvedValue(plan('personal', -1));
        setOnline(false);
        await expect(claimPdfExport(sessionOf(), 'doc-1')).resolves.toEqual({ ok: true });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('lets an unlimited plan export when the meter is unreachable', async () => {
        readCachedEntitlements.mockResolvedValue(plan('teacher', -1));
        rpc.mockResolvedValue({ data: null, error: { message: 'internal error' } });
        await expect(claimPdfExport(sessionOf(), 'doc-1')).resolves.toEqual({ ok: true });
    });

    it('lets the server overrule a cached unlimited plan that has since lapsed', async () => {
        readCachedEntitlements.mockResolvedValue(plan('teacher', -1));
        rpc.mockResolvedValue({ data: { ok: false, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        const claim = await claimPdfExport(sessionOf(), 'doc-1');
        expect(claim.ok).toBe(false);
        expect('limit' in claim).toBe(true);
    });

    it('never claims for a provisioned student, a signed-out device, or a score that lives only here', async () => {
        setOnline(false);
        await expect(claimPdfExport(null, 'doc-1')).resolves.toEqual({ ok: true });
        await expect(claimPdfExport(sessionOf({ student: true }), 'doc-1')).resolves.toEqual({ ok: true });
        // A guest device's local score has no owner to bill, same as signed out.
        await expect(claimPdfExport(sessionOf({ anonymous: true }), null)).resolves.toEqual({ ok: true });
        expect(rpc).not.toHaveBeenCalled();
    });
});

describe('claimPdfExport for a share-link guest', () => {
    const guest = sessionOf({ anonymous: true });

    beforeEach(() => {
        rpc.mockReset();
        readCachedEntitlements.mockReset();
        setOnline(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("claims against the score, so the server can bill its owner's allowance", async () => {
        rpc.mockResolvedValue({ data: { ok: true, limit: 1, unlimited: false, billed_to: 'owner' }, error: null });
        await expect(claimPdfExport(guest, 'doc-1')).resolves.toEqual({ ok: true });
        expect(rpc).toHaveBeenCalledWith('claim_pdf_export', { p_document: 'doc-1' });
        // The guest has no plan of their own to read.
        expect(readCachedEntitlements).not.toHaveBeenCalled();
    });

    it("refuses once the owner's allowance is spent, without offering the guest an upgrade", async () => {
        rpc.mockResolvedValue({ data: { ok: false, limit: 1, unlimited: false, billed_to: 'owner' }, error: null });
        const claim = await claimPdfExport(guest, 'doc-1');
        expect(claim).toEqual({ ok: false, message: EXPORT_GUEST_LIMIT_MESSAGE });
        expect('limit' in claim).toBe(false);
    });

    it('fails closed when the claim errors, the guest is not a member, or the answer is malformed', async () => {
        rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not a member of this score' } });
        expect(messageOf(await claimPdfExport(guest, 'doc-1'))).toBe(EXPORT_GUEST_CLAIM_FAILED_MESSAGE);
        rpc.mockResolvedValue({ data: { count: 1 }, error: null });
        expect(messageOf(await claimPdfExport(guest, 'doc-1'))).toBe(EXPORT_GUEST_CLAIM_FAILED_MESSAGE);
        rpc.mockRejectedValue(new TypeError('Failed to fetch'));
        expect(messageOf(await claimPdfExport(guest, 'doc-1'))).toBe(EXPORT_GUEST_OFFLINE_MESSAGE);
    });

    it("needs a connection: nothing on the device can vouch for the owner's plan", async () => {
        setOnline(false);
        expect(messageOf(await claimPdfExport(guest, 'doc-1'))).toBe(EXPORT_GUEST_OFFLINE_MESSAGE);
        expect(rpc).not.toHaveBeenCalled();
    });

    it('accepts an older server that still exempts guests under the old name', async () => {
        rpc.mockImplementation((fn: string) =>
            Promise.resolve(
                fn === 'claim_pdf_export'
                    ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
                    : { data: { ok: true, exempt: 'anonymous' }, error: null },
            ),
        );
        await expect(claimPdfExport(guest, 'doc-1')).resolves.toEqual({ ok: true });
        expect(rpc).toHaveBeenNthCalledWith(2, 'consume_pdf_export', {});
    });
});

describe('claimPdfExport with a claim id', () => {
    const teacher = sessionOf();
    let n = 0;
    // A fresh export per test: the pending ids live in the module.
    const freshAttempt = () => exportAttemptKey(teacher, `doc-${++n}`, null);
    const claimIdsSent = (): unknown[] =>
        rpc.mock.calls
            .filter(([fn]) => fn === 'claim_pdf_export')
            .map(([, args]) => (args as { p_claim?: string }).p_claim);
    const granted = { data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null };

    beforeEach(() => {
        rpc.mockReset();
        readCachedEntitlements.mockReset();
        readCachedEntitlements.mockResolvedValue(plan('free', 1));
        setOnline(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('names one export by who, which score and which page', () => {
        expect(exportAttemptKey(teacher, 'doc-1', null)).not.toBe(exportAttemptKey(teacher, 'doc-1', 0));
        expect(exportAttemptKey(teacher, 'doc-1', 0)).not.toBe(exportAttemptKey(teacher, 'doc-1', 1));
        expect(exportAttemptKey(null, 'doc-1', null)).not.toBe(exportAttemptKey(teacher, 'doc-1', null));
        expect(exportAttemptKey(teacher, 'doc-1', 2)).toBe(exportAttemptKey(teacher, 'doc-1', 2));
    });

    it('sends the same id until the export is delivered, then a new one', async () => {
        const attempt = freshAttempt();
        rpc.mockResolvedValue(granted);
        await claimPdfExport(teacher, 'doc-1', attempt);
        await claimPdfExport(teacher, 'doc-1', attempt);
        markExportDelivered(attempt);
        await claimPdfExport(teacher, 'doc-1', attempt);

        const [first, retry, next] = claimIdsSent();
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
        expect(retry).toBe(first);
        expect(next).not.toBe(first);
    });

    it('keeps the id when the answer never arrived, since the server may have counted it', async () => {
        const attempt = freshAttempt();
        rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(messageOf(await claimPdfExport(teacher, 'doc-1', attempt))).toBe(EXPORT_OFFLINE_MESSAGE);
        rpc.mockResolvedValue(granted);
        await expect(claimPdfExport(teacher, 'doc-1', attempt)).resolves.toEqual({ ok: true });

        const [lost, retry] = claimIdsSent();
        expect(retry).toBe(lost);
    });

    it('keeps a pending id across a reload of the tab', async () => {
        const attempt = freshAttempt();
        rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await claimPdfExport(teacher, 'doc-1', attempt);

        // A fresh module instance stands in for the reloaded page.
        vi.resetModules();
        const reloaded = await import('@/features/export/exportClaim');
        rpc.mockResolvedValue(granted);
        await reloaded.claimPdfExport(teacher, 'doc-1', attempt);

        const [lost, retry] = claimIdsSent();
        expect(retry).toBe(lost);
    });

    it('drops an id the server refused, so the next try is a new claim', async () => {
        const attempt = freshAttempt();
        rpc.mockResolvedValueOnce({ data: { ok: false, count: 1, limit: 1, tier: 'free' }, error: null });
        await claimPdfExport(teacher, 'doc-1', attempt);
        rpc.mockResolvedValue(granted);
        await claimPdfExport(teacher, 'doc-1', attempt);

        const [refused, next] = claimIdsSent();
        expect(next).not.toBe(refused);
    });

    it('asks again at once under a fresh id when the server will not take the old one', async () => {
        // The old id is spent: "try again, it won't be counted twice" would be
        // untrue, so the fresh claim's own answer is what the teacher sees.
        const attempt = freshAttempt();
        rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'already been used' } });
        rpc.mockResolvedValueOnce(granted);
        await expect(claimPdfExport(teacher, 'doc-1', attempt)).resolves.toEqual({ ok: true });

        const [rejected, fresh] = claimIdsSent();
        expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
        expect(fresh).not.toBe(rejected);
    });

    it('shows the plan notice, not the retry promise, when the fresh claim is refused', async () => {
        const attempt = freshAttempt();
        rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'already been used' } });
        rpc.mockResolvedValueOnce({ data: { ok: false, count: 1, limit: 1, tier: 'free' }, error: null });
        const claim = await claimPdfExport(teacher, 'doc-1', attempt);

        expect(messageOf(claim)).toBeNull();
        expect(!claim.ok && 'limit' in claim ? claim.limit : null).toMatchObject({ metric: 'pdf_exports', limit: 1 });
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('asks again without the id when the server predates claim ids', async () => {
        const attempt = freshAttempt();
        rpc.mockImplementation((_fn: string, args: { p_claim?: string }) =>
            Promise.resolve(
                args.p_claim !== undefined
                    ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
                    : granted,
            ),
        );
        await expect(claimPdfExport(teacher, 'doc-1', attempt)).resolves.toEqual({ ok: true });
        expect(rpc).toHaveBeenNthCalledWith(1, 'claim_pdf_export', { p_claim: expect.any(String) });
        expect(rpc).toHaveBeenNthCalledWith(2, 'claim_pdf_export', {});
    });

    it("carries a guest's id alongside the score it names", async () => {
        const guest = sessionOf({ anonymous: true });
        const attempt = exportAttemptKey(guest, 'doc-guest', null);
        rpc.mockResolvedValue({ data: { ok: true, limit: 1, unlimited: false, billed_to: 'owner' }, error: null });
        await claimPdfExport(guest, 'doc-guest', attempt);
        expect(rpc).toHaveBeenCalledWith('claim_pdf_export', { p_document: 'doc-guest', p_claim: expect.any(String) });
    });
});
