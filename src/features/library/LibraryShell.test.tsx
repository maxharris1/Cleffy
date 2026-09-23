import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate, useOutletContext } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LibraryShell, type LibraryOutletContext } from '@/features/library/LibraryShell';
import type { Entitlements } from '@/types/database';

// The shell is chrome around an Outlet: everything it reaches for at import
// time is stubbed, because none of it is what these cases are about.
vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/features/auth/AuthGates', () => ({
    RequireRegistered: ({ children }: { children: (session: unknown) => React.ReactNode }) =>
        children({ user: { id: 'teacher-1', email: 'teacher@example.com' } }),
}));

vi.mock('@/features/auth/session', () => ({
    displayNameOf: () => 'Ada Teacher',
    signOut: vi.fn(),
}));

const entitlements: Entitlements = {
    user_id: 'teacher-1',
    tier: 'teacher',
    status: 'active',
    source: 'subscription',
    current_period_end: null,
    limits: { cloud_scores: -1, omr_runs: -1, vision_reads: -1, smart_imports: -1, pdf_exports: -1, students: -1 },
};

vi.mock('@/features/billing/useEntitlements', () => ({
    useEntitlements: () => ({ entitlements, loading: false, refresh: vi.fn() }),
}));

vi.mock('@/features/billing/entitlementsService', () => ({
    clearCachedEntitlements: vi.fn(),
}));

const uploadDocument = vi.fn();
const importDocumentFromImslp = vi.fn();
vi.mock('@/features/library/documentsService', () => ({
    importDocumentFromImslp: (...args: unknown[]) => importDocumentFromImslp(...args),
    loadDocumentBytes: vi.fn(),
    uploadDocument: (...args: unknown[]) => uploadDocument(...args),
}));

const requestScoreAnalysis = vi.fn();
vi.mock('@/features/playback/scoreAnalysisService', () => ({
    requestScoreAnalysis: (...args: unknown[]) => requestScoreAnalysis(...args),
}));

const readCachedLibraryList = vi.fn();
const prependCachedLibraryDocument = vi.fn();
vi.mock('@/features/library/libraryBootstrap', () => ({
    readCachedLibraryList: (...args: unknown[]) => readCachedLibraryList(...args),
    prependCachedLibraryDocument: (...args: unknown[]) => prependCachedLibraryDocument(...args),
}));

vi.mock('@/features/import/importPromptService', () => ({
    recordImportStatus: vi.fn(),
    shouldOfferImport: vi.fn(),
}));

vi.mock('@/features/import/prescan', () => ({
    prescanDocument: vi.fn(),
}));

/** A routed page with the one thing the tests need from it: browser Back. */
const Page = ({ name }: { name: string }) => {
    const navigate = useNavigate();
    return (
        <div>
            <p>{name}</p>
            <button type="button" onClick={() => navigate(-1)}>
                go back
            </button>
        </div>
    );
};

/** Stands in for the search page: one button that runs the shell's IMSLP import and reports back. */
const ImportStub = ({ onStage, onResult }: { onStage: (s: string) => void; onResult: (r: unknown) => void }) => {
    const { onImportImslp } = useOutletContext<LibraryOutletContext>();
    return (
        <button
            type="button"
            onClick={() =>
                void onImportImslp('nocturnes.pdf', 'Nocturnes, Op.9', true, undefined, onStage).then(onResult)
            }
        >
            import from imslp
        </button>
    );
};

