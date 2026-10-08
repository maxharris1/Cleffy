import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate, useOutletContext } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
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

const entitlementsState = vi.hoisted(() => {
    const unlimited: Entitlements = {
        user_id: 'teacher-1',
        tier: 'teacher',
        status: 'active',
        source: 'subscription',
        current_period_end: null,
        limits: { cloud_scores: -1, omr_runs: -1, vision_reads: -1, smart_imports: -1, pdf_exports: -1, students: -1 },
    };
    return { current: unlimited, unlimited };
});

const freeEntitlements = (): Entitlements => ({
    user_id: 'teacher-1',
    tier: 'free',
    status: 'active',
    source: 'managed',
    current_period_end: null,
    limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 3, smart_imports: 3, pdf_exports: 1, students: 0 },
});

const studentEntitlements = (): Entitlements => ({
    user_id: 'teacher-1',
    tier: 'student',
    status: 'active',
    source: 'managed',
    current_period_end: null,
    limits: { cloud_scores: 0, omr_runs: 0, vision_reads: 0, smart_imports: 0, pdf_exports: 0, students: 0 },
});

vi.mock('@/features/billing/useEntitlements', () => ({
    useEntitlements: () => ({ entitlements: entitlementsState.current, loading: false, refresh: vi.fn() }),
}));

vi.mock('@/features/billing/entitlementsService', () => ({
    clearCachedEntitlements: vi.fn(),
    isUnlimited: (limit: number) => limit < 0,
    FREE_LIMITS: { cloud_scores: 3 },
}));

const uploadDocument = vi.fn();
const importDocumentFromImslp = vi.fn();
vi.mock('@/features/library/documentsService', () => ({
    importDocumentFromImslp: (...args: unknown[]) => importDocumentFromImslp(...args),
    loadDocumentBytes: vi.fn(),
    uploadDocument: (...args: unknown[]) => uploadDocument(...args),
}));

