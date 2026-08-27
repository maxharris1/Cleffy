import { useEffect, useRef, useState } from 'react';
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
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
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
import { MoreVerticalIcon, SettingsIcon, StarIcon, TagIcon, UploadIcon } from '@/ui/icons';

/** Above this count, tag filters switch from chips to a select. */
const TAG_CHIP_LIMIT = 8;
/** Max assigned tag names shown under a score title before “+N”. */
const INLINE_TAG_LIMIT = 3;

export const LibraryPage = () => {
    const { userId, uploading, uploadPct, onUpload, uploadError, uploadLimit, clearUploadError, openPricing } =
        useOutletContext<LibraryOutletContext>();
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [favorites, setFavorites] = useState<Set<string>>(new Set());
    const [tags, setTags] = useState<LibraryTagRow[]>([]);
    const [assignments, setAssignments] = useState<Map<string, string[]>>(new Map());
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
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
        listDocuments()
            .then(({ documents: docs, hasMore: more }) => {
                if (!cancelled) {
                    setDocuments(docs);
                    setHasMore(more);
                    setError(null);
                }
            })
            .catch(async (err: unknown) => {
                const cached = await listCachedDocuments().catch(() => []);
                if (cancelled) {
                    return;
                }
                setHasMore(false);
                if (cached.length > 0) {
                    setDocuments(cached);
                    setError('Offline — showing scores cached on this device.');
                } else {
                    setDocuments([]);
                    setError(err instanceof Error ? err.message : 'Could not load your scores.');
                }
            });
        // Favorites and tags are best-effort — an offline library still renders without them.
        listFavoriteDocumentIds()
            .then((ids) => {
                if (!cancelled) {
                    setFavorites(ids);
                }
            })
            .catch(() => undefined);
        listLibraryTags()
            .then((rows) => {
                if (!cancelled) {
                    setTags(rows);
                }
            })
            .catch(() => undefined);
        listDocumentTagMap()
            .then((map) => {
                if (!cancelled) {
                    setAssignments(map);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

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
                <header>
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-800">Library</h1>
                    <p className="mt-1 text-sm text-stone-500">
                        Upload, organize, and share the scores you teach from.
                    </p>
                </header>

                {hasScores ? (
                    <>
                        <div className="mt-5 flex flex-wrap items-center gap-3">
                            <UploadButton uploading={uploading} onUpload={onUpload} />
                            <LocalOpenControl label="Open locally without uploading" subtle />
                        </div>
                        {uploading && uploadPct !== null ? (
                            <ProgressBar value={uploadPct} label="Uploading score" className="mt-4 max-w-xs" />
                        ) : null}
                    </>
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
                            <p className="text-xs text-stone-600">
                                {query.trim() || favoritesOnly || activeTagId
                                    ? `${visible?.length ?? 0} of ${documents.length}`
                                    : `${documents.length} ${documents.length === 1 ? 'score' : 'scores'}`}
                                {hasMore && !query.trim() && !favoritesOnly && !activeTagId
                                    ? ' · showing latest 100'
                                    : null}
                            </p>
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
                                                onAssign={() => setAssignTarget(doc)}
                                                onDelete={() => setDeleteTarget(doc)}
                                            />
                                        ))}
                                    </ul>
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
    onAssign: () => void;
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

const RowMenu = ({
    onRename,
    onShare,
    onAssign,
    onDelete,
}: {
    onRename: () => void;
    onShare: () => void;
    onAssign: () => void;
    onDelete: () => void;
}) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const pick = (action: () => void) => {
        setOpen(false);
        action();
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Score actions"
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg p-1.5 text-stone-400 transition hover:bg-ink/5 hover:text-stone-600"
            >
                <MoreVerticalIcon size={16} />
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    <MenuItem label="Rename" onClick={() => pick(onRename)} />
                    <MenuItem label="Share…" onClick={() => pick(onShare)} />
                    <MenuItem label="Assign to student…" onClick={() => pick(onAssign)} />
                    <MenuItem label="Delete" danger onClick={() => pick(onDelete)} />
                </div>
            ) : null}
        </div>
    );
};

const MenuItem = ({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={`w-full px-3 py-2 text-left text-sm transition hover:bg-ink/5 ${
            danger ? 'text-danger' : 'text-stone-800'
        }`}
    >
        {label}
    </button>
);

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

const formatUpdated = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    const now = Date.now();
    const diffMs = now - date.getTime();
    const dayMs = 86_400_000;
    if (diffMs < dayMs && date.toDateString() === new Date().toDateString()) {
        return 'Today';
    }
    if (diffMs < dayMs * 2) {
        const yesterday = new Date(now - dayMs);
        if (date.toDateString() === yesterday.toDateString()) {
            return 'Yesterday';
        }
    }
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' as const }),
    });
};
