import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewerPage } from '@/features/viewer/ViewerPage';
import type { DocumentRow } from '@/types/database';

const fetchDocument = vi.fn();
const fetchMyRole = vi.fn();
const loadDocumentBytes = vi.fn();
const loadDocumentOffline = vi.fn();
const ensureDocumentPageCount = vi.fn();
const prefetchDocumentBytes = vi.fn();

vi.mock('@/features/library/documentsService', () => ({
    isCloudDocId: (id: string) => /^[0-9a-f-]{36}$/i.test(id),
    fetchDocument: (...args: unknown[]) => fetchDocument(...args),
    fetchMyRole: (...args: unknown[]) => fetchMyRole(...args),
    loadDocumentBytes: (...args: unknown[]) => loadDocumentBytes(...args),
    loadDocumentOffline: (...args: unknown[]) => loadDocumentOffline(...args),
    ensureDocumentPageCount: (...args: unknown[]) => ensureDocumentPageCount(...args),
    prefetchDocumentBytes: (...args: unknown[]) => prefetchDocumentBytes(...args),
}));

const SESSION = {
    user: { id: 'teacher-1', email: 'teacher@example.com', is_anonymous: false, user_metadata: {} },
};

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: SESSION, loading: false, lastEvent: null }),
    isRegisteredSession: () => true,
    displayNameOf: () => 'Teacher',
}));

vi.mock('@/features/viewer/pdf/PdfProvider', () => ({
    PdfProvider: ({ children }: { children: ReactNode }) => <div data-testid="pdf-provider">{children}</div>,
}));

vi.mock('@/features/viewer/PdfViewport', () => ({
    PdfViewport: ({ readOnly, sync }: { readOnly?: boolean; sync?: unknown }) => (
        <div data-testid="pdf-viewport" data-readonly={String(Boolean(readOnly))} data-sync={sync ? 'on' : 'off'} />
    ),
}));

