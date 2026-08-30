import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import {
    deleteDocument,
    listCachedDocuments,
    listDocuments,
    listFavoriteDocumentIds,
    renameDocument,
    setDocumentFavorite,
} from '@/features/library/documentsService';
import { fetchLibraryBootstrap, readCachedLibraryList } from '@/features/library/libraryBootstrap';
import { libraryMutationEpoch } from '@/features/library/libraryCache';
import {
    displayTitleOf,
    filterByTag,
    groupByComposer,
    groupByTag,
    sortDocuments,
    type LibraryGroup,
    type LibrarySort,
} from '@/features/library/libraryView';
import { UPLOAD_ACCEPT } from '@/features/import/prepareUpload';
import { FileDropZone } from '@/features/library/FileDropZone';
import { formatUpdated } from '@/features/library/libraryFormat';
import { readLibraryView, writeLibraryView, type LibraryView } from '@/features/library/libraryPrefs';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { RowMenu } from '@/features/library/RowMenu';
import { ScoreCard } from '@/features/library/ScoreCard';
import { ScoreThumb } from '@/features/library/ScoreThumb';
import { TagAssignDialog } from '@/features/library/TagAssignDialog';
import { TagManageDialog } from '@/features/library/TagManageDialog';
import {
    createLibraryTag,
    deleteLibraryTag,
    listDocumentTagMap,
    listLibraryTags,
    renameLibraryTag,
    setDocumentTag,
} from '@/features/library/tagsService';
import { AssignDialog } from '@/features/roster/AssignDialog';
import { ShareDialog } from '@/features/share/ShareDialog';
import type { DocumentRow, LibraryTagRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ProgressBar } from '@/ui/ProgressBar';
import { TextField } from '@/ui/TextField';
import { buttonClassName, chipClassName, fieldClassName } from '@/ui/classNames';
import { LayoutGridIcon, ListIcon, SettingsIcon, StarIcon, TagIcon, UploadIcon } from '@/ui/icons';

/** Above this count, tag filters switch from chips to a select. */
const TAG_CHIP_LIMIT = 8;
/** Max assigned tag names shown under a score title before “+N”. */
const INLINE_TAG_LIMIT = 3;

