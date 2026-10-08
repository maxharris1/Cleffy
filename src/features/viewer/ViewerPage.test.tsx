import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    PdfViewport: ({
        readOnly,
        sync,
        playback,
    }: {
        readOnly?: boolean;
        sync?: { onScoreAnalysis?: unknown };
        playback?: unknown;
    }) => (
        <div
            data-testid="pdf-viewport"
            data-readonly={String(Boolean(readOnly))}
            data-sync={sync ? 'on' : 'off'}
            data-playback={playback ? 'on' : 'off'}
            data-analysis-broadcasts={sync?.onScoreAnalysis ? 'on' : 'off'}
        />
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
vi.mock('@/features/playback/TransportBar', () => ({
    TransportBar: () => <div data-testid="transport-bar" />,
}));
const engine = { pause: vi.fn() };
vi.mock('@/features/playback/usePlayback', () => ({
    usePlayback: () => ({
        playbackFeature: { score: {}, getEngine: () => engine },
        getEngine: () => engine,
        warning: null,
        dismissWarning: vi.fn(),
    }),
}));
const analysis: { state: { kind: string } } = { state: { kind: 'none' } };
const useScoreAnalysis = vi.fn((_docId: string, _enabled: boolean) => ({
    state: analysis.state,
    generate: vi.fn(),
    applyBroadcast: vi.fn(),
}));
vi.mock('@/features/playback/useScoreAnalysis', () => ({
    useScoreAnalysis: (docId: string, enabled: boolean) => useScoreAnalysis(docId, enabled),
}));
/** Release flags (src/lib/features.ts), flipped per test; read at render. */
const flags = vi.hoisted(() => ({ playalong: false, fingering: false, printHandwriting: false }));
vi.mock('@/lib/features', () => ({ features: flags }));

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
    analysis.state = { kind: 'none' };
    flags.playalong = false;
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

    it('shows the IMSLP source to a view-only member, carried onto a warm paint even if the bytes reload fails', async () => {
        loadDocumentOffline.mockResolvedValue(cachedOpen('viewer'));
        fetchMyRole.mockResolvedValue('viewer');
        fetchDocument.mockResolvedValue(
            serverDoc({
                source_url: 'https://imslp.org/wiki/Nocturnes%2C_Op.9_(Chopin%2C_Fr%C3%A9d%C3%A9ric)',
                source_filename: 'nocturnes.pdf',
                source_license: 'Creative Commons Attribution 4.0',
                source_attribution: {
                    source: 'imslp',
                    work: 'Nocturnes, Op.9 (Chopin, Frédéric)',
                    composer: 'Chopin, Frédéric',
                    editor: 'A. Engraver',
                    arranger: null,
                    publisher: null,
                    year: null,
                },
            }),
        );
        loadDocumentBytes.mockRejectedValue(new Error('offline'));

        renderViewer();

        await userEvent.click(await screen.findByRole('button', { name: 'Source' }));
        expect(screen.getByRole('dialog', { name: 'About this score' })).toHaveTextContent('A. Engraver');
    });

    it('offers no Source control for an uploaded score', async () => {
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(viewport()).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: 'Source' })).not.toBeInTheDocument();
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

    it('ships no play-along with the feature switched off: no control, no analysis, no broadcasts', async () => {
        // A ready analysis on the server must not surface either — the flag, not
        // the analysis state, decides whether the feature exists in this build.
        analysis.state = { kind: 'ready' };
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-sync', 'on'));
        expect(screen.queryByRole('button', { name: 'Play-along' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('transport-bar')).not.toBeInTheDocument();
        expect(viewport()).toHaveAttribute('data-playback', 'off');
        expect(viewport()).toHaveAttribute('data-analysis-broadcasts', 'off');
        // Disabled analysis is what keeps status reads, polling and OMR runs off.
        expect(useScoreAnalysis).toHaveBeenCalled();
        expect(useScoreAnalysis.mock.calls.every(([, enabled]) => enabled === false)).toBe(true);
    });

    it('keeps the play-along panel and playhead hidden until asked for, and pauses on close', async () => {
        flags.playalong = true;
        const user = userEvent.setup();
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-sync', 'on'));
        expect(screen.queryByTestId('transport-bar')).not.toBeInTheDocument();
        expect(viewport()).toHaveAttribute('data-playback', 'off');

        const toggle = screen.getByRole('button', { name: 'Play-along' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(viewport()).toHaveAttribute('data-analysis-broadcasts', 'on');
        expect(useScoreAnalysis).toHaveBeenLastCalledWith(DOC_ID, true);
        await user.click(toggle);
        // The transport is a lazy chunk, fetched on first open.
        expect(await screen.findByTestId('transport-bar')).toBeInTheDocument();
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(viewport()).toHaveAttribute('data-playback', 'on');
        expect(engine.pause).not.toHaveBeenCalled();

        await user.click(toggle);
        expect(screen.queryByTestId('transport-bar')).not.toBeInTheDocument();
        expect(viewport()).toHaveAttribute('data-playback', 'off');
        expect(engine.pause).toHaveBeenCalledTimes(1);
    });

    it('offers no play-along control when analysis is unavailable', async () => {
        flags.playalong = true;
        analysis.state = { kind: 'unavailable' };
        loadDocumentOffline.mockResolvedValue(null);
        fetchDocument.mockResolvedValue(serverDoc());

        renderViewer();

        await waitFor(() => expect(viewport()).toHaveAttribute('data-sync', 'on'));
        expect(screen.queryByRole('button', { name: 'Play-along' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('transport-bar')).not.toBeInTheDocument();
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
