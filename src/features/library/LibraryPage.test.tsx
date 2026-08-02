import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryPage } from '@/features/library/LibraryPage';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { DocumentRow } from '@/types/database';

const listDocuments = vi.fn();
const listCachedDocuments = vi.fn();
const listFavoriteDocumentIds = vi.fn();
const setDocumentFavorite = vi.fn();
const renameDocument = vi.fn();
const deleteDocument = vi.fn();

vi.mock('@/features/library/documentsService', () => ({
    listDocuments: (...args: unknown[]) => listDocuments(...args),
    listCachedDocuments: (...args: unknown[]) => listCachedDocuments(...args),
    listFavoriteDocumentIds: (...args: unknown[]) => listFavoriteDocumentIds(...args),
    setDocumentFavorite: (...args: unknown[]) => setDocumentFavorite(...args),
    renameDocument: (...args: unknown[]) => renameDocument(...args),
    deleteDocument: (...args: unknown[]) => deleteDocument(...args),
}));

vi.mock('@/features/share/ShareDialog', () => ({
    ShareDialog: ({ docId }: { docId: string }) => <div data-testid="share-dialog">{docId}</div>,
}));

const doc = (id: string, title: string): DocumentRow => ({
    id,
    owner_id: 'teacher-1',
    title,
    storage_path: `${id}/original.pdf`,
    page_count: 3,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
});

const outletContext: LibraryOutletContext = {
    userId: 'teacher-1',
    uploadPct: null,
    uploading: false,
    onUpload: vi.fn(),
    onImportImslp: vi.fn(),
    uploadError: null,
    clearUploadError: vi.fn(),
};

const ContextFrame = () => <Outlet context={outletContext} />;

const renderLibrary = () =>
    render(
        <MemoryRouter initialEntries={['/library']}>
            <Routes>
                <Route element={<ContextFrame />}>
                    <Route path="/library" element={<LibraryPage />} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    listDocuments.mockResolvedValue({
        documents: [
            doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
            doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
        ],
        hasMore: false,
    });
    listFavoriteDocumentIds.mockResolvedValue(new Set());
    setDocumentFavorite.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
});

describe('LibraryPage', () => {
    it('renders rows with favorite stars and action menus', async () => {
        renderLibrary();
        expect(await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Add to favorites' })).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Score actions' })).toHaveLength(2);
    });

    it('toggles a favorite through the service', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByText('An Chloe (Mozart, Wolfgang Amadeus)');
        const stars = screen.getAllByRole('button', { name: 'Add to favorites' });
        await user.click(stars[0] as HTMLElement);
        expect(setDocumentFavorite).toHaveBeenCalledWith('d1', 'teacher-1', true);
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);
    });

    it('groups by composer with headers when toggled', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByText('An Chloe (Mozart, Wolfgang Amadeus)');
        await user.click(screen.getByRole('button', { name: 'Group by composer' }));
        expect(screen.getByRole('heading', { name: 'Bach, Johann Sebastian' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Mozart, Wolfgang Amadeus' })).toBeInTheDocument();
        // Grouped rows drop the composer suffix — the header carries it.
        expect(screen.getByText('An Chloe')).toBeInTheDocument();
    });

    it('opens the row menu and drives rename through the service', async () => {
        const user = userEvent.setup();
        renameDocument.mockResolvedValue(undefined);
        renderLibrary();
        await screen.findByText('An Chloe (Mozart, Wolfgang Amadeus)');
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[0] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
        const field = screen.getByLabelText('Title');
        await user.clear(field);
        await user.type(field, 'BWV 855');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(renameDocument).toHaveBeenCalledWith('d1', 'BWV 855'));
        expect(await screen.findByText('BWV 855')).toBeInTheDocument();
    });

    it('deletes after confirmation', async () => {
        const user = userEvent.setup();
        deleteDocument.mockResolvedValue(undefined);
        renderLibrary();
        await screen.findByText('An Chloe (Mozart, Wolfgang Amadeus)');
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        expect(screen.getByRole('dialog', { name: 'Delete this score?' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(deleteDocument).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' })));
        await waitFor(() => expect(screen.queryByText('An Chloe (Mozart, Wolfgang Amadeus)')).not.toBeInTheDocument());
    });

    it('opens the share dialog for a row', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByText('An Chloe (Mozart, Wolfgang Amadeus)');
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[0] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
        expect(screen.getByTestId('share-dialog')).toHaveTextContent('d1');
    });
});