const renderShell = (
    initialEntry = '/library',
    stub: { onStage: (s: string) => void; onResult: (r: unknown) => void } = { onStage: vi.fn(), onResult: vi.fn() },
) =>
    render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
                <Route element={<LibraryShell />}>
                    <Route path="/library" element={<Page name="library page" />} />
                    <Route path="/students" element={<Page name="students page" />} />
                    <Route path="/search" element={<ImportStub {...stub} />} />
                </Route>
                <Route path="/doc/:id" element={<Page name="viewer page" />} />
            </Routes>
        </MemoryRouter>,
    );

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('LibraryShell', () => {
    it('puts an uploaded score at the top of the snapshot read before the upload cleared it', async () => {
        const user = userEvent.setup();
        const before = {
            documents: [{ id: 'd1' }],
            hasMore: false,
            favoriteIds: new Set(),
            tags: [],
            documentTags: new Map(),
        };
        readCachedLibraryList.mockResolvedValue(before);
        prependCachedLibraryDocument.mockResolvedValue(undefined);
        const document = { id: 'd2', title: 'New score' };
        uploadDocument.mockResolvedValue({ document });
        renderShell();

        const input = screen.getByLabelText('Upload score', { selector: 'input' });
        await user.upload(input, new File(['%PDF-1.4'], 'new.pdf', { type: 'application/pdf' }));

        expect(await screen.findByText('viewer page')).toBeInTheDocument();
        expect(readCachedLibraryList).toHaveBeenCalledWith('teacher-1');
        expect(prependCachedLibraryDocument).toHaveBeenCalledWith('teacher-1', before, document);
    });

    it('keeps the account menu closed after coming back to the route it was opened on', async () => {
        const user = userEvent.setup();
        renderShell();

        await user.click(await screen.findByRole('button', { name: /Account menu/ }));
        expect(screen.getByRole('menu', { name: 'Account' })).toBeInTheDocument();

        // Enter on a link dispatches click and no pointerdown, so the menu's
        // outside-click listener never learns that the route changed.
        screen.getByRole('link', { name: 'Students' }).focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByText('students page')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'go back' }));
        expect(await screen.findByText('library page')).toBeInTheDocument();
        expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument();
    });

    it('pads the chrome for the iPhone status bar', () => {
        renderShell();
        expect(screen.getByRole('banner')).toHaveClass('pt-[var(--safe-top)]');
    });

    it('auto-requests analysis after an IMSLP import and opens the score at once, relaying download stages', async () => {
        const user = userEvent.setup();
        readCachedLibraryList.mockResolvedValue(null);
        let resolveImport: (value: unknown) => void = () => undefined;
        importDocumentFromImslp.mockImplementation(
            (_f: string, _t: string, _o: string, _a: boolean, _sha?: string, onStage?: (s: string) => void) =>
                new Promise((resolve) => {
                    // The download layer reports a real pacing wait, then its retry.
                    onStage?.('downloadQueued');
                    onStage?.('downloading');
                    resolveImport = resolve;
                }),
        );
        requestScoreAnalysis.mockResolvedValue({ ok: true });
        const onStage = vi.fn();
        const onResult = vi.fn();
        renderShell('/search', { onStage, onResult });

        await user.click(screen.getByRole('button', { name: 'import from imslp' }));

        await screen.findByRole('progressbar', { name: 'Importing from IMSLP' });
        expect(onStage.mock.calls.map((c) => c[0])).toEqual(['downloadQueued', 'downloading']);
        expect(screen.queryByText('viewer page')).not.toBeInTheDocument();

        resolveImport({ ok: true, document: { id: 'd9', title: 'Nocturnes, Op.9' } });
        // Navigation follows the analysis request directly — no panel-side queue wait.
        expect(await screen.findByText('viewer page')).toBeInTheDocument();
        expect(requestScoreAnalysis).toHaveBeenCalledWith('d9');
        expect(onResult).toHaveBeenCalledWith({ ok: true });
        expect(onStage).not.toHaveBeenCalledWith(expect.stringMatching(/queued$/));
    });

    it('reports a rate-limited auto-analysis to the panel instead of navigating', async () => {
        const user = userEvent.setup();
        readCachedLibraryList.mockResolvedValue(null);
        importDocumentFromImslp.mockResolvedValue({ ok: true, document: { id: 'd9', title: 'Nocturnes, Op.9' } });
        requestScoreAnalysis.mockResolvedValue({ ok: false, code: 'rate_limited' });
        const onStage = vi.fn();
        const onResult = vi.fn();
        renderShell('/search', { onStage, onResult });

        await user.click(screen.getByRole('button', { name: 'import from imslp' }));

        await vi.waitFor(() =>
            expect(onResult).toHaveBeenCalledWith({
                ok: true,
                analysisFailed: { code: 'rate_limited', documentId: 'd9' },
            }),
        );
        expect(onStage).not.toHaveBeenCalled();
        expect(screen.queryByText('viewer page')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'import from imslp' })).toBeInTheDocument();
    });
});
