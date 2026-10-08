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
