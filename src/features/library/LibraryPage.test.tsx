import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryMutationEpoch, noteLibraryMutation } from '@/features/library/libraryCache';
import { LibraryPage } from '@/features/library/LibraryPage';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { DocumentRow, LibraryTagRow } from '@/types/database';

const listDocuments = vi.fn();
const listCachedDocuments = vi.fn();
const listFavoriteDocumentIds = vi.fn();
const setDocumentFavorite = vi.fn();
const renameDocument = vi.fn();
const deleteDocument = vi.fn();
const listLibraryTags = vi.fn();
const listDocumentTagMap = vi.fn();
const createLibraryTag = vi.fn();
const renameLibraryTag = vi.fn();
const deleteLibraryTag = vi.fn();
const setDocumentTag = vi.fn();
const fetchLibraryBootstrap = vi.fn();
const readCachedLibraryList = vi.fn();

vi.mock('@/features/library/documentsService', () => ({
    listDocuments: (...args: unknown[]) => listDocuments(...args),
    listCachedDocuments: (...args: unknown[]) => listCachedDocuments(...args),
    listFavoriteDocumentIds: (...args: unknown[]) => listFavoriteDocumentIds(...args),
    setDocumentFavorite: (...args: unknown[]) => setDocumentFavorite(...args),
    renameDocument: (...args: unknown[]) => renameDocument(...args),
    deleteDocument: (...args: unknown[]) => deleteDocument(...args),
}));

vi.mock('@/features/library/libraryBootstrap', () => ({
    fetchLibraryBootstrap: (...args: unknown[]) => fetchLibraryBootstrap(...args),
    readCachedLibraryList: (...args: unknown[]) => readCachedLibraryList(...args),
}));

vi.mock('@/features/library/tagsService', () => ({
    listLibraryTags: (...args: unknown[]) => listLibraryTags(...args),
    listDocumentTagMap: (...args: unknown[]) => listDocumentTagMap(...args),
    createLibraryTag: (...args: unknown[]) => createLibraryTag(...args),
    renameLibraryTag: (...args: unknown[]) => renameLibraryTag(...args),
    deleteLibraryTag: (...args: unknown[]) => deleteLibraryTag(...args),
    setDocumentTag: (...args: unknown[]) => setDocumentTag(...args),
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
    content_rev: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived_at: null,
});

const tag = (id: string, name: string): LibraryTagRow => ({
    id,
    user_id: 'teacher-1',
    name,
    created_at: '2026-08-01T00:00:00Z',
});

const FREE_ENTITLEMENTS = {
    user_id: 'teacher-1',
    tier: 'free' as const,
    status: null,
    source: 'none' as const,
    current_period_end: null,
    limits: {
        cloud_scores: 3,
        omr_runs: 3,
        vision_reads: 5,
        smart_imports: 2,
        pdf_exports: 1,
        students: 0,
    },
};

const mockBootstrap = (
    overrides: {
        documents?: DocumentRow[];
        hasMore?: boolean;
        favoriteIds?: Set<string>;
        tags?: LibraryTagRow[];
        documentTags?: Map<string, string[]>;
    } = {},
) => {
    // Resolved lazily so fetchedAtEpoch is honest even for a test that bumps
    // the epoch before the page mounts.
    fetchLibraryBootstrap.mockImplementation(async () => ({
        documents: overrides.documents ?? [
            doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
            doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
        ],
        hasMore: overrides.hasMore ?? false,
        favoriteIds: overrides.favoriteIds ?? new Set(),
        tags: overrides.tags ?? [],
        documentTags: overrides.documentTags ?? new Map(),
        entitlements: FREE_ENTITLEMENTS,
        fetchedAtEpoch: libraryMutationEpoch(),
    }));
};

const outletContext: LibraryOutletContext = {
    userId: 'teacher-1',
    uploadPct: null,
    uploading: false,
    onUpload: vi.fn(),
    onImportImslp: vi.fn(),
    uploadError: null,
    clearUploadError: vi.fn(),
    uploadLimit: null,
    tier: 'free',
    canManageStudents: true,
    openPricing: vi.fn(),
};

/**
 * Node defines a `localStorage` global whose getter returns undefined unless
 * the process was started with --localstorage-file, and under vitest's jsdom
 * environment `window` IS globalThis — so that getter shadows the Storage jsdom
 * built and `window.localStorage` reads as undefined.
 *
 * The page survives that on its own (libraryPrefs treats a throwing store as
 * "nothing saved" and falls back to the shelf), but these tests need a store
 * they can seed, so they bring their own.
 */
const memoryStorage = (): Storage => {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        key: (i: number) => [...entries.keys()][i] ?? null,
        getItem: (k: string) => entries.get(k) ?? null,
        setItem: (k: string, v: string) => void entries.set(k, String(v)),
        removeItem: (k: string) => void entries.delete(k),
        clear: () => entries.clear(),
    };
};

