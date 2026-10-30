import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LimitReachedError } from '@/features/billing/limitErrors';
import type { DocumentRow } from '@/types/database';

// Where the PDF comes from (cache, download, row fetch) and how failures are
// shown. The allowance claim itself is exportClaim's, tested in
// exportClaim.test.ts and ShareExportMenu.test.tsx; here it is a stub.
const toast = vi.hoisted(() => ({
    success: vi.fn(),
    saved: vi.fn(),
    shared: vi.fn(),
    error: vi.fn(),
    promise: vi.fn(<T,>(promise: Promise<T>) => promise),
}));
vi.mock('@/ui/toast', async (importOriginal) => ({ ...(await importOriginal<object>()), toast }));

const buildAnnotatedPdf = vi.fn();
const deliverPdf = vi.fn();
const exportAnnotatedPageImage = vi.fn();
const loadDocumentBytes = vi.fn();
const fetchDocument = vi.fn();
const getCachedPdf = vi.fn();
const claimPdfExport = vi.fn();

vi.mock('@/features/export/exportPdf', () => ({
    buildAnnotatedPdf: (...args: unknown[]) => buildAnnotatedPdf(...args),
    deliverPdf: (...args: unknown[]) => deliverPdf(...args),
}));
vi.mock('@/features/export/exportPageImage', () => ({
    exportAnnotatedPageImage: (...args: unknown[]) => exportAnnotatedPageImage(...args),
}));
vi.mock('@/features/library/documentsService', () => ({
    isCloudDocId: (id: string) => !id.startsWith('local-'),
    loadDocumentBytes: (...args: unknown[]) => loadDocumentBytes(...args),
    fetchDocument: (...args: unknown[]) => fetchDocument(...args),
}));
vi.mock('@/sync/pdfCache', () => ({
    getCachedPdf: (...args: unknown[]) => getCachedPdf(...args),
    readCachedPdfBytes: async (bytes: ArrayBuffer) => bytes,
}));
vi.mock('@/features/export/exportClaim', () => ({
    claimPdfExport: (...args: unknown[]) => claimPdfExport(...args),
    EXPORT_NOT_SENT_MESSAGE: 'Not sent.',
    exportAttemptKey: () => 'attempt',
    markExportDelivered: () => undefined,
}));
// A registered teacher: the PDF flows are metered for them.
vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: { user: { id: 'teacher-1', is_anonymous: false, app_metadata: {} } } }),
}));
vi.mock('@/features/billing/pricing', () => ({ isBillingConfigured: () => false }));

import { ShareExportMenu } from '@/features/export/ShareExportMenu';

const DOC_ID = 'a4ccff59-6f2f-4dc7-a2a8-5c8f2b6f1de1';

const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
    id: DOC_ID,
    owner_id: 'teacher-1',
    title: 'Sonata',
    storage_path: `${DOC_ID}/original.pdf`,
    page_count: 3,
    content_rev: 0,
    thumb_rev: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived_at: null,
    ...over,
});

const openAndExport = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export whole score as PDF' }));
};

