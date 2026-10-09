import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '@/features/auth/session';
import type * as EntitlementsServiceModule from '@/features/billing/entitlementsService';

import { FREE_LIMITS } from '@/features/billing/entitlementsService';
import type { Entitlements } from '@/types/database';

const rpc = vi.fn();
const readCachedEntitlements = vi.fn();
const useSession = vi.fn();
const buildAnnotatedPdf = vi.fn();
const deliverPdf = vi.fn();
const exportAnnotatedPageImage = vi.fn();

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));

// The real claim runs; only who is signed in and the cached plan are stubbed.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof SessionModule>()),
    useSession: () => useSession(),
}));

vi.mock('@/features/billing/entitlementsService', async (importOriginal) => ({
    ...(await importOriginal<typeof EntitlementsServiceModule>()),
    readCachedEntitlements: (...args: unknown[]) => readCachedEntitlements(...args),
}));

vi.mock('@/features/export/exportPdf', () => ({
    buildAnnotatedPdf: (...args: unknown[]) => buildAnnotatedPdf(...args),
    deliverPdf: (...args: unknown[]) => deliverPdf(...args),
}));

vi.mock('@/features/export/exportPageImage', () => ({
    exportAnnotatedPageImage: (...args: unknown[]) => exportAnnotatedPageImage(...args),
}));

vi.mock('@/features/billing/PricingDialog', () => ({
    PricingDialog: () => <div role="dialog">plans</div>,
}));

import {
    EXPORT_CLAIM_FAILED_MESSAGE,
    EXPORT_GUEST_LIMIT_MESSAGE,
    EXPORT_GUEST_OFFLINE_MESSAGE,
    EXPORT_OFFLINE_MESSAGE,
} from '@/features/export/exportClaim';
import { ShareExportMenu } from '@/features/export/ShareExportMenu';

const teacher = {
    user: { id: 'teacher-1', is_anonymous: false, app_metadata: {} },
} as unknown as Session;

const guest = {
    user: { id: 'guest-1', is_anonymous: true, app_metadata: {} },
} as unknown as Session;

const plan = (tier: Entitlements['tier'], pdfExports: number): Entitlements => ({
    user_id: 'teacher-1',
    tier,
    status: tier === 'free' ? null : 'active',
    source: tier === 'free' ? 'none' : 'subscription',
    current_period_end: null,
    limits: { ...FREE_LIMITS, pdf_exports: pdfExports },
});

const bytes = new Uint8Array([37, 80, 68, 70]).buffer;
const builtPdf = new File([new Uint8Array([37, 80, 68, 70])], 'Sonata (annotated).pdf', { type: 'application/pdf' });

/** The claim id each claim_pdf_export call carried, in call order. */
const claimIds = (): unknown[] =>
    rpc.mock.calls
        .filter(([fn]) => fn === 'claim_pdf_export')
        .map(([, args]) => (args as { p_claim?: string }).p_claim);

const openMenu = async (props: { localOnly?: boolean } = {}) => {
    const user = userEvent.setup();
    render(<ShareExportMenu docId="doc-1" bytes={bytes} title="Sonata" {...props} />);
    await user.click(screen.getByRole('button', { name: 'Share' }));
    return user;
};