const readCachedLibraryList = vi.fn();
const prependCachedLibraryDocument = vi.fn();
const fetchLibraryBootstrap = vi.fn();
vi.mock('@/features/library/libraryBootstrap', () => ({
    readCachedLibraryList: (...args: unknown[]) => readCachedLibraryList(...args),
    prependCachedLibraryDocument: (...args: unknown[]) => prependCachedLibraryDocument(...args),
    fetchLibraryBootstrap: (...args: unknown[]) => fetchLibraryBootstrap(...args),
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

const ShellPage = ({ name }: { name: string }) => {
    const { uploadLimit, openPricing } = useOutletContext<LibraryOutletContext>();
    return (
        <div>
            <Page name={name} />
            {uploadLimit ? <LimitReachedNotice limit={uploadLimit} onUpgrade={openPricing} /> : null}
        </div>
    );
};

/** Drives onImportImslp the way ImslpBrowser does, with a cancel handle. */
const importControl = { controller: new AbortController() };
const ImportPage = () => {
    const { onImportImslp, uploadError } = useOutletContext<LibraryOutletContext>();
    return (
        <div>
            <p>search page</p>
            <button
                type="button"
                onClick={() => {
                    importControl.controller = new AbortController();
                    void onImportImslp('a.pdf', 'Sonata', true, undefined, importControl.controller.signal).catch(
                        () => undefined,
                    );
                }}
            >
                import
            </button>
            {uploadError ? <p>error: {uploadError}</p> : null}
        </div>
    );
};

const listSnapshot = (documents: Array<{ id: string; owner_id: string; archived_at: string | null }>) => ({
    documents,
    hasMore: false,
    favoriteIds: new Set(),
    tags: [],
    documentTags: new Map(),
    entitlements: entitlementsState.current,
    fetchedAtEpoch: 0,
});

const ownedDoc = (id: string, ownerId = 'teacher-1') => ({ id, owner_id: ownerId, archived_at: null });

const renderShell = (initialEntry = '/library') =>
    render(
        <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
                <Route element={<LibraryShell />}>
                    <Route path="/library" element={<ShellPage name="library page" />} />
                    <Route path="/students" element={<ShellPage name="students page" />} />
                    <Route path="/search" element={<ImportPage />} />
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
    beforeEach(() => {
        entitlementsState.current = entitlementsState.unlimited;
        fetchLibraryBootstrap.mockResolvedValue(listSnapshot([]));
        readCachedLibraryList.mockResolvedValue(null);
    });
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

    it('opens an imported IMSLP score', async () => {
        const user = userEvent.setup();
        importDocumentFromImslp.mockResolvedValue({ ok: true, document: { id: 'd3', title: 'Sonata' } });
        renderShell('/search');

        await user.click(screen.getByRole('button', { name: 'import' }));

        expect(await screen.findByText('viewer page')).toBeInTheDocument();
        expect(importDocumentFromImslp).toHaveBeenCalledWith('a.pdf', 'Sonata', 'teacher-1', true, {
            onStage: undefined,
            signal: importControl.controller.signal,
        });
    });

    it('keeps a score that lands after the user cancelled, without pulling them back to it', async () => {
        const user = userEvent.setup();
        let land: ((value: unknown) => void) | undefined;
        importDocumentFromImslp.mockReturnValue(
            new Promise((resolve) => {
                land = resolve;
            }),
        );
        prependCachedLibraryDocument.mockResolvedValue(undefined);
        renderShell('/search');

        await user.click(screen.getByRole('button', { name: 'import' }));
        await waitFor(() => expect(importDocumentFromImslp).toHaveBeenCalled());
        importControl.controller.abort();
        const document = { id: 'd4', title: 'Sonata', owner_id: 'teacher-1', archived_at: null };
        land?.({ ok: true, document });

        await waitFor(() => expect(prependCachedLibraryDocument).toHaveBeenCalledWith('teacher-1', null, document));
        expect(screen.getByText('search page')).toBeInTheDocument();
        expect(screen.queryByText('viewer page')).not.toBeInTheDocument();
    });

    it('reports a failed IMSLP import, but not one the user cancelled while queued', async () => {
        const user = userEvent.setup();
        const { ImslpImportCancelledError } = await import('@/features/imslp/imslpApi');
        importDocumentFromImslp.mockRejectedValueOnce(new ImslpImportCancelledError());
        renderShell('/search');

        await user.click(screen.getByRole('button', { name: 'import' }));
        await waitFor(() => expect(importDocumentFromImslp).toHaveBeenCalledTimes(1));
        expect(screen.queryByText(/^error:/)).not.toBeInTheDocument();

        importDocumentFromImslp.mockRejectedValueOnce(new Error('IMSLP is down'));
        await user.click(screen.getByRole('button', { name: 'import' }));
        expect(await screen.findByText('error: IMSLP is down')).toBeInTheDocument();
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

    it('refuses upload at the owned-score cap with no progress bar and no unprompted notice', async () => {
        entitlementsState.current = freeEntitlements();
        const docs = [ownedDoc('d1'), ownedDoc('d2'), ownedDoc('d3')];
        fetchLibraryBootstrap.mockResolvedValue(listSnapshot(docs));
        readCachedLibraryList.mockResolvedValue(listSnapshot(docs));
        renderShell();

        const input = await screen.findByLabelText('Upload score', { selector: 'input' });
        await waitFor(() => expect(input).toBeDisabled());
        expect(uploadDocument).not.toHaveBeenCalled();
        expect(screen.queryByRole('progressbar', { name: 'Uploading score' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'See plans' })).not.toBeInTheDocument();
        expect(screen.queryByText(/reached your 3 free cloud scores/)).not.toBeInTheDocument();
    });

    it('does not show a limit notice below the cap', async () => {
        entitlementsState.current = freeEntitlements();
        const docs = [ownedDoc('d1'), ownedDoc('d2')];
        fetchLibraryBootstrap.mockResolvedValue(listSnapshot(docs));
        readCachedLibraryList.mockResolvedValue(listSnapshot(docs));
        renderShell();

        const input = await screen.findByLabelText('Upload score', { selector: 'input' });
        await waitFor(() => expect(fetchLibraryBootstrap).toHaveBeenCalled());
        expect(input).not.toBeDisabled();
        expect(screen.queryByRole('button', { name: 'See plans' })).not.toBeInTheDocument();
        expect(screen.queryByText(/reached your 3 free cloud scores/)).not.toBeInTheDocument();
    });

    it('does not treat a shared-only library as at the cap', async () => {
        entitlementsState.current = freeEntitlements();
        const docs = [ownedDoc('s1', 'someone-else'), ownedDoc('s2', 'someone-else'), ownedDoc('s3', 'someone-else')];
        fetchLibraryBootstrap.mockResolvedValue(listSnapshot(docs));
        readCachedLibraryList.mockResolvedValue(listSnapshot(docs));
        renderShell();

        const input = await screen.findByLabelText('Upload score', { selector: 'input' });
        await waitFor(() => expect(fetchLibraryBootstrap).toHaveBeenCalled());
        expect(input).not.toBeDisabled();
        expect(screen.queryByRole('button', { name: 'See plans' })).not.toBeInTheDocument();
        expect(screen.queryByText(/reached your 3 free cloud scores/)).not.toBeInTheDocument();
    });

    it('disables upload for a student without an upgrade notice', async () => {
        entitlementsState.current = studentEntitlements();
        fetchLibraryBootstrap.mockResolvedValue(listSnapshot([]));
        readCachedLibraryList.mockResolvedValue(listSnapshot([]));
        renderShell();

        const input = await screen.findByLabelText('Upload score', { selector: 'input' });
        expect(input).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'See plans' })).not.toBeInTheDocument();
        expect(screen.queryByText(/reached your 0 free cloud scores/)).not.toBeInTheDocument();
        expect(screen.queryByText(/Upgrade for unlimited scores/)).not.toBeInTheDocument();
    });
});
