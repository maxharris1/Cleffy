import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as InstallSurfaceModule from '@/features/install/installSurface';
import { libraryMutationEpoch, noteLibraryMutation } from '@/features/library/libraryCache';
import { LibraryPage } from '@/features/library/LibraryPage';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { DocumentRow, LibraryTagRow } from '@/types/database';

const listDocuments = vi.fn();
const listFavoriteDocumentIds = vi.fn();
const setDocumentFavorite = vi.fn();
const renameDocument = vi.fn();
const deleteDocument = vi.fn();
const leaveSharedDocument = vi.fn();
const fetchLibraryPage = vi.fn();
const sweepPendingStorageCleanup = vi.fn();
const listLibraryTags = vi.fn();
const listDocumentTagMap = vi.fn();
const createLibraryTag = vi.fn();
const renameLibraryTag = vi.fn();
const deleteLibraryTag = vi.fn();
const setDocumentTag = vi.fn();
const fetchLibraryBootstrap = vi.fn();
const readCachedLibraryList = vi.fn();
const writeCachedLibraryList = vi.fn();

vi.mock('@/features/library/documentsService', () => ({
    LIBRARY_PAGE_SIZE: 100,
    fetchLibraryPage: (...args: unknown[]) => fetchLibraryPage(...args),
    sweepPendingStorageCleanup: (...args: unknown[]) => sweepPendingStorageCleanup(...args),
    listDocuments: (...args: unknown[]) => listDocuments(...args),
    listFavoriteDocumentIds: (...args: unknown[]) => listFavoriteDocumentIds(...args),
    setDocumentFavorite: (...args: unknown[]) => setDocumentFavorite(...args),
    renameDocument: (...args: unknown[]) => renameDocument(...args),
    deleteDocument: (...args: unknown[]) => deleteDocument(...args),
    leaveSharedDocument: (...args: unknown[]) => leaveSharedDocument(...args),
}));

