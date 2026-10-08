import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentRow } from '@/types/database';

const exportAnnotatedPdf = vi.fn();
const exportAnnotatedPageImage = vi.fn();
const loadDocumentBytes = vi.fn();
const fetchDocument = vi.fn();
const getCachedPdf = vi.fn();
const rpc = vi.fn();

vi.mock('@/features/export/exportPdf', () => ({
    exportAnnotatedPdf: (...args: unknown[]) => exportAnnotatedPdf(...args),
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
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));
// A registered teacher: the PDF flows are metered for them.
vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: { user: { id: 'teacher-1', is_anonymous: false, app_metadata: {} } } }),
    isRegisteredSession: () => true,
    userTypeOf: () => null,
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
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export whole score as PDF' }));
};

beforeEach(() => {
    vi.clearAllMocks();
    exportAnnotatedPdf.mockResolvedValue(undefined);
    exportAnnotatedPageImage.mockResolvedValue(undefined);
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
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

        report({ loaded: 25, total: 100 });
        expect(await screen.findByRole('button', { name: 'Downloading… 25%' })).toBeDisabled();
        expect(screen.getByRole('progressbar', { name: 'Downloading score for export' })).toHaveAttribute(
            'aria-valuenow',
            '25',
        );
        // The meter has not ticked for a PDF that does not exist yet.
        expect(rpc).not.toHaveBeenCalled();

        finish(bytes);
        await waitFor(() => expect(exportAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata'));
        expect(loadDocumentBytes).toHaveBeenCalledWith(row(), expect.objectContaining({ userId: 'teacher-1' }));
        expect(rpc).toHaveBeenCalledWith('consume_pdf_export', {});
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('tells the teacher when the PDF could not be fetched, without spending an export', async () => {
        const user = userEvent.setup();
        loadDocumentBytes.mockRejectedValue(new Error('Could not download score: HTTP 500'));
        render(<ShareExportMenu docId={DOC_ID} doc={row()} title="Sonata" />);
        await openAndExport(user);
        expect(
            await screen.findByText(/Couldn’t download this score to export it \(Could not download score: HTTP 500\)/),
        ).toBeInTheDocument();
        expect(rpc).not.toHaveBeenCalled();
        expect(exportAnnotatedPdf).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Share' })).toBeEnabled();
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
        exportAnnotatedPdf.mockRejectedValue(new Error('Worker crashed'));
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        expect(await screen.findByText('The export failed (Worker crashed). Please try again.')).toBeInTheDocument();
    });

    it('re-opens the menu to show a failure that landed after it was dismissed', async () => {
        const user = userEvent.setup();
        let fail: (err: Error) => void = () => undefined;
        exportAnnotatedPageImage.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    fail = reject;
                }),
        );
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await user.click(screen.getByRole('button', { name: 'Share' }));
        await user.click(screen.getByRole('menuitem', { name: /as photo/ }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        fail(new Error('Share sheet unavailable'));
        expect(await screen.findByText(/Sharing the page failed \(Share sheet unavailable\)/)).toBeInTheDocument();
    });

    it('clears the old error when the menu is opened again', async () => {
        const user = userEvent.setup();
        exportAnnotatedPdf.mockRejectedValueOnce(new Error('Worker crashed'));
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        await screen.findByText(/The export failed/);
        await user.click(screen.getByRole('button', { name: 'Share' }));
        await user.click(screen.getByRole('button', { name: 'Share' }));
        expect(screen.queryByText(/The export failed/)).not.toBeInTheDocument();
    });

    it('fetches the row itself for a cloud score opened without one', async () => {
        const user = userEvent.setup();
        const bytes = new ArrayBuffer(4);
        fetchDocument.mockResolvedValue(row());
        loadDocumentBytes.mockResolvedValue(bytes);
        render(<ShareExportMenu docId={DOC_ID} title="Sonata" />);
        await openAndExport(user);
        await waitFor(() => expect(exportAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata'));
        expect(fetchDocument).toHaveBeenCalledWith(DOC_ID);
    });

    it('uses the cached copy without a round trip when there is no row', async () => {
        const user = userEvent.setup();
        const bytes = new ArrayBuffer(4);
        getCachedPdf.mockResolvedValue({ bytes });
        render(<ShareExportMenu docId={DOC_ID} title="Sonata" />);
        await openAndExport(user);
        await waitFor(() => expect(exportAnnotatedPdf).toHaveBeenCalledWith(DOC_ID, bytes, 'Sonata'));
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
        rpc.mockResolvedValue({ data: { ok: false, limit: 1, count: 1 }, error: null });
        render(<ShareExportMenu docId={DOC_ID} bytes={new ArrayBuffer(4)} title="Score" />);
        await openAndExport(user);
        await waitFor(() => expect(rpc).toHaveBeenCalled());
        expect(exportAnnotatedPdf).not.toHaveBeenCalled();
        expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    });
});