export const LibraryPage = () => {
    const {
        userId,
        uploading,
        uploadPct,
        onUpload,
        uploadError,
        uploadLimit,
        clearUploadError,
        canManageStudents,
        openPricing,
    } = useOutletContext<LibraryOutletContext>();
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [favorites, setFavorites] = useState<Set<string>>(new Set());
    const [tags, setTags] = useState<LibraryTagRow[]>([]);
    const [assignments, setAssignments] = useState<Map<string, string[]>>(new Map());
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    // Read once on mount: a stored preference that throws (private mode) falls
    // back to the shelf rather than taking the page down with it.
    const [view, setView] = useState<LibraryView>(readLibraryView);
    const [sort, setSort] = useState<LibrarySort>('recent');
    const [groupComposer, setGroupComposer] = useState(false);
    const [groupTag, setGroupTag] = useState(false);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [activeTagId, setActiveTagId] = useState<string | null>(null);
    const [renameTarget, setRenameTarget] = useState<DocumentRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null);
    const [shareTarget, setShareTarget] = useState<DocumentRow | null>(null);
    const [assignTarget, setAssignTarget] = useState<DocumentRow | null>(null);
    const [tagTarget, setTagTarget] = useState<DocumentRow | null>(null);
    const [manageTagsOpen, setManageTagsOpen] = useState(false);
    const [busyAction, setBusyAction] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            // Instant paint from the last bootstrap before the network. Only the
            // user-scoped snapshot qualifies: pdfCache (opened PDFs) is shared by
            // every account on this browser, so it stays out of the happy path
            // and appears only under the labelled offline fallback below.
            const cachedList = await readCachedLibraryList(userId).catch(() => null);
            if (!cancelled && cachedList && cachedList.documents.length > 0) {
                setDocuments(cachedList.documents);
                setHasMore(cachedList.hasMore);
                setFavorites(cachedList.favoriteIds);
                setTags(cachedList.tags);
                setAssignments(cachedList.documentTags);
            }

            // The painted list is interactive while the network is out, so edits
            // made in that window outrank the response: every wholesale setState
            // below stands down if the epoch moved after its request left.
            const epochAtFetch = libraryMutationEpoch();
            try {
                const boot = await fetchLibraryBootstrap(userId);
                if (cancelled || libraryMutationEpoch() !== epochAtFetch) {
                    return;
                }
                setDocuments(boot.documents);
                setHasMore(boot.hasMore);
                setFavorites(boot.favoriteIds);
                setTags(boot.tags);
                setAssignments(boot.documentTags);
                setError(null);
            } catch (err: unknown) {
                // Fallback: four parallel GETs if the bootstrap RPC is unavailable.
                try {
                    const epochAtRetry = libraryMutationEpoch();
                    const [{ documents: docs, hasMore: more }, ids, tagRows, tagMap] = await Promise.all([
                        listDocuments(),
                        listFavoriteDocumentIds().catch(() => new Set<string>()),
                        listLibraryTags().catch(() => [] as LibraryTagRow[]),
                        listDocumentTagMap().catch(() => new Map<string, string[]>()),
                    ]);
                    if (cancelled || libraryMutationEpoch() !== epochAtRetry) {
                        return;
                    }
                    setDocuments(docs);
                    setHasMore(more);
                    setFavorites(ids);
                    setTags(tagRows);
                    setAssignments(tagMap);
                    setError(null);
                } catch {
                    if (cancelled) {
                        return;
                    }
                    // Prefer the bootstrap Dexie snapshot already painted above —
                    // listCachedDocuments() is only opened PDFs and would shrink the grid.
                    if (cachedList && cachedList.documents.length > 0) {
                        setError('Offline — showing scores cached on this device.');
                        return;
                    }
                    const opened = await listCachedDocuments().catch(() => []);
                    if (cancelled) {
                        return;
                    }
                    setHasMore(false);
                    if (opened.length > 0) {
                        setDocuments(opened);
                        setError('Offline — showing scores cached on this device.');
                    } else {
                        setDocuments((prev) => prev ?? []);
                        setError(err instanceof Error ? err.message : 'Could not load your scores.');
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [userId]);

    const tagsById = new Map(tags.map((t) => [t.id, t]));

    const q = query.trim().toLowerCase();
    const visible =
        documents === null
            ? null
            : (() => {
                  let list = documents
                      .filter((doc) => !q || doc.title.toLowerCase().includes(q))
                      .filter((doc) => !favoritesOnly || favorites.has(doc.id));
                  if (activeTagId) {
                      list = filterByTag(list, activeTagId, assignments);
                  }
                  return list;
              })();
    const sorted = visible ? sortDocuments(visible, sort) : null;
    const groups: LibraryGroup[] | null = sorted
        ? groupTag
            ? groupByTag(sorted, tags, assignments)
            : groupComposer
              ? groupByComposer(sorted)
              : [{ label: null, documents: sorted }]
        : null;

    const hasScores = documents !== null && documents.length > 0;
    const isOfflineNotice = error?.startsWith('Offline') ?? false;
    const statusError = uploadError ?? actionError ?? error;
    const useTagSelect = tags.length > TAG_CHIP_LIMIT;
    /**
     * The upload tile is the last cell of the shelf, so it only makes sense
     * when the shelf is the whole library: under a filter it would look like a
     * result, and under a grouping it would have to pick a group to live in.
     */
    const showAddTile = view === 'grid' && !q && !activeTagId && !favoritesOnly && !groupComposer && !groupTag;

    const changeView = (next: LibraryView) => {
        setView(next);
        writeLibraryView(next);
    };

    const toggleFavorite = (doc: DocumentRow) => {
        const next = !favorites.has(doc.id);
        setActionError(null);
        setFavorites((prev) => {
            const set = new Set(prev);
            if (next) {
                set.add(doc.id);
            } else {
                set.delete(doc.id);
            }
            return set;
        });
        setDocumentFavorite(doc.id, userId, next).catch((err: unknown) => {
            setFavorites((prev) => {
                const set = new Set(prev);
                if (next) {
                    set.delete(doc.id);
                } else {
                    set.add(doc.id);
                }
                return set;
            });
            setActionError(err instanceof Error ? err.message : 'Could not update favorites.');
        });
    };

    const patchAssignment = (documentId: string, tagId: string, assigned: boolean) => {
        setAssignments((prev) => {
            const next = new Map(prev);
            const current = next.get(documentId) ?? [];
            if (assigned) {
                if (!current.includes(tagId)) {
                    next.set(documentId, [...current, tagId]);
                }
            } else {
                const filtered = current.filter((id) => id !== tagId);
                if (filtered.length === 0) {
                    next.delete(documentId);
                } else {
                    next.set(documentId, filtered);
                }
            }
            return next;
        });
    };

    const handleToggleTag = async (tagId: string, assigned: boolean) => {
        if (!tagTarget) {
            return;
        }
        const docId = tagTarget.id;
        patchAssignment(docId, tagId, assigned);
        try {
            await setDocumentTag(docId, tagId, assigned);
        } catch (err) {
            patchAssignment(docId, tagId, !assigned);
            throw err;
        }
    };

    /** Create from assign dialog — also assigns to the open score. */
    const handleCreateAndAssignTag = async (name: string) => {
        if (!tagTarget) {
            return;
        }
        const created = await createLibraryTag(userId, name);
        setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        patchAssignment(tagTarget.id, created.id, true);
        try {
            await setDocumentTag(tagTarget.id, created.id, true);
        } catch (err) {
            patchAssignment(tagTarget.id, created.id, false);
            throw err;
        }
    };

    /** Create from manage dialog — no score context, no auto-assign. */
    const handleCreateTagOnly = async (name: string) => {
        const created = await createLibraryTag(userId, name);
        setTags((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
    };

    const handleRenameTag = async (tagId: string, name: string) => {
        await renameLibraryTag(tagId, name);
        setTags((prev) =>
            prev
                .map((t) => (t.id === tagId ? { ...t, name: name.trim().replace(/\s+/g, ' ') } : t))
                .sort((a, b) => a.name.localeCompare(b.name)),
        );
    };

    const handleDeleteTag = async (tagId: string) => {
        await deleteLibraryTag(tagId);
        setTags((prev) => prev.filter((t) => t.id !== tagId));
        setAssignments((prev) => {
            const next = new Map(prev);
            for (const [docId, tagIds] of next) {
                const filtered = tagIds.filter((id) => id !== tagId);
                if (filtered.length === 0) {
                    next.delete(docId);
                } else {
                    next.set(docId, filtered);
                }
            }
            return next;
        });
        if (activeTagId === tagId) {
            setActiveTagId(null);
        }
    };

    const saveRename = async (title: string) => {
        if (!renameTarget) {
            return;
        }
        const target = renameTarget;
        setBusyAction(true);
        try {
            await renameDocument(target.id, title);
            setDocuments((docs) => docs?.map((d) => (d.id === target.id ? { ...d, title } : d)) ?? docs);
            setRenameTarget(null);
        } finally {
            setBusyAction(false);
        }
    };

    const confirmDelete = async () => {
        if (!deleteTarget) {
            return;
        }
        const target = deleteTarget;
        setBusyAction(true);
        setActionError(null);
        try {
            await deleteDocument(target);
            setDocuments((docs) => docs?.filter((d) => d.id !== target.id) ?? docs);
            setAssignments((prev) => {
                const next = new Map(prev);
                next.delete(target.id);
                return next;
            });
            // A slot just came free, so the "you are at your score limit" notice
            // from the upload that failed a moment ago is no longer true.
            clearUploadError();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not delete the score.');
        } finally {
            setBusyAction(false);
            setDeleteTarget(null);
        }
    };

    const docTags = (docId: string): LibraryTagRow[] => {
        const ids = assignments.get(docId) ?? [];
        return ids.map((id) => tagsById.get(id)).filter((t): t is LibraryTagRow => t !== undefined);
    };

    let rowIndex = 0;

    return (
        <FileDropZone disabled={uploading} onFile={(file) => void onUpload(file).catch(() => undefined)}>
            <div>
                {/*
                  No upload button in the header: the shell's top bar carries a
                  persistent one and the shelf ends in an "Add a score" tile. The
                  local-only path has no other home, so it rides alongside the
                  subtitle rather than standing alone where the button used to be.
                */}
                <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Library</h1>
                    <p className="text-sm text-stone-500">Upload, organize, and share the scores you teach from.</p>
                    {hasScores ? <LocalOpenControl label="Open locally without uploading" subtle /> : null}
                </header>

                {hasScores ? (
                    uploading && uploadPct !== null ? (
                        <ProgressBar value={uploadPct} label="Uploading score" className="mt-4 max-w-xs" />
                    ) : null
                ) : documents !== null ? (
                    <EmptyLibrary uploading={uploading} uploadPct={uploadPct} onUpload={onUpload} />
                ) : null}

                {/*
              Both, never one instead of the other. The limit notice outlives the
              upload that raised it — nothing but the next upload clears it — so
              rendering it in place of statusError would swallow every later
              failure: a delete that errored, a listDocuments that failed, the
              offline notice. Two different things, and the teacher needs both.
            */}
                {uploadLimit ? (
                    <LimitReachedNotice limit={uploadLimit} onUpgrade={openPricing} className="mt-5" />
                ) : null}
                {statusError ? (
                    isOfflineNotice && !uploadError && !actionError ? (
                        <p className="mt-5 text-sm text-amber-800" role="status">
                            {statusError}
                        </p>
                    ) : (
                        <ErrorText className="mt-5">{statusError}</ErrorText>
                    )
                ) : null}

                {documents === null ? (
                    <LoadingText className="mt-10">Loading scores…</LoadingText>
                ) : hasScores ? (
                    <section className="mt-8">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <label className="sr-only" htmlFor="library-search">
                                Search scores
                            </label>
                            <input
                                id="library-search"
                                type="search"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search by title…"
                                className={fieldClassName('sm', 'sm:max-w-xs')}
                            />
                            <div className="flex items-center gap-3">
                                <p className="text-xs text-stone-600">
                                    {query.trim() || favoritesOnly || activeTagId
                                        ? `${visible?.length ?? 0} of ${documents.length}`
                                        : `${documents.length} ${documents.length === 1 ? 'score' : 'scores'}`}
                                    {hasMore && !query.trim() && !favoritesOnly && !activeTagId
                                        ? ' · showing latest 100'
                                        : null}
                                </p>
                                <ViewToggle view={view} onChange={changeView} />
                            </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                            <SortToggle sort={sort} onChange={setSort} />
                            <FilterChip
                                active={groupComposer}
                                onClick={() => {
                                    setGroupComposer((v) => !v);
                                    setGroupTag(false);
                                }}
                            >
                                Group by composer
                            </FilterChip>
                            {tags.length > 0 ? (
                                <FilterChip
                                    active={groupTag}
                                    onClick={() => {
                                        setGroupTag((v) => !v);
                                        setGroupComposer(false);
                                    }}
                                >
                                    Group by tag
                                </FilterChip>
                            ) : null}
                        </div>

                        <div className="no-scrollbar -mx-4 mt-2 flex items-center gap-2 overflow-x-auto px-4 py-0.5 sm:mx-0 sm:flex-wrap sm:overflow-x-visible sm:px-0">
                            <FilterChip active={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
                                Favorites
                            </FilterChip>
                            <span className="shrink-0 text-xs text-stone-500">Tags</span>
                            {tags.length === 0 ? (
                                <button
                                    type="button"
                                    onClick={() => setManageTagsOpen(true)}
                                    className={chipClassName(false)}
                                >
                                    Add a tag…
                                </button>
                            ) : (
                                <>
                                    {useTagSelect ? (
                                        <select
                                            aria-label="Filter by tag"
                                            value={activeTagId ?? ''}
                                            onChange={(e) => setActiveTagId(e.target.value || null)}
                                            className={fieldClassName('sm', 'h-8 w-auto max-w-[10rem] py-0 text-xs')}
                                        >
                                            <option value="">All tags</option>
                                            {tags.map((tag) => (
                                                <option key={tag.id} value={tag.id}>
                                                    {tag.name}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        tags.map((tag) => (
                                            <FilterChip
                                                key={tag.id}
                                                active={activeTagId === tag.id}
                                                onClick={() => setActiveTagId((id) => (id === tag.id ? null : tag.id))}
                                            >
                                                {tag.name}
                                            </FilterChip>
                                        ))
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setManageTagsOpen(true)}
                                        className={chipClassName(false)}
                                    >
                                        <SettingsIcon size={14} />
                                        Manage
                                    </button>
                                </>
                            )}
                        </div>

                        {visible && visible.length === 0 ? (
                            <p className="mt-8 text-sm text-stone-500">
                                {activeTagId && !query.trim() && !favoritesOnly
                                    ? 'No scores with this tag yet.'
                                    : favoritesOnly && !query.trim()
                                      ? 'No favorites yet — tap the star on a score to keep it handy.'
                                      : `No scores match “${query.trim()}”.`}
                            </p>
                        ) : (
                            groups?.map((group) => (
                                <section key={group.label ?? 'all'}>
                                    {group.label ? (
                                        <h3 className="mt-7 border-b border-stone-300/50 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-stone-500">
                                            {group.label}
                                        </h3>
                                    ) : null}
                                    {view === 'grid' ? (
                                        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                                            {group.documents.map((doc) => (
                                                <ScoreCard
                                                    key={`${group.label ?? 'all'}-${doc.id}`}
                                                    doc={doc}
                                                    index={rowIndex++}
                                                    stripComposer={groupComposer && group.label !== null}
                                                    assignedTags={docTags(doc.id)}
                                                    isFavorite={favorites.has(doc.id)}
                                                    isOwner={doc.owner_id === userId}
                                                    onToggleFavorite={() => toggleFavorite(doc)}
                                                    onRename={() => setRenameTarget(doc)}
                                                    onShare={() => setShareTarget(doc)}
                                                    onAssign={
                                                        canManageStudents ? () => setAssignTarget(doc) : undefined
                                                    }
                                                    onDelete={() => setDeleteTarget(doc)}
                                                />
                                            ))}
                                            {showAddTile ? (
                                                <AddScoreTile uploading={uploading} onUpload={onUpload} />
                                            ) : null}
                                        </div>
                                    ) : (
                                        <ul className={group.label ? '' : 'mt-4'}>
                                            {group.documents.map((doc) => (
                                                <ScoreRow
                                                    key={`${group.label ?? 'all'}-${doc.id}`}
                                                    doc={doc}
                                                    index={rowIndex++}
                                                    stripComposer={groupComposer && group.label !== null}
                                                    assignedTags={docTags(doc.id)}
                                                    isFavorite={favorites.has(doc.id)}
                                                    isOwner={doc.owner_id === userId}
                                                    onToggleFavorite={() => toggleFavorite(doc)}
                                                    onTags={() => setTagTarget(doc)}
                                                    onFilterTag={(tagId) =>
                                                        setActiveTagId((id) => (id === tagId ? null : tagId))
                                                    }
                                                    onRename={() => setRenameTarget(doc)}
                                                    onShare={() => setShareTarget(doc)}
                                                    onAssign={
                                                        canManageStudents ? () => setAssignTarget(doc) : undefined
                                                    }
                                                    onDelete={() => setDeleteTarget(doc)}
                                                />
                                            ))}
                                        </ul>
                                    )}
                                </section>
                            ))
                        )}
                    </section>
                ) : null}

                {renameTarget ? (
                    <RenameDialog
                        doc={renameTarget}
                        busy={busyAction}
                        onClose={() => setRenameTarget(null)}
                        onSave={saveRename}
                    />
                ) : null}
                {deleteTarget ? (
                    <ConfirmDialog
                        title="Delete this score?"
                        body={`“${deleteTarget.title}” and all of its annotations will be removed for everyone it's shared with. This can't be undone.`}
                        confirmLabel="Delete"
                        danger
                        busy={busyAction}
                        onConfirm={() => void confirmDelete()}
                        onCancel={() => setDeleteTarget(null)}
                    />
                ) : null}
                {shareTarget ? (
                    <ShareDialog docId={shareTarget.id} userId={userId} onClose={() => setShareTarget(null)} />
                ) : null}
                {assignTarget ? (
                    <AssignDialog
                        documentId={assignTarget.id}
                        documentTitle={assignTarget.title}
                        onClose={() => setAssignTarget(null)}
                    />
                ) : null}
                {tagTarget ? (
                    <TagAssignDialog
                        scoreTitle={tagTarget.title}
                        tags={tags}
                        assignedTagIds={new Set(assignments.get(tagTarget.id) ?? [])}
                        busy={busyAction}
                        onClose={() => setTagTarget(null)}
                        onToggleTag={handleToggleTag}
                        onCreateTag={handleCreateAndAssignTag}
                    />
                ) : null}
                {manageTagsOpen ? (
                    <TagManageDialog
                        tags={tags}
                        busy={busyAction}
                        onClose={() => setManageTagsOpen(false)}
                        onCreateTag={handleCreateTagOnly}
                        onRenameTag={handleRenameTag}
                        onDeleteTag={handleDeleteTag}
                    />
                ) : null}
            </div>
        </FileDropZone>
    );
};

const FilterChip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) => (
    <button type="button" aria-pressed={active} onClick={onClick} className={chipClassName(active)}>
        {children}
    </button>
);

const SortToggle = ({ sort, onChange }: { sort: LibrarySort; onChange: (s: LibrarySort) => void }) => (
    <div
        role="group"
        aria-label="Sort"
        className="flex h-8 shrink-0 items-center rounded-lg border border-stone-200 p-0.5 text-xs"
    >
        {(
            [
                ['recent', 'Recent'],
                ['title', 'A–Z'],
            ] as const
        ).map(([value, label]) => (
            <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => onChange(value)}
                className={`h-full rounded-md px-2.5 font-medium transition ${
                    sort === value ? 'bg-accent-soft text-accent' : 'text-stone-600 hover:text-stone-800'
                }`}
            >
                {label}
            </button>
        ))}
    </div>
);

/**
 * Shelf or list. Two icon buttons rather than a select: it is a two-state
 * choice made rarely, and the icons say what the words would.
 */
const ViewToggle = ({ view, onChange }: { view: LibraryView; onChange: (v: LibraryView) => void }) => (
    <div
        role="group"
        aria-label="View"
        className="flex h-8 shrink-0 items-center rounded-lg border border-stone-200 p-0.5"
    >
        {(
            [
                ['grid', 'Grid view', LayoutGridIcon],
                ['list', 'List view', ListIcon],
            ] as const
        ).map(([value, label, Icon]) => (
            <button
                key={value}
                type="button"
                aria-pressed={view === value}
                aria-label={label}
                title={label}
                onClick={() => onChange(value)}
                className={`flex h-full items-center rounded-md px-2 transition ${
                    view === value ? 'bg-accent-soft text-accent' : 'text-stone-500 hover:text-stone-800'
                }`}
            >
                <Icon size={15} />
            </button>
        ))}
    </div>
);

/**
 * Last cell of the shelf. A <label> around a file input rather than a button,
 * for the same reason UploadButton is one — a file picker cannot be opened
 * programmatically without a user gesture on the input itself.
 *
 * The input is `sr-only` rather than `hidden` so it stays focusable: a tile
 * only reachable with a mouse would be the one upload path a keyboard user
 * cannot take.
 */
const AddScoreTile = ({ uploading, onUpload }: { uploading: boolean; onUpload: (file: File) => Promise<void> }) => (
    <label
        className={`flex aspect-[1/1.414] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-stone-300 text-stone-500 transition hover:border-accent hover:text-accent focus-within:border-accent focus-within:text-accent ${
            uploading ? 'pointer-events-none opacity-60' : ''
        }`}
    >
        <span aria-hidden="true" className="text-3xl font-light leading-none">
            +
        </span>
        <span className="px-2 text-center text-xs font-medium">Add a score</span>
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    void onUpload(file).catch(() => undefined);
                }
                e.target.value = '';
            }}
        />
    </label>
);

const ScoreRow = ({
    doc,
    index,
    stripComposer,
    assignedTags,
    isFavorite,
    isOwner,
    onToggleFavorite,
    onTags,
    onFilterTag,
    onRename,
    onShare,
    onAssign,
    onDelete,
}: {
    doc: DocumentRow;
    index: number;
    stripComposer: boolean;
    assignedTags: LibraryTagRow[];
    isFavorite: boolean;
    isOwner: boolean;
    onToggleFavorite: () => void;
    onTags: () => void;
    onFilterTag: (tagId: string) => void;
    onRename: () => void;
    onShare: () => void;
    onAssign?: () => void;
    onDelete: () => void;
}) => {
    const hasTags = assignedTags.length > 0;
    const visibleTags = assignedTags.slice(0, INLINE_TAG_LIMIT);
    const overflow = assignedTags.length - visibleTags.length;

    return (
        <li className="library-list-item" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
            <div className="group relative flex items-center gap-0.5 border-b border-stone-300/50 transition hover:border-accent/40 hover:bg-ink/[0.03]">
                {/*
                  Sibling of the text block, not a child of it: that block turns
                  into a column on phones, which would stack the thumbnail above
                  the title instead of beside it.
                */}
                <ScoreThumb docId={doc.id} contentRev={doc.content_rev ?? 0} />
                <div className="ml-3 flex min-w-0 flex-1 flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:py-3">
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <Link
                                to={`/doc/${doc.id}`}
                                className="min-w-0 font-medium text-stone-800 transition line-clamp-2 group-hover:text-accent-hover sm:line-clamp-none sm:block sm:truncate after:absolute after:inset-0 after:content-['']"
                            >
                                {stripComposer ? displayTitleOf(doc.title) : doc.title}
                            </Link>
                            {/* Past the free cap: still readable and exportable, just not writable. */}
                            {doc.archived_at ? (
                                <span className="relative shrink-0" title="Read-only — over your plan’s score limit">
                                    <Badge tone="warn">Archived</Badge>
                                </span>
                            ) : null}
                        </div>
                        {hasTags ? (
                            <div className="relative mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                {visibleTags.map((tag, i) => (
                                    <span key={tag.id} className="inline-flex items-center gap-1.5">
                                        {i > 0 ? (
                                            <span className="text-stone-300" aria-hidden="true">
                                                ·
                                            </span>
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={() => onFilterTag(tag.id)}
                                            className="max-w-[8rem] truncate text-xs text-stone-500 transition hover:text-stone-700 hover:underline"
                                            title={`Filter by ${tag.name}`}
                                        >
                                            {tag.name}
                                        </button>
                                    </span>
                                ))}
                                {overflow > 0 ? (
                                    <button
                                        type="button"
                                        onClick={onTags}
                                        className="text-xs text-stone-400 transition hover:text-stone-600"
                                        aria-label={`Edit tags, ${overflow} more`}
                                    >
                                        +{overflow}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                    <span className="text-xs text-stone-500 sm:shrink-0">
                        {doc.page_count ? `${doc.page_count} ${doc.page_count === 1 ? 'page' : 'pages'} · ` : ''}
                        {formatUpdated(doc.updated_at)}
                    </span>
                </div>
                <button
                    type="button"
                    aria-pressed={isFavorite}
                    aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    onClick={onToggleFavorite}
                    className={`relative rounded-lg p-2 transition hover:bg-ink/5 sm:p-1.5 ${
                        isFavorite ? 'text-amber-500' : 'text-stone-300 hover:text-stone-500'
                    }`}
                >
                    <StarIcon size={16} fill={isFavorite ? 'currentColor' : 'none'} />
                </button>
                <button
                    type="button"
                    aria-label={hasTags ? 'Edit tags' : 'Add tags'}
                    title={hasTags ? 'Edit tags' : 'Add tags'}
                    onClick={onTags}
                    className={`relative rounded-lg p-2 transition hover:bg-ink/5 sm:p-1.5 ${
                        hasTags ? 'text-accent' : 'text-stone-300 hover:text-stone-500'
                    }`}
                >
                    <TagIcon size={16} />
                </button>
                {isOwner ? (
                    <RowMenu onRename={onRename} onShare={onShare} onAssign={onAssign} onDelete={onDelete} />
                ) : null}
            </div>
        </li>
    );
};

const RenameDialog = ({
    doc,
    busy,
    onClose,
    onSave,
}: {
    doc: DocumentRow;
    busy: boolean;
    onClose: () => void;
    onSave: (title: string) => Promise<void>;
}) => {
    const [title, setTitle] = useState(doc.title);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        const trimmed = title.trim();
        if (!trimmed) {
            setError('Enter a title.');
            return;
        }
        try {
            await onSave(trimmed);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not rename the score.');
        }
    };

    return (
        <Dialog label="Rename score" onClose={onClose}>
            <TextField
                id="rename-title"
                label="Title"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        void submit();
                    }
                }}
            />
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
            <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                    Cancel
                </Button>
                <Button size="sm" onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Saving…' : 'Save changes'}
                </Button>
            </div>
        </Dialog>
    );
};

const UploadButton = ({ uploading, onUpload }: { uploading: boolean; onUpload: (file: File) => Promise<void> }) => (
    <label className={buttonClassName('primary', 'sm', uploading ? 'pointer-events-none opacity-80' : '')}>
        <UploadIcon size={16} />
        {uploading ? 'Uploading…' : 'Upload score'}
        <input
            type="file"
            accept={UPLOAD_ACCEPT}
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                    void onUpload(file).catch(() => undefined);
                }
                e.target.value = '';
            }}
        />
    </label>
);

const EmptyLibrary = ({
    uploading,
    uploadPct,
    onUpload,
}: {
    uploading: boolean;
    uploadPct: number | null;
    onUpload: (file: File) => Promise<void>;
}) => (
    <EmptyState
        className="library-empty mt-8 md:mt-16"
        title="No scores yet"
        body="Find a score on IMSLP or upload a PDF or photo to start annotating."
    >
        <div className="flex flex-wrap items-center justify-center gap-3">
            <Link to="/search" className={buttonClassName('primary', 'sm')}>
                Find on IMSLP
            </Link>
            <UploadButton uploading={uploading} onUpload={onUpload} />
        </div>
        {uploading && uploadPct !== null ? (
            <ProgressBar value={uploadPct} label="Uploading score" className="w-full max-w-xs" />
        ) : null}
        <LocalOpenControl label="Or open a PDF locally without uploading" subtle />
    </EmptyState>
);