vi.mock('@/features/library/libraryBootstrap', () => ({
    fetchLibraryBootstrap: (...args: unknown[]) => fetchLibraryBootstrap(...args),
    readCachedLibraryList: (...args: unknown[]) => readCachedLibraryList(...args),
    writeCachedLibraryList: (...args: unknown[]) => writeCachedLibraryList(...args),
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

const resolveInstallSurface = vi.fn((_canPromptInstall = false): InstallSurfaceModule.InstallSurface => 'other');

vi.mock('@/features/install/installSurface', async () => {
    const actual = await vi.importActual<typeof InstallSurfaceModule>('@/features/install/installSurface');
    return {
        ...actual,
        resolveInstallSurface: (canPromptInstall?: boolean) => resolveInstallSurface(canPromptInstall),
    };
});

const doc = (id: string, title: string): DocumentRow => ({
    id,
    owner_id: 'teacher-1',
    title,
    storage_path: `${id}/original.pdf`,
    page_count: 3,
    content_rev: 0,
    thumb_rev: null,
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
    window.localStorage.removeItem('cleffy:home-screen-prompt-dismissed');
    resolveInstallSurface.mockReturnValue('other');
    listDocuments.mockResolvedValue({
        documents: [
            doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
            doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
        ],
        hasMore: false,
    });
    readCachedLibraryList.mockResolvedValue(null);
    writeCachedLibraryList.mockResolvedValue(undefined);
    mockBootstrap();
    listFavoriteDocumentIds.mockResolvedValue(new Set());
    setDocumentFavorite.mockResolvedValue(undefined);
    listLibraryTags.mockResolvedValue([]);
    listDocumentTagMap.mockResolvedValue(new Map());
    setDocumentTag.mockResolvedValue(undefined);
    fetchLibraryPage.mockResolvedValue({ documents: [], hasMore: false });
    sweepPendingStorageCleanup.mockResolvedValue(undefined);
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

    it('takes the last payload on an unpainted page even when every pass was outrun', async () => {
        // Nothing cached AND payloads permanently one epoch behind: the loop
        // must exhaust and still paint — anything beats no list at all.
        readCachedLibraryList.mockResolvedValue(null);
        fetchLibraryBootstrap.mockImplementation(async () => ({
            documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)')],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
            entitlements: FREE_ENTITLEMENTS,
            fetchedAtEpoch: libraryMutationEpoch() - 1,
        }));

        renderLibrary();
        expect(await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)')).toBeInTheDocument();
        expect(fetchLibraryBootstrap).toHaveBeenCalledTimes(3);
        expect(screen.queryByText('Loading scores…')).not.toBeInTheDocument();
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

    it('dispatches the bootstrap before the snapshot read resolves, and skips the paint a fresh answer beat', async () => {
        const order: string[] = [];
        let releaseCache: (value: unknown) => void = () => undefined;
        readCachedLibraryList.mockImplementation(
            () =>
                new Promise((resolve) => {
                    order.push('cache-read');
                    releaseCache = resolve;
                }),
        );
        fetchLibraryBootstrap.mockImplementation(async () => {
            order.push('bootstrap');
            return {
                documents: [doc('d1', 'Fresh from the server')],
                hasMore: false,
                favoriteIds: new Set<string>(),
                tags: [],
                documentTags: new Map<string, string[]>(),
                entitlements: FREE_ENTITLEMENTS,
                fetchedAtEpoch: libraryMutationEpoch(),
            };
        });
        renderLibrary();

        await waitFor(() => expect(order).toEqual(['bootstrap', 'cache-read']));
        // The network answered while IndexedDB was still opening.
        await new Promise((r) => setTimeout(r, 10));
        releaseCache({
            documents: [doc('d1', 'Stale snapshot title')],
            hasMore: false,
            favoriteIds: new Set<string>(),
            tags: [],
            documentTags: new Map<string, string[]>(),
        });

        // Flush the cache-paint microtask before waiting on the fresh title —
        // otherwise a reverted firstResolved guard can paint stale and then
        // overwrite it, and findByText still passes.
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.queryByText('Stale snapshot title')).not.toBeInTheDocument();
        expect(await screen.findByText('Fresh from the server')).toBeInTheDocument();
    });

    describe('snapshot write-through', () => {
        it('persists the post-edit list after a favorite lands, so the next visit paints it', async () => {
            const user = userEvent.setup();
            renderLibrary();
            await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
            expect(writeCachedLibraryList).not.toHaveBeenCalled();

            await user.click(screen.getAllByRole('button', { name: 'Add to favorites' })[0] as HTMLElement);

            await waitFor(() => expect(writeCachedLibraryList).toHaveBeenCalledTimes(1));
            const [userId, snapshot] = writeCachedLibraryList.mock.calls[0] as [string, { favoriteIds: Set<string> }];
            expect(userId).toBe('teacher-1');
            expect([...snapshot.favoriteIds]).toEqual(['d1']);
        });

        it('does not persist a favorite the server refused', async () => {
            const user = userEvent.setup();
            setDocumentFavorite.mockRejectedValue(new Error('offline'));
            renderLibrary();
            await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');

            await user.click(screen.getAllByRole('button', { name: 'Add to favorites' })[0] as HTMLElement);

            await screen.findByText('offline');
            expect(writeCachedLibraryList).not.toHaveBeenCalled();
        });

        it('persists the list without a deleted score', async () => {
            const user = userEvent.setup();
            deleteDocument.mockResolvedValue(undefined);
            renderLibrary();
            await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
            await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
            await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
            await user.click(screen.getByRole('button', { name: 'Delete' }));

            await waitFor(() => expect(writeCachedLibraryList).toHaveBeenCalledTimes(1));
            const [, snapshot] = writeCachedLibraryList.mock.calls[0] as [string, { documents: DocumentRow[] }];
            expect(snapshot.documents.map((d) => d.id)).toEqual(['d1']);
        });

        it('does not paint another account’s opened PDF when this user’s snapshot is empty', async () => {
            fetchLibraryBootstrap.mockRejectedValue(new Error('offline'));
            listDocuments.mockRejectedValue(new Error('offline'));
            renderLibrary();
            expect(await screen.findByText('Couldn’t load your scores')).toBeInTheDocument();
            expect(screen.queryByText('Someone else’s score')).not.toBeInTheDocument();
            expect(writeCachedLibraryList).not.toHaveBeenCalled();
        });

        it('says it is offline, not empty, when a never-loaded library cannot be reached', async () => {
            fetchLibraryBootstrap.mockRejectedValue(new TypeError('Failed to fetch'));
            listDocuments.mockRejectedValue(new TypeError('Failed to fetch'));
            renderLibrary();

            expect(await screen.findByText('You’re offline')).toBeInTheDocument();
            expect(screen.getByText('Your library will appear when you reconnect.')).toBeInTheDocument();
            expect(screen.queryByText('No scores yet')).not.toBeInTheDocument();
            expect(screen.queryByText(/TypeError|Failed to fetch/)).not.toBeInTheDocument();
        });

        it('loads the library by itself once the browser reconnects', async () => {
            fetchLibraryBootstrap.mockRejectedValue(new TypeError('Failed to fetch'));
            listDocuments.mockRejectedValue(new TypeError('Failed to fetch'));
            renderLibrary();
            await screen.findByText('You’re offline');

            mockBootstrap({ documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)')] });
            await act(async () => {
                window.dispatchEvent(new Event('online'));
            });

            expect(
                await screen.findByRole('link', { name: 'Prelude and Fugue (Bach, Johann Sebastian)' }),
            ).toBeInTheDocument();
            expect(screen.queryByText('You’re offline')).not.toBeInTheDocument();
        });

        it('offers to try again when the server fails, without its raw error', async () => {
            const user = userEvent.setup();
            fetchLibraryBootstrap.mockRejectedValue(new Error('Could not load scores: 500 internal'));
            listDocuments.mockRejectedValue(new Error('Could not load documents: 500 internal'));
            renderLibrary();
            await screen.findByText('Couldn’t load your scores');
            expect(screen.queryByText(/500 internal/)).not.toBeInTheDocument();

            mockBootstrap({ documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)')] });
            await user.click(screen.getByRole('button', { name: 'Try again' }));
            expect(
                await screen.findByRole('link', { name: 'Prelude and Fugue (Bach, Johann Sebastian)' }),
            ).toBeInTheDocument();
        });
    });

    describe('scores shared with you', () => {
        const shared = { ...doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'), owner_id: 'someone-else' };

        beforeEach(() => {
            mockBootstrap({
                documents: [doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'), shared],
                favoriteIds: new Set(['d2']),
                documentTags: new Map([['d2', ['t1']]]),
                tags: [tag('t1', 'Recital')],
            });
        });

        it('offers only “Remove from my library” in a shared score’s menu', async () => {
            const user = userEvent.setup();
            renderLibrary();
            await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

            await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
            expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Remove from my library']);
        });

        it('leaves after confirmation, then drops the score and persists the list without it', async () => {
            const user = userEvent.setup();
            leaveSharedDocument.mockResolvedValue(undefined);
            renderLibrary();
            await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

            await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
            await user.click(screen.getByRole('menuitem', { name: 'Remove from my library' }));
            const dialog = screen.getByRole('dialog', { name: 'Remove from your library?' });
            expect(dialog).toHaveTextContent('was shared with you');
            expect(leaveSharedDocument).not.toHaveBeenCalled();
            await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

            await waitFor(() => expect(leaveSharedDocument).toHaveBeenCalledWith('d2'));
            await waitFor(() =>
                expect(screen.queryByText('An Chloe (Mozart, Wolfgang Amadeus)')).not.toBeInTheDocument(),
            );
            await waitFor(() => expect(writeCachedLibraryList).toHaveBeenCalledTimes(1));
            const [, snapshot] = writeCachedLibraryList.mock.calls[0] as [
                string,
                { documents: DocumentRow[]; favoriteIds: Set<string>; documentTags: Map<string, string[]> },
            ];
            expect(snapshot.documents.map((d) => d.id)).toEqual(['d1']);
            expect([...snapshot.favoriteIds]).toEqual([]);
            expect(snapshot.documentTags.has('d2')).toBe(false);
        });

        it('keeps the score and shows why when leaving fails', async () => {
            const user = userEvent.setup();
            leaveSharedDocument.mockRejectedValue(new Error('Could not leave this score: offline'));
            renderLibrary();
            await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

            await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
            await user.click(screen.getByRole('menuitem', { name: 'Remove from my library' }));
            await user.click(screen.getByRole('button', { name: 'Remove' }));

            expect(await screen.findByText('Could not leave this score: offline')).toBeInTheDocument();
            expect(screen.getByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' })).toBeInTheDocument();
            expect(writeCachedLibraryList).not.toHaveBeenCalled();
        });

        it('offers the same action from a shelf card', async () => {
            const user = userEvent.setup();
            window.localStorage.setItem('cleffy:library-view', 'grid');
            leaveSharedDocument.mockResolvedValue(undefined);
            renderLibrary();
            await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });

            await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
            await user.click(screen.getByRole('menuitem', { name: 'Remove from my library' }));
            await user.click(screen.getByRole('button', { name: 'Remove' }));

            await waitFor(() => expect(leaveSharedDocument).toHaveBeenCalledWith('d2'));
        });
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

describe('pagination and server search', () => {
    const firstPage = [
        doc('d1', 'Prelude and Fugue (Bach, Johann Sebastian)'),
        doc('d2', 'An Chloe (Mozart, Wolfgang Amadeus)'),
    ];
    const olderScore = { ...doc('d3', 'Gymnopédie (Satie, Erik)'), updated_at: '2025-01-01T00:00:00.123456+00:00' };

    it('says the list is partial and appends the next keyset page on Load more', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage.mockResolvedValueOnce({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        expect(screen.getByText('Showing 2 most recent')).toBeInTheDocument();
        expect(screen.queryByText(/showing latest 100/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        // The cursor is the last row on screen, in the bootstrap's own order.
        expect(fetchLibraryPage).toHaveBeenCalledWith({ sort: 'recent', after: firstPage[1] });
        expect(screen.getByText('3 scores')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Load more scores' })).not.toBeInTheDocument();
    });

    it('never shows a score twice when it comes back on a later page', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage.mockResolvedValueOnce({ documents: [firstPage[1], olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        await screen.findByText('Gymnopédie (Satie, Erik)');
        expect(screen.getAllByText('An Chloe (Mozart, Wolfgang Amadeus)')).toHaveLength(1);
    });

    it('shows a failed page load and retries from the same place', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage
            .mockRejectedValueOnce(new Error('Could not load scores: offline'))
            .mockResolvedValueOnce({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        expect(
            await screen.findByText(/Couldn’t load more scores\. Could not load scores: offline/),
        ).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(fetchLibraryPage).toHaveBeenLastCalledWith({ sort: 'recent', after: firstPage[1] });
    });

    it('searches the server when not every score is loaded', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage.mockResolvedValue({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.type(screen.getByLabelText('Search scores'), 'gymno');
        // Found on the server although it was never in the loaded rows.
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(fetchLibraryPage).toHaveBeenLastCalledWith({
            sort: 'recent',
            query: 'gymno',
            tagId: null,
            favoritesOnly: false,
        });
        // Debounced: one request for the settled query, not one per keystroke.
        expect(fetchLibraryPage).toHaveBeenCalledTimes(1);
        expect(screen.getByText('1 found')).toBeInTheDocument();
        expect(screen.queryByText('Prelude and Fugue (Bach, Johann Sebastian)')).not.toBeInTheDocument();
    });

    it('keeps searching in memory when the whole library is already loaded', async () => {
        const user = userEvent.setup();
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.type(screen.getByLabelText('Search scores'), 'chloe');
        expect(screen.getByText('1 of 2')).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(fetchLibraryPage).not.toHaveBeenCalled();
    });

    it('filters by tag on the server beyond the first page', async () => {
        const user = userEvent.setup();
        const tags = [tag('t-recital', 'Recital')];
        mockBootstrap({ documents: firstPage, hasMore: true, tags, documentTags: new Map([['d3', ['t-recital']]]) });
        fetchLibraryPage.mockResolvedValue({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'Recital' }));
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(fetchLibraryPage).toHaveBeenCalledWith({
            sort: 'recent',
            query: '',
            tagId: 't-recital',
            favoritesOnly: false,
        });
    });

    it('asks the server for A–Z and keeps its order when the library is partial', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        const zFirst = [doc('d7', 'zebra'), doc('d8', 'Apple')];
        fetchLibraryPage.mockResolvedValue({ documents: zFirst, hasMore: true });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'A–Z' }));
        await screen.findByText('zebra');
        expect(fetchLibraryPage).toHaveBeenCalledWith(expect.objectContaining({ sort: 'title' }));
        const links = screen.getAllByRole('link').map((a) => a.textContent);
        expect(links.indexOf('zebra')).toBeLessThan(links.indexOf('Apple'));
        expect(screen.getByText('2+ scores, A–Z')).toBeInTheDocument();

        fetchLibraryPage.mockResolvedValueOnce({ documents: [doc('d9', 'Zz last')], hasMore: false });
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        await screen.findByText('Zz last');
        expect(fetchLibraryPage).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'title', after: zFirst[1] }));
    });

    it('falls back to the loaded matches, says so, and can retry when the server search fails', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage
            .mockRejectedValueOnce(new Error('Could not load scores: offline'))
            .mockResolvedValueOnce({ documents: [firstPage[1], olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.type(screen.getByLabelText('Search scores'), 'a');
        expect(await screen.findByText(/Couldn’t search all of your scores/)).toBeInTheDocument();
        // Loaded rows that match are still shown.
        expect(screen.getByText('An Chloe (Mozart, Wolfgang Amadeus)')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(screen.queryByText(/Couldn’t search all of your scores/)).not.toBeInTheDocument();
    });

    it('drops a deleted score from server results too', async () => {
        const user = userEvent.setup();
        deleteDocument.mockResolvedValue(undefined);
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage.mockResolvedValue({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.type(screen.getByLabelText('Search scores'), 'gymno');
        await screen.findByText('Gymnopédie (Satie, Erik)');
        await user.click(screen.getByRole('button', { name: 'Score actions' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(screen.queryByText('Gymnopédie (Satie, Erik)')).not.toBeInTheDocument());
    });

    it('snapshots only the first page so the next visit paints what the network will', async () => {
        const user = userEvent.setup();
        const many = Array.from({ length: 100 }, (_, i) => doc(`p${i}`, `Score ${i}`));
        mockBootstrap({ documents: many, hasMore: true });
        fetchLibraryPage.mockResolvedValueOnce({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Score 0');
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        await screen.findByText('Gymnopédie (Satie, Erik)');
        await user.click(screen.getAllByRole('button', { name: 'Add to favorites' })[0] as HTMLElement);
        await waitFor(() => expect(writeCachedLibraryList).toHaveBeenCalled());
        const snapshot = writeCachedLibraryList.mock.calls.at(-1)?.[1] as {
            documents: DocumentRow[];
            hasMore: boolean;
        };
        expect(snapshot.documents).toHaveLength(100);
        expect(snapshot.hasMore).toBe(true);
    });

    it('continues A–Z from the row the server sent, even after that row was renamed', async () => {
        const user = userEvent.setup();
        renameDocument.mockResolvedValue(undefined);
        mockBootstrap({ documents: firstPage, hasMore: true });
        const page = [doc('d7', 'Mazurka'), doc('d8', 'Nocturne')];
        fetchLibraryPage.mockResolvedValueOnce({ documents: page, hasMore: true });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'A–Z' }));
        await screen.findByText('Nocturne');

        // Rename the last loaded row to something that sorts first.
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[1] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
        const field = screen.getByLabelText('Title');
        await user.clear(field);
        await user.type(field, 'Aaa');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await screen.findByText('Aaa');

        fetchLibraryPage.mockResolvedValueOnce({ documents: [doc('d9', 'Polonaise')], hasMore: false });
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        await screen.findByText('Polonaise');
        const lastCall = fetchLibraryPage.mock.calls.at(-1)?.[0] as { after: DocumentRow };
        expect(lastCall.after).toMatchObject({ id: 'd8', title: 'Nocturne' });
    });

    it('drops an old failure banner once the same search succeeds', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage
            .mockRejectedValueOnce(new Error('Could not load scores: offline'))
            .mockResolvedValueOnce({ documents: [olderScore], hasMore: false });
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        const box = screen.getByLabelText('Search scores');
        await user.type(box, 'gymno');
        expect(await screen.findByText(/Couldn’t search all of your scores/)).toBeInTheDocument();
        await user.clear(box);
        await user.type(box, 'gymno');
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(screen.queryByText(/Couldn’t search all of your scores/)).not.toBeInTheDocument();
        expect(screen.getByText('1 found')).toBeInTheDocument();
    });

    it('keeps a delete made while the next page was loading', async () => {
        const user = userEvent.setup();
        deleteDocument.mockResolvedValue({ storageCleanup: Promise.resolve(true) });
        mockBootstrap({ documents: firstPage, hasMore: true });
        let release: (value: unknown) => void = () => undefined;
        fetchLibraryPage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'Load more scores' }));
        await user.click(screen.getAllByRole('button', { name: 'Score actions' })[0] as HTMLElement);
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(screen.queryByText('Prelude and Fugue (Bach, Johann Sebastian)')).not.toBeInTheDocument(),
        );
        await act(async () => {
            release({ documents: [olderScore], hasMore: false });
        });
        expect(await screen.findByText('Gymnopédie (Satie, Erik)')).toBeInTheDocument();
        expect(screen.queryByText('Prelude and Fugue (Bach, Johann Sebastian)')).not.toBeInTheDocument();
        expect(fetchLibraryPage).toHaveBeenCalledWith({ sort: 'recent', after: firstPage[1] });
    });

    it('stops scrolling into pages that add nothing new and leaves the button to the teacher', async () => {
        const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
        class FakeObserver {
            constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
                observers.push(callback);
            }
            observe() {
                // A sentinel already in view reports at once, as browsers do.
                queueMicrotask(() => observers.at(-1)?.([{ isIntersecting: true }]));
            }
            disconnect() {}
        }
        vi.stubGlobal('IntersectionObserver', FakeObserver);
        try {
            mockBootstrap({ documents: firstPage, hasMore: true });
            // Only rows already on screen, while still claiming more.
            fetchLibraryPage.mockResolvedValue({ documents: [firstPage[1]], hasMore: true });
            renderLibrary();
            await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
            await waitFor(() => expect(fetchLibraryPage).toHaveBeenCalledTimes(1));
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(fetchLibraryPage).toHaveBeenCalledTimes(1);
            expect(screen.getByRole('button', { name: 'Load more scores' })).toBeEnabled();
        } finally {
            vi.unstubAllGlobals();
            vi.stubGlobal('localStorage', memoryStorage());
            window.localStorage.setItem('cleffy:library-view', 'list');
        }
    });

    it('searches and sorts the loaded rows offline instead of asking the server', async () => {
        const user = userEvent.setup();
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        try {
            mockBootstrap({ documents: firstPage, hasMore: true });
            renderLibrary();
            await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
            await user.click(screen.getByRole('button', { name: 'A–Z' }));
            expect(screen.getByText('2 loaded, A–Z')).toBeInTheDocument();
            expect(
                screen.getByText(/You’re offline, so only the 2 scores loaded here are sorted A–Z/),
            ).toBeInTheDocument();
            expect(screen.queryByText(/Couldn’t/)).not.toBeInTheDocument();
            const links = screen.getAllByRole('link').map((a) => a.textContent);
            expect(links.indexOf('An Chloe (Mozart, Wolfgang Amadeus)')).toBeLessThan(
                links.indexOf('Prelude and Fugue (Bach, Johann Sebastian)'),
            );
            await user.type(screen.getByLabelText('Search scores'), 'chloe');
            await new Promise((resolve) => setTimeout(resolve, 350));
            expect(screen.getByText('1 of 2 loaded')).toBeInTheDocument();
            expect(fetchLibraryPage).not.toHaveBeenCalled();
        } finally {
            onLine.mockRestore();
        }
    });

    it('says why the A–Z list is partial when the server could not sort it', async () => {
        const user = userEvent.setup();
        mockBootstrap({ documents: firstPage, hasMore: true });
        fetchLibraryPage.mockRejectedValueOnce(new Error('Could not load scores: timeout'));
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await user.click(screen.getByRole('button', { name: 'A–Z' }));
        expect(await screen.findByText(/Couldn’t sort all of your scores A–Z/)).toBeInTheDocument();
        expect(screen.queryByText(/Couldn’t search/)).not.toBeInTheDocument();
        expect(screen.getByText('2 loaded, A–Z')).toBeInTheDocument();
    });

    it('starts the leftover-file sweep once the library is on screen', async () => {
        renderLibrary();
        await screen.findByText('Prelude and Fugue (Bach, Johann Sebastian)');
        await waitFor(() => expect(sweepPendingStorageCleanup).toHaveBeenCalledWith('teacher-1'));
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

    it('does not set a native title tooltip on the grid card', async () => {
        renderLibrary();
        const link = await screen.findByRole('link', { name: 'An Chloe (Mozart, Wolfgang Amadeus)' });
        expect(link.closest('.library-card')).not.toHaveAttribute('title');
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

describe('Home Screen banner', () => {
    it('shows on iOS Safari and opens the instruction dialog', async () => {
        const user = userEvent.setup();
        resolveInstallSurface.mockReturnValue('ios-safari');
        renderLibrary();

        expect(await screen.findByText(/Put your library on this Home Screen like an app/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Show me' }));
        expect(screen.getByRole('dialog', { name: 'Add to Home Screen' })).toBeInTheDocument();
    });

    it('hides after Not now and stays hidden', async () => {
        const user = userEvent.setup();
        resolveInstallSurface.mockReturnValue('ios-safari');
        const { unmount } = renderLibrary();

        await user.click(await screen.findByRole('button', { name: 'Not now' }));
        expect(screen.queryByText(/Put your library on this Home Screen like an app/)).not.toBeInTheDocument();
        expect(window.localStorage.getItem('cleffy:home-screen-prompt-dismissed')).toBe('1');

        unmount();
        renderLibrary();
        expect(screen.queryByText(/Put your library on this Home Screen like an app/)).not.toBeInTheDocument();
    });

    it('does not show when the session is already standalone', async () => {
        resolveInstallSurface.mockReturnValue('standalone');
        renderLibrary();
        await screen.findByRole('heading', { level: 1, name: 'Library' });
        expect(screen.queryByText(/Put your library on this Home Screen like an app/)).not.toBeInTheDocument();
    });

    it('does not show off iOS', async () => {
        resolveInstallSurface.mockReturnValue('other');
        renderLibrary();
        await screen.findByRole('heading', { level: 1, name: 'Library' });
        expect(screen.queryByText(/Put your library on this Home Screen like an app/)).not.toBeInTheDocument();
    });
});