vi.mock('@/features/viewer/ViewerHeader', () => ({
    ViewerHeader: ({ title, children }: { title: string; children: ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {children}
        </header>
    ),
}));

vi.mock('@/features/viewer/presence/PresenceBar', () => ({ PresenceBar: () => null }));
vi.mock('@/features/viewer/history/LessonHistoryButton', () => ({ LessonHistoryButton: () => null }));
vi.mock('@/features/export/ShareExportMenu', () => ({
    ShareExportMenu: () => <div data-testid="share-export-menu" />,
}));
vi.mock('@/features/import/ImportScanButton', () => ({
    ImportScanButton: () => <div data-testid="import-scan-button" />,
}));
vi.mock('@/features/import/analyzeApi', () => ({ makeCloudClassifyFn: () => null }));
vi.mock('@/features/import/cleanReplace', () => ({ buildCleanFn: () => null }));
vi.mock('@/features/import/prepareUpload', () => ({ UPLOAD_ACCEPT: '', prepareUploadFile: vi.fn() }));
vi.mock('@/features/notes/NotesPanel', () => ({ NotesPanel: () => null }));
vi.mock('@/features/share/ShareDialog', () => ({ ShareDialog: () => null }));
vi.mock('@/features/auth/UpgradeBanner', () => ({ UpgradeBanner: () => null }));
vi.mock('@/features/playback/TransportBar', () => ({ TransportBar: () => null }));
vi.mock('@/features/playback/usePlayback', () => ({
    usePlayback: () => ({ playbackFeature: null, getEngine: () => null, warning: null, dismissWarning: vi.fn() }),
}));
vi.mock('@/features/playback/useScoreAnalysis', () => ({
    useScoreAnalysis: () => ({ state: { status: 'idle' }, generate: vi.fn(), applyBroadcast: vi.fn() }),
}));

const DOC_ID = '11111111-2222-4333-8444-555555555555';

const serverDoc = (overrides: Partial<DocumentRow> = {}): DocumentRow => ({
    id: DOC_ID,
    owner_id: 'teacher-1',
    title: 'Nocturne (Chopin)',
    storage_path: `${DOC_ID}/original.pdf`,
    page_count: 2,
    content_rev: 0,
    thumb_rev: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived_at: null,
    ...overrides,
});

const cachedOpen = (role: 'owner' | 'editor' | 'viewer' = 'owner') => ({
    doc: serverDoc({ owner_id: '', page_count: null, title: 'Nocturne (cached)' }),
    role,
    cachedRole: role,
    bytes: new ArrayBuffer(8),
});

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const renderViewer = () =>
    render(
        <MemoryRouter initialEntries={[`/doc/${DOC_ID}`]}>
            <Routes>
                <Route path="/doc/:documentId" element={<ViewerPage />} />
                <Route path="/" element={<div>home</div>} />
            </Routes>
        </MemoryRouter>,
    );

const viewport = () => screen.getByTestId('pdf-viewport');

beforeEach(() => {
    vi.clearAllMocks();
    loadDocumentBytes.mockResolvedValue(new ArrayBuffer(16));
    ensureDocumentPageCount.mockImplementation(async (doc: DocumentRow) => doc);
    fetchMyRole.mockResolvedValue('owner');
    prefetchDocumentBytes.mockImplementation((docId: string) => ({
        path: `${docId}/original.pdf`,
        bytes: Promise.resolve(null),
    }));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('CloudViewer warm open', () => {
    it('drops the cached paint when the server answers that the score is not visible', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockResolvedValue(null);
        fetchMyRole.mockResolvedValue(null);

        renderViewer();

        expect(await screen.findByText(/access was revoked/)).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-viewport')).not.toBeInTheDocument();
        expect(screen.queryByText('Nocturne (cached)')).not.toBeInTheDocument();
    });

    it('keeps the cached score, no longer provisional, when the server cannot be reached', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockRejectedValue(new TypeError('Failed to fetch'));
        fetchMyRole.mockRejectedValue(new TypeError('Failed to fetch'));

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-readonly', 'false'));
        expect(viewport()).toHaveAttribute('data-sync', 'on');
        expect(screen.getByText('Nocturne (cached)')).toBeInTheDocument();
        expect(screen.queryByText(/access was revoked/)).not.toBeInTheDocument();
    });

    it('stays read-only while confirm hangs, even after several seconds', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockReturnValue(new Promise(() => undefined));
        fetchMyRole.mockReturnValue(new Promise(() => undefined));

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-readonly', 'true'));
        expect(viewport()).toHaveAttribute('data-sync', 'off');
        expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('share-export-menu')).not.toBeInTheDocument();
        expect(screen.queryByTestId('import-scan-button')).not.toBeInTheDocument();

        vi.useFakeTimers();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(4000);
        });
        expect(viewport()).toHaveAttribute('data-readonly', 'true');
        expect(viewport()).toHaveAttribute('data-sync', 'off');
    });

    it('paints read-only without sync until the role is confirmed, then opens for writing', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        const docRequest = deferred<DocumentRow | null>();
        const roleRequest = deferred<'owner'>();
        fetchDocument.mockReturnValue(docRequest.promise);
        fetchMyRole.mockReturnValue(roleRequest.promise);

        renderViewer();

        await waitFor(() => expect(screen.getByTestId('pdf-viewport')).toBeInTheDocument());
        expect(viewport()).toHaveAttribute('data-readonly', 'true');
        expect(viewport()).toHaveAttribute('data-sync', 'off');
        expect(screen.getByText('view only')).toBeInTheDocument();

        docRequest.resolve(serverDoc());
        roleRequest.resolve('owner');

        await waitFor(() => expect(viewport()).toHaveAttribute('data-readonly', 'false'));
        expect(viewport()).toHaveAttribute('data-sync', 'on');
        await waitFor(() => expect(screen.getByText('Nocturne (Chopin)')).toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
        expect(screen.getByTestId('share-export-menu')).toBeInTheDocument();
    });

    it('confirms the warm paint against the fresh archive flag, not the cached one', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockResolvedValue(serverDoc({ archived_at: '2026-08-30T00:00:00Z' }));
        fetchMyRole.mockResolvedValue('owner');

        renderViewer();

        await waitFor(() => expect(screen.getByText('Archived')).toBeInTheDocument());
        expect(viewport()).toHaveAttribute('data-readonly', 'true');
    });

    it('hands the warm paint’s buffer to the bytes load and never prefetches over it', async () => {
        const cached = cachedOpen();
        loadDocumentOffline.mockResolvedValue(cached);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(loadDocumentBytes).toHaveBeenCalled());
        expect(prefetchDocumentBytes).toHaveBeenCalledWith(DOC_ID);
        const [, options] = loadDocumentBytes.mock.calls[0] as [
            DocumentRow,
            { preloaded?: { bytes: ArrayBuffer }; prefetch?: unknown },
        ];
        expect(options.preloaded?.bytes).toBe(cached.bytes);
        expect(options.prefetch).toBeUndefined();
    });

    it('starts the bytes download alongside the row on a cold open', async () => {
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(loadDocumentBytes).toHaveBeenCalled());
        expect(prefetchDocumentBytes).toHaveBeenCalledWith(DOC_ID);
        const [, options] = loadDocumentBytes.mock.calls[0] as [DocumentRow, { prefetch?: { path: string } }];
        expect(options.prefetch?.path).toBe(`${DOC_ID}/original.pdf`);
    });

    it('reports a cold open that finds nothing on the server without a fallback', async () => {
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(null);
        fetchMyRole.mockResolvedValue(null);

        renderViewer();

        expect(await screen.findByText(/access was revoked/)).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-viewport')).not.toBeInTheDocument();
    });

    it('drops the cached paint when the document is gone even if the role request rejects', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockResolvedValue(null);
        fetchMyRole.mockRejectedValue(new Error('Could not load membership: JWT expired'));

        renderViewer();

        expect(await screen.findByText(/access was revoked/)).toBeInTheDocument();
        expect(screen.queryByTestId('pdf-viewport')).not.toBeInTheDocument();
        expect(screen.queryByText('Nocturne (cached)')).not.toBeInTheDocument();
    });

    it('stays read-only when confirm fails with a PostgREST error', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen());
        fetchDocument.mockRejectedValue(new Error('Could not load document: JWT expired'));
        fetchMyRole.mockRejectedValue(new Error('Could not load membership: JWT expired'));

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-readonly', 'true'));
        expect(viewport()).toHaveAttribute('data-sync', 'off');
        expect(screen.getByText('Nocturne (cached)')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('share-export-menu')).not.toBeInTheDocument();
    });
});