vi.stubGlobal('localStorage', memoryStorage());

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
    // The page now defaults to the shelf. Every assertion below is about the
    // list — its rows, its stretched links, its per-row controls — so the tests
    // pin the view rather than being rewritten around cards. The grid has its
    // own describe block at the end of this file.
    window.localStorage.setItem('cleffy:library-view', 'list');
    listDocuments.mockResolvedValue({
        documents: [
            doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
            doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
        ],
        hasMore: false,
    });
    listCachedDocuments.mockResolvedValue([]);
    readCachedLibraryList.mockResolvedValue(null);
    mockBootstrap();
    listFavoriteDocumentIds.mockResolvedValue(new Set());
    setDocumentFavorite.mockResolvedValue(undefined);
    listLibraryTags.mockResolvedValue([]);
    listDocumentTagMap.mockResolvedValue(new Map());
    setDocumentTag.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
});

describe('LibraryPage', () => {
    it('renders rows with favorite stars, tag buttons, and action menus', async () => {
        renderLibrary();
        expect(await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Add to favorites' })).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Add tags' })).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Score actions' })).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Add a tag…' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    });

    it('says “1 page”, not “1 pages”, for a single-page score', async () => {
        const docs = [{ ...doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'), page_count: 1 }];
        listDocuments.mockResolvedValue({ documents: docs, hasMore: false });
        mockBootstrap({ documents: docs });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        expect(screen.getByText(/1 page ·/)).toBeInTheDocument();
    });

    it('marks archived scores, which stay open but read-only', async () => {
        const docs = [
            doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
            { ...doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'), archived_at: '2026-08-01T00:00:00Z' },
        ];
        listDocuments.mockResolvedValue({ documents: docs, hasMore: false });
        mockBootstrap({ documents: docs });
        renderLibrary();

        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(screen.getAllByText('Archived')).toHaveLength(1);
        // Still a link — archived means read-only, never hidden or deleted.
        expect(screen.getByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' })).toHaveAttribute(
            'href',
            '/doc/d2',
        );
    });

    it('does not mark anything archived when nothing is', async () => {
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    });

    it('shows the limit-reached notice with an upgrade action instead of red error text', async () => {
        const user = userEvent.setup();
        const { LimitReachedError } = await import('@/features/billing/limitErrors');
        const openPricing = vi.fn();
        const context: LibraryOutletContext = {
            ...outletContext,
            openPricing,
            uploadLimit: new LimitReachedError({
                code: 'limit_reached',
                metric: 'cloud_scores',
                limit: 3,
                tier: 'free',
            }),
        };

        render(
            <MemoryRouter initialEntries={['/library']}>
                <Routes>
                    <Route element={<Outlet context={context} />}>
                        <Route path="/library" element={<LibraryPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        expect(await screen.findByText(/reached your 3 free cloud scores/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'See plans' }));
        expect(openPricing).toHaveBeenCalled();
    });

    it('shows a later failure alongside the limit notice instead of behind it', async () => {
        // The limit notice outlives the upload that raised it — nothing but the
        // next upload clears it — so rendering it INSTEAD of the status error hid
        // every later failure: the teacher deletes a score to make room, the
        // delete fails, and all they see is the same unchanged upgrade prompt.
        const user = userEvent.setup();
        const { LimitReachedError } = await import('@/features/billing/limitErrors');
        deleteDocument.mockRejectedValue(new Error('Network request failed'));
        const context: LibraryOutletContext = {
            ...outletContext,
            uploadLimit: new LimitReachedError({
                code: 'limit_reached',
                metric: 'cloud_scores',
                limit: 3,
                tier: 'free',
            }),
        };

        render(
            <MemoryRouter initialEntries={['/library']}>
                <Routes>
                    <Route element={<Outlet context={context} />}>
                        <Route path="/library" element={<LibraryPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        expect(await screen.findByText('Network request failed')).toBeInTheDocument();
        expect(screen.getByText(/reached your 3 free cloud scores/)).toBeInTheDocument();
        // The score is still there, which is the thing the error has to explain.
        expect(screen.getByText('An Chloe (Mozart, Wolfgang Amadeus)')).toBeInTheDocument();
    });

    it('drops the limit notice once a delete frees a slot', async () => {
        const user = userEvent.setup();
        const { LimitReachedError } = await import('@/features/billing/limitErrors');
        const clearUploadError = vi.fn();
        deleteDocument.mockResolvedValue(undefined);
        const context: LibraryOutletContext = {
            ...outletContext,
            clearUploadError,
            uploadLimit: new LimitReachedError({
                code: 'limit_reached',
                metric: 'cloud_scores',
                limit: 3,
                tier: 'free',
            }),
        };

        render(
            <MemoryRouter initialEntries={['/library']}>
                <Routes>
                    <Route element={<Outlet context={context} />}>
                        <Route path="/library" element={<LibraryPage />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(clearUploadError).toHaveBeenCalled());
    });

    it('toggles a favorite through the service', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        const stars = screen.getAllByRole('button', { name: 'Add to favorites' });
        await user.click(stars[0] as HTMLElement);
        expect(setDocumentFavorite).toHaveBeenCalledWith('d1', 'teacher-1', true);
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);
    });

    it('refetches instead of applying a bootstrap response that a favorite toggle outran', async () => {
        const user = userEvent.setup();
        // The Dexie snapshot paints an interactive grid while the network is out.
        readCachedLibraryList.mockResolvedValue({
            documents: [
                doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
            ],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
        });
        const bootFor = (favoriteIds: Set<string>) => ({
            // A deliberately different list from the snapshot: if the page ever
            // applied this stale payload, d2 would vanish from the grid.
            documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)')],
            hasMore: false,
            favoriteIds,
            tags: [],
            documentTags: new Map<string, string[]>(),
            entitlements: FREE_ENTITLEMENTS,
            fetchedAtEpoch: libraryMutationEpoch(),
        });
        let resolveBootstrap: (boot: unknown) => void = () => undefined;
        // First request: deferred, dispatched before the click. Later requests
        // (the page's refetch) answer with the post-toggle server state.
        fetchLibraryBootstrap
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveBootstrap = resolve;
                    }),
            )
            .mockImplementation(async () => ({
                documents: [
                    doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                    doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
                ],
                hasMore: false,
                favoriteIds: new Set(['d1']),
                tags: [],
                documentTags: new Map<string, string[]>(),
                entitlements: FREE_ENTITLEMENTS,
                fetchedAtEpoch: libraryMutationEpoch(),
            }));
        // The real service bumps the mutation epoch before its write; the mock
        // must mirror that, or the page cannot tell the response is stale.
        setDocumentFavorite.mockImplementation(async () => {
            noteLibraryMutation();
        });

        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        const staleBoot = bootFor(new Set<string>());
        const stars = screen.getAllByRole('button', { name: 'Add to favorites' });
        await user.click(stars[0] as HTMLElement);
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);

        // The response — a snapshot taken before the click — arrives late. The
        // page must refetch rather than turn the star off or drop d2.
        resolveBootstrap(staleBoot);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(fetchLibraryBootstrap.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' })).toBeInTheDocument();
    });

    it('keeps the painted, edit-bearing list when every refetch is outrun too', async () => {
        readCachedLibraryList.mockResolvedValue({
            documents: [
                doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
            ],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
        });
        // Every payload is permanently one epoch behind — the pathological
        // mutations-keep-racing case. The painted list already reflects the
        // user's edits, so the loop must exhaust WITHOUT applying any of them.
        fetchLibraryBootstrap.mockImplementation(async () => ({
            documents: [doc('d3', 'Etude (Chopin, Frederic)')],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
            entitlements: FREE_ENTITLEMENTS,
            fetchedAtEpoch: libraryMutationEpoch() - 1,
        }));

        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await waitFor(() => expect(fetchLibraryBootstrap).toHaveBeenCalledTimes(3));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.getByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Etude (Chopin, Frederic)' })).not.toBeInTheDocument();
    });

    it('still paints when a mutation raced the very first load and nothing was cached', async () => {
        // First visit / private mode: no snapshot, nothing painted yet — a
        // shell upload bumping the epoch mid-flight must not strand the page
        // on "Loading scores…".
        readCachedLibraryList.mockResolvedValue(null);
        let resolveBootstrap: (boot: unknown) => void = () => undefined;
        fetchLibraryBootstrap.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveBootstrap = resolve;
                }),
        );
        // Leave the beforeEach mockBootstrap() implementation for later calls.

        renderLibrary();
        expect(await screen.findByText('Loading scores…')).toBeInTheDocument();
        const staleEpoch = libraryMutationEpoch();
        noteLibraryMutation();
        resolveBootstrap({
            documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)')],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
            entitlements: FREE_ENTITLEMENTS,
            fetchedAtEpoch: staleEpoch,
        });

        expect(await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)')).toBeInTheDocument();
        expect(screen.queryByText('Loading scores…')).not.toBeInTheDocument();
        expect(fetchLibraryBootstrap.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('refetches the four-GET fallback too when a toggle outran it', async () => {
        const user = userEvent.setup();
        readCachedLibraryList.mockResolvedValue({
            documents: [
                doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
            ],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
        });
        // The RPC is unavailable on this deployment: every pass falls back.
        fetchLibraryBootstrap.mockRejectedValue(new Error('rpc missing'));
        let resolveDocs: (value: unknown) => void = () => undefined;
        listDocuments
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveDocs = resolve;
                    }),
            )
            .mockResolvedValue({
                documents: [
                    doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                    doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
                ],
                hasMore: false,
            });
        listFavoriteDocumentIds.mockResolvedValueOnce(new Set<string>()).mockResolvedValue(new Set(['d1']));
        setDocumentFavorite.mockImplementation(async () => {
            noteLibraryMutation();
        });

        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        const stars = screen.getAllByRole('button', { name: 'Add to favorites' });
        await user.click(stars[0] as HTMLElement);
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);

        resolveDocs({
            documents: [
                doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
                doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
            ],
            hasMore: false,
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        await waitFor(() => expect(listDocuments.mock.calls.length).toBeGreaterThanOrEqual(2));
        expect(screen.getAllByRole('button', { name: 'Remove from favorites' })).toHaveLength(1);
    });

    it('groups by composer with headers when toggled', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
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
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
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
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
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
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[0] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Share…' }));
        expect(screen.getByTestId('share-dialog')).toHaveTextContent('d1');
    });

    it('opens manage tags from Add a tag… bootstrap', async () => {
        const user = userEvent.setup();
        createLibraryTag.mockResolvedValue(tag('t-concert', 'Concert'));
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getByRole('button', { name: 'Add a tag…' }));
        expect(screen.getByRole('dialog', { name: 'Manage tags' })).toBeInTheDocument();
        await user.type(screen.getByLabelText('New tag name'), 'Concert');
        await user.click(screen.getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(createLibraryTag).toHaveBeenCalledWith('teacher-1', 'Concert'));
        expect(setDocumentTag).not.toHaveBeenCalled();
    });

    it('creates a tag from the row tag button, assigns it, and filters the library', async () => {
        const user = userEvent.setup();
        const concert = tag('t-concert', 'Concert');
        createLibraryTag.mockResolvedValue(concert);
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

        await user.click(screen.getAllByRole('button', { name: 'Add tags' })[0] as HTMLElement);
        expect(screen.getByRole('dialog', { name: 'Tags' })).toBeInTheDocument();

        await user.type(screen.getByLabelText('New tag name'), 'Concert');
        await user.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() => expect(createLibraryTag).toHaveBeenCalledWith('teacher-1', 'Concert'));
        await waitFor(() => expect(setDocumentTag).toHaveBeenCalledWith('d1', 't-concert', true));

        await user.click(screen.getByRole('button', { name: 'Done' }));

        // Filter-bar chip has aria-pressed; inline row label does not.
        const filterChip = await screen.findByRole('button', { name: 'Concert', pressed: false });
        await user.click(filterChip);

        expect(screen.getByText('Prelude and Fugue (Bach, Johann Sebastian)')).toBeInTheDocument();
        expect(screen.queryByText('An Chloe (Mozart, Wolfgang Amadeus)')).not.toBeInTheDocument();
    });

    it('assigns an existing tag from the row dialog and filters via the inline label', async () => {
        const user = userEvent.setup();
        const tags = [tag('t-lesson', 'Lesson')];
        listLibraryTags.mockResolvedValue(tags);
        listDocumentTagMap.mockResolvedValue(new Map());
        mockBootstrap({ tags, documentTags: new Map() });
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(await screen.findByRole('button', { name: 'Lesson', pressed: false })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();

        await user.click(screen.getAllByRole('button', { name: 'Add tags' })[1] as HTMLElement);
        await user.click(screen.getByRole('checkbox', { name: 'Lesson' }));
        await waitFor(() => expect(setDocumentTag).toHaveBeenCalledWith('d2', 't-lesson', true));
        await user.click(screen.getByRole('button', { name: 'Done' }));

        // Inline label on the Mozart row (list item containing the title).
        const mozartRow = screen.getByText('An Chloe (Mozart, Wolfgang Amadeus)').closest('li');
        expect(mozartRow).not.toBeNull();
        await user.click(within(mozartRow as HTMLElement).getByRole('button', { name: 'Lesson' }));

        expect(screen.getByText('An Chloe (Mozart, Wolfgang Amadeus)')).toBeInTheDocument();
        expect(screen.queryByText('Prelude and Fugue (Bach, Johann Sebastian)')).not.toBeInTheDocument();
    });

    it('groups by tag when toggled', async () => {
        const user = userEvent.setup();
        const tags = [tag('t-concert', 'Concert')];
        const documentTags = new Map([['d1', ['t-concert']]]);
        listLibraryTags.mockResolvedValue(tags);
        listDocumentTagMap.mockResolvedValue(documentTags);
        mockBootstrap({ tags, documentTags });
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(await screen.findByRole('button', { name: 'Group by tag' }));
        expect(screen.getByRole('heading', { name: 'Concert' })).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Untagged' })).toBeInTheDocument();
    });
});

