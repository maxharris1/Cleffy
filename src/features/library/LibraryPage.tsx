import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

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
    groupByComposer,
    sortDocuments,
    type LibraryGroup,
    type LibrarySort,
} from '@/features/library/libraryView';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import { ShareDialog } from '@/features/share/ShareDialog';
import type { DocumentRow } from '@/types/database';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ProgressBar } from '@/ui/ProgressBar';
import { TextField } from '@/ui/TextField';
import { buttonClassName, fieldClassName } from '@/ui/classNames';
import { MoreVerticalIcon, StarIcon } from '@/ui/icons';

export const LibraryPage = () => {
    const { userId, uploading, uploadPct, onUpload, uploadError } = useOutletContext<LibraryOutletContext>();
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [favorites, setFavorites] = useState<Set<string>>(new Set());
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<LibrarySort>('recent');
    const [groupComposer, setGroupComposer] = useState(false);
    const [favoritesOnly, setFavoritesOnly] = useState(false);
    const [renameTarget, setRenameTarget] = useState<DocumentRow | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<DocumentRow | null>(null);
    const [shareTarget, setShareTarget] = useState<DocumentRow | null>(null);
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
        // Favorites are best-effort — an offline library still renders without them.
        listFavoriteDocumentIds()
            .then((ids) => {
                if (!cancelled) {
                    setFavorites(ids);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const q = query.trim().toLowerCase();
    const visible =
        documents === null
            ? null
            : documents
                  .filter((doc) => !q || doc.title.toLowerCase().includes(q))
                  .filter((doc) => !favoritesOnly || favorites.has(doc.id));
    const groups: LibraryGroup[] | null = visible
        ? groupComposer
            ? groupByComposer(sortDocuments(visible, sort))
            : [{ label: null, documents: sortDocuments(visible, sort) }]
        : null;

    const hasScores = documents !== null && documents.length > 0;
    const isOfflineNotice = error?.startsWith('Offline') ?? false;
    const statusError = uploadError ?? actionError ?? error;

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
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not delete the score.');
        } finally {
            setBusyAction(false);
            setDeleteTarget(null);
        }
    };

    let rowIndex = 0;

    return (
        <div>
            {hasScores ? (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <UploadButton uploading={uploading} onUpload={onUpload} />
                        <LocalOpenControl label="Open locally without uploading" subtle />
                    </div>
                    {uploading && uploadPct !== null ? (
                        <ProgressBar value={uploadPct} label="Uploading PDF" className="mt-4 max-w-xs" />
                    ) : null}
                </>
            ) : documents !== null ? (
                <EmptyLibrary uploading={uploading} uploadPct={uploadPct} onUpload={onUpload} />
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
                            {query.trim()
                                ? `${visible?.length ?? 0} of ${documents.length}`
                                : `${documents.length} ${documents.length === 1 ? 'score' : 'scores'}`}
                            {hasMore && !query.trim() ? ' · showing latest 100' : null}
                        </p>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs">
                        <span className="text-stone-500">Sort</span>
                        <FilterTag active={sort === 'recent'} onClick={() => setSort('recent')}>
                            Recent
                        </FilterTag>
                        <FilterTag active={sort === 'title'} onClick={() => setSort('title')}>
                            A–Z
                        </FilterTag>
                        <span aria-hidden="true" className="h-3 w-px bg-stone-300/70" />
                        <FilterTag active={groupComposer} onClick={() => setGroupComposer((v) => !v)}>
                            Group by composer
                        </FilterTag>
                        <span aria-hidden="true" className="h-3 w-px bg-stone-300/70" />
                        <FilterTag active={favoritesOnly} onClick={() => setFavoritesOnly((v) => !v)}>
                            Favorites
                        </FilterTag>
                    </div>

                    {visible && visible.length === 0 ? (
                        <p className="mt-8 text-sm text-stone-500">
                            {favoritesOnly && !query.trim()
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
                                            key={doc.id}
                                            doc={doc}
                                            index={rowIndex++}
                                            stripComposer={group.label !== null}
                                            isFavorite={favorites.has(doc.id)}
                                            isOwner={doc.owner_id === userId}
                                            onToggleFavorite={() => toggleFavorite(doc)}
                                            onRename={() => setRenameTarget(doc)}
                                            onShare={() => setShareTarget(doc)}
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
        </div>
    );
};

const FilterTag = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) => (
    <button
        type="button"
        aria-pressed={active}
        onClick={onClick}
        className={`transition ${
            active ? 'font-semibold text-ink underline underline-offset-[0.2em]' : 'text-stone-500 hover:text-stone-700'
        }`}
    >
        {children}
    </button>
);

const ScoreRow = ({
    doc,
    index,
    stripComposer,
    isFavorite,
    isOwner,
    onToggleFavorite,
    onRename,
    onShare,
    onDelete,
}: {
    doc: DocumentRow;
    index: number;
    stripComposer: boolean;
    isFavorite: boolean;
    isOwner: boolean;
    onToggleFavorite: () => void;
    onRename: () => void;
    onShare: () => void;
    onDelete: () => void;
}) => (
    <li className="library-list-item" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
        <div className="group flex items-center gap-0.5 border-b border-stone-300/50 transition hover:border-accent/40">
            <Link to={`/doc/${doc.id}`} className="flex min-w-0 flex-1 items-baseline justify-between gap-4 py-3.5">
                <span className="min-w-0 truncate font-medium text-stone-800 transition group-hover:text-accent-hover">
                    {stripComposer ? displayTitleOf(doc.title) : doc.title}
                </span>
                <span className="shrink-0 text-xs text-stone-500">
                    {doc.page_count ? `${doc.page_count} pages · ` : ''}
                    {formatUpdated(doc.updated_at)}
                </span>
            </Link>
            <button
                type="button"
                aria-pressed={isFavorite}
                aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={onToggleFavorite}
                className={`rounded-lg p-1.5 transition hover:bg-ink/5 ${
                    isFavorite ? 'text-amber-500' : 'text-stone-300 hover:text-stone-500'
                }`}
            >
                <StarIcon size={16} fill={isFavorite ? 'currentColor' : 'none'} />
            </button>
            {isOwner ? <RowMenu onRename={onRename} onShare={onShare} onDelete={onDelete} /> : null}
        </div>
    </li>
);

const RowMenu = ({
    onRename,
    onShare,
    onDelete,
}: {
    onRename: () => void;
    onShare: () => void;
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
                    className="absolute right-0 z-20 mt-1 w-36 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    <MenuItem label="Rename" onClick={() => pick(onRename)} />
                    <MenuItem label="Share…" onClick={() => pick(onShare)} />
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
        {uploading ? 'Uploading…' : 'Upload PDF'}
        <input
            type="file"
            accept="application/pdf,.pdf"
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
        body="Find a score on IMSLP or upload a PDF to start annotating."
    >
        <div className="flex flex-wrap items-center justify-center gap-3">
            <Link to="/search" className={buttonClassName('primary', 'sm')}>
                Find on IMSLP
            </Link>
            <UploadButton uploading={uploading} onUpload={onUpload} />
        </div>
        {uploading && uploadPct !== null ? (
            <ProgressBar value={uploadPct} label="Uploading PDF" className="w-full max-w-xs" />
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
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