beforeEach(() => {
    vi.clearAllMocks();
    buildAnnotatedPdf.mockResolvedValue(new File([], 'Sonata (annotated).pdf'));
    deliverPdf.mockResolvedValue('downloaded');
    exportAnnotatedPageImage.mockResolvedValue('downloaded');
    claimPdfExport.mockResolvedValue({ ok: true });
    getCachedPdf.mockResolvedValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('ShareExportMenu', () => {
    it('downloads a score the device never cached, showing progress, then exports it', async () => {
        const user = userEvent.setup();
        const bytes = new ArrayBuffer(8);
        let report: (p: { loaded: number; total: number }) => void = () => undefined;
        let finish: (b: ArrayBuffer) => void = () => undefined;
        loadDocumentBytes.mockImplementation(
            (_doc: DocumentRow, options: { onProgress: typeof report }) =>
                new Promise<ArrayBuffer>((resolve) => {
                    report = options.onProgress;
                    finish = resolve;
                }),
        );
        render(<ShareExportMenu docId={DOC_ID} doc={row()} title="Sonata" />);
        await openAndExport(user);

        // No size yet: the percentage's slot is held empty, so the button
        // does not widen when the number arrives.
        report({ loaded: 10, total: 0 });
        const slot = (await screen.findByRole('button', { name: 'Downloading…' })).querySelector('[data-download-pct]');
        expect(slot).toHaveClass('inline-block', 'w-[4ch]');
        expect(slot).toBeEmptyDOMElement();

        report({ loaded: 25, total: 100 });
        const trigger = await screen.findByRole('button', { name: 'Downloading… 25%' });
        expect(trigger.querySelector('[data-download-pct]')).toBe(slot);
        expect(slot).toHaveTextContent('25%');
        // Every caption is in the button (SwapLabel), so it never changes width.
        expect(within(trigger).getByText('Export')).toHaveAttribute('aria-hidden', 'true');
        // The menu closed on the press; opened again mid-export, it offers nothing to start.
        await user.click(trigger);
        expect(await screen.findByRole('menuitem', { name: 'Export whole score as PDF' })).toHaveAttribute(
            'aria-disabled',
            'true',
        );
        await user.keyboard('{Escape}');
        expect(screen.getByRole('progressbar', { name: 'Downloading score for export' })).toHaveAttribute(
            'aria-valuenow',
            '25',
        );
        // The meter has not ticked for a PDF that does not exist yet.
        expect(claimPdfExport).not.toHaveBeenCalled();

        finish(bytes);
        await waitFor(() =>
            expect(buildAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata', {
                userId: 'teacher-1',
                onNotice: expect.any(Function),
                lostAccess: false,
            }),
        );
        expect(loadDocumentBytes).toHaveBeenCalledWith(row(), expect.objectContaining({ userId: 'teacher-1' }));
        expect(claimPdfExport).toHaveBeenCalledWith(expect.anything(), DOC_ID, 'attempt');
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('confirms a finished export with a toast naming what went where', async () => {
        const user = userEvent.setup();
        getCachedPdf.mockResolvedValue({ bytes: new ArrayBuffer(8) });
        render(<ShareExportMenu docId={DOC_ID} doc={row()} bytes={new ArrayBuffer(8)} title="Sonata" />);

        await openAndExport(user);
        await waitFor(() =>
            expect(toast.saved).toHaveBeenCalledWith('Score saved as a PDF', { description: 'Sonata' }),
        );

        deliverPdf.mockResolvedValue('shared');
        await user.click(screen.getByRole('button', { name: 'Export' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Save page 1 as PDF' }));
        await waitFor(() =>
            expect(toast.shared).toHaveBeenCalledWith('Page 1 shared as a PDF', { description: 'Sonata' }),
        );

        exportAnnotatedPageImage.mockResolvedValue('shared');
        await user.click(screen.getByRole('button', { name: 'Export' }));
        await user.click(await screen.findByRole('menuitem', { name: /Send page 1 as photo/ }));
        await waitFor(() =>
            expect(toast.shared).toHaveBeenCalledWith('Page 1 shared as a photo', { description: 'Sonata' }),
        );
    });

    it('does not toast a share sheet that was dismissed, or an export that failed', async () => {
        const user = userEvent.setup();
        deliverPdf.mockResolvedValue('cancelled');
        render(<ShareExportMenu docId={DOC_ID} doc={row()} bytes={new ArrayBuffer(8)} title="Sonata" />);
        await openAndExport(user);
        // The menu comes back to say the PDF was not sent.
        expect(await screen.findByText('Not sent.')).toBeInTheDocument();
        await user.keyboard('{Escape}');

        buildAnnotatedPdf.mockRejectedValue(new Error('pdf-lib blew up'));
        await user.click(screen.getByRole('button', { name: 'Export' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Export whole score as PDF' }));
        expect(await screen.findByText(/pdf-lib blew up/)).toBeInTheDocument();

        expect(toast.saved).not.toHaveBeenCalled();
        expect(toast.shared).not.toHaveBeenCalled();
    });

    it('tells the teacher when the PDF could not be fetched, without spending an export', async () => {
        const user = userEvent.setup();
        loadDocumentBytes.mockRejectedValue(new Error('Could not download score: HTTP 500'));
        render(<ShareExportMenu docId={DOC_ID} doc={row()} title="Sonata" />);
        await openAndExport(user);
        expect(
            await screen.findByText(/Couldn’t download this score to export it \(Could not download score: HTTP 500\)/),
        ).toBeInTheDocument();
        expect(claimPdfExport).not.toHaveBeenCalled();
        expect(deliverPdf).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    });

    it('says so plainly when offline with nothing on the device', async () => {
        const user = userEvent.setup();
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        loadDocumentBytes.mockRejectedValue(new TypeError('Failed to fetch'));
        render(<ShareExportMenu docId={DOC_ID} doc={row()} title="Sonata" />);
        await openAndExport(user);
        expect(await screen.findByText(/You’re offline and this score isn’t saved on this device yet/)).toBeVisible();
    });

    it('shows an export that failed after the bytes were in hand', async () => {
        const user = userEvent.setup();
        buildAnnotatedPdf.mockRejectedValue(new Error('Worker crashed'));
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        expect(await screen.findByText('The export failed (Worker crashed). Please try again.')).toBeInTheDocument();
    });

    it('shows a failure that landed after the menu was dismissed', async () => {
        const user = userEvent.setup();
        let fail: (err: Error) => void = () => undefined;
        exportAnnotatedPageImage.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    fail = reject;
                }),
        );
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await user.click(screen.getByRole('button', { name: 'Export' }));
        await user.click(await screen.findByRole('menuitem', { name: /as photo/ }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        fail(new Error('Share sheet unavailable'));
        expect(await screen.findByText(/The export failed \(Share sheet unavailable\)/)).toBeInTheDocument();
    });

    it('clears the old error when the menu is opened again', async () => {
        const user = userEvent.setup();
        buildAnnotatedPdf.mockRejectedValueOnce(new Error('Worker crashed'));
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        await screen.findByText(/The export failed/);
        await user.click(screen.getByRole('button', { name: 'Export' }));
        await user.click(screen.getByRole('button', { name: 'Export' }));
        expect(screen.queryByText(/The export failed/)).not.toBeInTheDocument();
    });

    it('fetches the row itself for a cloud score opened without one', async () => {
        const user = userEvent.setup();
        const bytes = new ArrayBuffer(4);
        fetchDocument.mockResolvedValue(row());
        loadDocumentBytes.mockResolvedValue(bytes);
        render(<ShareExportMenu docId={DOC_ID} title="Sonata" />);
        await openAndExport(user);
        await waitFor(() =>
            expect(buildAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata', {
                userId: 'teacher-1',
                onNotice: expect.any(Function),
                lostAccess: false,
            }),
        );
        expect(fetchDocument).toHaveBeenCalledWith(DOC_ID);
    });

    it('uses the cached copy without a round trip when there is no row', async () => {
        const user = userEvent.setup();
        const bytes = new ArrayBuffer(4);
        getCachedPdf.mockResolvedValue({ bytes });
        render(<ShareExportMenu docId={DOC_ID} title="Sonata" />);
        await openAndExport(user);
        await waitFor(() =>
            expect(buildAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata', {
                userId: 'teacher-1',
                onNotice: expect.any(Function),
                lostAccess: false,
            }),
        );
        expect(fetchDocument).not.toHaveBeenCalled();
    });

    it('reports a score that is gone instead of failing silently', async () => {
        const user = userEvent.setup();
        fetchDocument.mockResolvedValue(null);
        render(<ShareExportMenu docId={DOC_ID} title="Sonata" />);
        await openAndExport(user);
        expect(await screen.findByText('This score is no longer available to you.')).toBeInTheDocument();
    });

    it('still shows the plan limit, not an error, when the export allowance is used up', async () => {
        const user = userEvent.setup();
        claimPdfExport.mockResolvedValue({
            ok: false,
            limit: new LimitReachedError({ code: 'limit_reached', metric: 'pdf_exports', limit: 1, tier: 'free' }),
        });
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        await waitFor(() => expect(claimPdfExport).toHaveBeenCalled());
        expect(deliverPdf).not.toHaveBeenCalled();
        expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    });
});
