import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LibraryShell } from '@/features/library/LibraryShell';
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
vi.mock('@/features/library/documentsService', () => ({
    importDocumentFromImslp: vi.fn(),
    loadDocumentBytes: vi.fn(),
    uploadDocument: (...args: unknown[]) => uploadDocument(...args),
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

vi.mock('@/features/playback/scoreAnalysisService', () => ({
    requestScoreAnalysis: vi.fn(),
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

const renderShell = () =>
    render(
        <MemoryRouter initialEntries={['/library']}>
            <Routes>
                <Route element={<LibraryShell />}>
                    <Route path="/library" element={<Page name="library page" />} />
                    <Route path="/students" element={<Page name="students page" />} />
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
        const { requestScoreAnalysis } = await import('@/features/playback/scoreAnalysisService');
        vi.mocked(requestScoreAnalysis).mockResolvedValue(undefined as never);
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
});