describe('ShareExportMenu export allowance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useSession.mockReturnValue({ session: teacher, loading: false, lastEvent: null });
        readCachedEntitlements.mockResolvedValue(plan('free', 1));
        buildAnnotatedPdf.mockResolvedValue(builtPdf);
        deliverPdf.mockResolvedValue('downloaded');
        exportAnnotatedPageImage.mockResolvedValue(undefined);
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('builds the PDF, then claims, then hands it over only once the claim is granted', async () => {
        rpc.mockResolvedValue({ data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

        await waitFor(() => expect(deliverPdf).toHaveBeenCalledWith(builtPdf));
        expect(rpc).toHaveBeenCalledWith('claim_pdf_export', { p_claim: expect.any(String) });
        const built = buildAnnotatedPdf.mock.invocationCallOrder[0] ?? Infinity;
        const claimed = rpc.mock.invocationCallOrder[0] ?? Infinity;
        expect(built).toBeLessThan(claimed);
        expect(claimed).toBeLessThan(deliverPdf.mock.invocationCallOrder[0] ?? 0);
    });

    it('never claims for an export that failed to build, so the retry is not refused', async () => {
        rpc.mockResolvedValue({ data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        buildAnnotatedPdf.mockRejectedValueOnce(new Error('Worker crashed'));
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

        expect(await screen.findByText('The export failed (Worker crashed). Please try again.')).toBeInTheDocument();
        expect(rpc).not.toHaveBeenCalled();
        expect(deliverPdf).not.toHaveBeenCalled();

        // The retry the message invites is the account's first claim, not a second.
        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('retries a dismissed share sheet under the same claim id, so it is not counted twice', async () => {
        rpc.mockResolvedValue({ data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        deliverPdf.mockResolvedValueOnce('cancelled');
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Share page 1 as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
        await user.click(screen.getByRole('button', { name: 'Share' }));
        await user.click(screen.getByRole('menuitem', { name: 'Share page 1 as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(2));

        const [first, second] = claimIds();
        expect(first).toEqual(expect.any(String));
        expect(second).toBe(first);
    });

    it('retries a claim whose answer was lost under the same id', async () => {
        rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Failed to fetch' } });
        rpc.mockResolvedValue({
            data: { ok: true, replayed: true, limit: 1, tier: 'free', unlimited: false },
            error: null,
        });
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
        expect(await screen.findByText(EXPORT_OFFLINE_MESSAGE)).toBeInTheDocument();
        expect(deliverPdf).not.toHaveBeenCalled();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
        const [first, second] = claimIds();
        expect(second).toBe(first);
    });

    it('counts the next export once the last one was delivered', async () => {
        rpc.mockResolvedValue({ data: { ok: true, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
        await user.click(screen.getByRole('button', { name: 'Share' }));
        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(2));

        const [first, second] = claimIds();
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
    });

    it('shows the limit and builds nothing when the allowance is spent', async () => {
        rpc.mockResolvedValue({ data: { ok: false, count: 1, limit: 1, tier: 'free', unlimited: false }, error: null });
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

        expect(await screen.findByText('You have used your 1 free PDF export this month')).toBeInTheDocument();
        expect(deliverPdf).not.toHaveBeenCalled();
    });

    it('fails closed with a clear message when the meter errors', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'internal error' } });
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Share page 1 as PDF' }));

        expect(await screen.findByText(EXPORT_CLAIM_FAILED_MESSAGE)).toBeInTheDocument();
        expect(deliverPdf).not.toHaveBeenCalled();
    });

    it('explains that exporting needs a connection when offline on a metered plan', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

        expect(await screen.findByText(EXPORT_OFFLINE_MESSAGE)).toBeInTheDocument();
        expect(deliverPdf).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('exports offline on an unlimited plan', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        readCachedEntitlements.mockResolvedValue(plan('personal', -1));
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

        await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(EXPORT_OFFLINE_MESSAGE)).not.toBeInTheDocument();
    });

    it('never claims for sharing a page as a photo — the pricing limits PDF export only', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const user = await openMenu();

        await user.click(screen.getByRole('menuitem', { name: /Share page 1 as photo/ }));

        await waitFor(() => expect(exportAnnotatedPageImage).toHaveBeenCalledTimes(1));
        expect(rpc).not.toHaveBeenCalled();
    });

    describe('as a share-link guest', () => {
        beforeEach(() => {
            useSession.mockReturnValue({ session: guest, loading: false, lastEvent: null });
        });

        it('claims against this score, billed to its owner, before handing it over', async () => {
            rpc.mockResolvedValue({ data: { ok: true, limit: 1, unlimited: false, billed_to: 'owner' }, error: null });
            const user = await openMenu();

            await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

            await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
            expect(rpc).toHaveBeenCalledWith('claim_pdf_export', { p_document: 'doc-1', p_claim: expect.any(String) });
        });

        it("says the owner's allowance is spent, offers no plans, and builds nothing", async () => {
            rpc.mockResolvedValue({ data: { ok: false, limit: 1, unlimited: false, billed_to: 'owner' }, error: null });
            const user = await openMenu();

            await user.click(screen.getByRole('menuitem', { name: 'Share page 1 as PDF' }));

            expect(await screen.findByText(EXPORT_GUEST_LIMIT_MESSAGE)).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: 'See plans' })).not.toBeInTheDocument();
            expect(deliverPdf).not.toHaveBeenCalled();
        });

        it('needs a connection for a shared score', async () => {
            vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
            const user = await openMenu();

            await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

            expect(await screen.findByText(EXPORT_GUEST_OFFLINE_MESSAGE)).toBeInTheDocument();
            expect(deliverPdf).not.toHaveBeenCalled();
        });

        it('exports a score that lives only on this device without a claim', async () => {
            vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
            const user = await openMenu({ localOnly: true });

            await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));

            await waitFor(() => expect(deliverPdf).toHaveBeenCalledTimes(1));
            expect(rpc).not.toHaveBeenCalled();
        });
    });
});