describe('grid view', () => {
    // Nothing stored: these exercise the shipped default rather than a seed.
    beforeEach(() => {
        window.localStorage.removeItem('cleffy:library-view');
    });

    it('defaults to the shelf when nothing is stored', async () => {
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'false');
        // Cards carry no inline tag button — that is the list row's job.
        expect(screen.queryAllByRole('button', { name: 'Add tags' })).toHaveLength(0);
    });

    it('gives every card a link named by the score, with the star and menu still reachable', async () => {
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

        expect(screen.getByRole('link', { name: 'Prelude and Fugue (Bach, Johann Sebastian)' })).toHaveAttribute(
            'href',
            '/doc/d1',
        );
        expect(screen.getByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' })).toHaveAttribute(
            'href',
            '/doc/d2',
        );
        // Faded out until hover, but never removed: keyboard users tab to them.
        expect(screen.getAllByRole('button', { name: 'Add to favorites' })).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Score actions' })).toHaveLength(2);
    });

    it('drops the composer suffix from cards under a composer heading', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getByRole('button', { name: 'Group by composer' }));

        expect(screen.getByRole('heading', { name: 'Mozart, Wolfgang Amadeus' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'An Chloe' })).toBeInTheDocument();
    });

    it('offers the add-a-score tile only on an unfiltered, ungrouped shelf', async () => {
        const user = userEvent.setup();
        const tags = [tag('t-lesson', 'Lesson')];
        const documentTags = new Map([['d1', ['t-lesson']]]);
        listLibraryTags.mockResolvedValue(tags);
        listDocumentTagMap.mockResolvedValue(documentTags);
        mockBootstrap({ tags, documentTags });
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(screen.getByText('Add a score')).toBeInTheDocument();

        // A tag filter turns the shelf into a result set — no tile.
        await user.click(await screen.findByRole('button', { name: 'Lesson', pressed: false }));
        expect(screen.queryByText('Add a score')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Lesson', pressed: true }));
        expect(screen.getByText('Add a score')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Search scores'), 'chloe');
        expect(screen.queryByText('Add a score')).not.toBeInTheDocument();
    });

    it('hides the tile under a grouping, where it would have to pick a group', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        await user.click(screen.getByRole('button', { name: 'Group by composer' }));
        expect(screen.queryByText('Add a score')).not.toBeInTheDocument();
    });

    it('swaps to rows and remembers the choice when List view is picked', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

        await user.click(screen.getByRole('button', { name: 'List view' }));

        expect(window.localStorage.getItem('cleffy:library-view')).toBe('list');
        expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getAllByRole('button', { name: 'Add tags' })).toHaveLength(2);
        expect(screen.getByText('An Chloe (Mozart, Wolfgang Amadeus)').closest('li')).not.toBeNull();
        expect(screen.queryByText('Add a score')).not.toBeInTheDocument();
    });
});

describe('plans without a roster', () => {
    beforeEach(() => {
        window.localStorage.setItem('cleffy:library-view', 'list');
        outletContext.canManageStudents = false;
    });
    afterEach(() => {
        outletContext.canManageStudents = true;
    });

    it('drops the assign action from the score menu', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[0]!);

        // The rest of the menu is untouched — only the roster action goes.
        expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Assign to student…' })).not.toBeInTheDocument();
    });
});
