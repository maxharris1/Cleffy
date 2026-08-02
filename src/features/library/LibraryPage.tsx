import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { listCachedDocuments, listDocuments } from '@/features/library/documentsService';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import type { DocumentRow } from '@/types/database';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { ProgressBar } from '@/ui/ProgressBar';
import { buttonClassName, fieldClassName } from '@/ui/classNames';

export const LibraryPage = () => {
    const { uploading, uploadPct, onUpload, uploadError } = useOutletContext<LibraryOutletContext>();
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');

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
        return () => {
            cancelled = true;
        };
    }, []);

    const q = query.trim().toLowerCase();
    const filtered =
        documents === null ? null : q ? documents.filter((doc) => doc.title.toLowerCase().includes(q)) : documents;

    const hasScores = documents !== null && documents.length > 0;
    const isOfflineNotice = error?.startsWith('Offline') ?? false;
    const statusError = uploadError ?? error;

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
                isOfflineNotice && !uploadError ? (
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
                                ? `${filtered?.length ?? 0} of ${documents.length}`
                                : `${documents.length} ${documents.length === 1 ? 'score' : 'scores'}`}
                            {hasMore && !query.trim() ? ' · showing latest 100' : null}
                        </p>
                    </div>

                    {filtered && filtered.length === 0 ? (
                        <p className="mt-8 text-sm text-stone-500">No scores match “{query.trim()}”.</p>
                    ) : (
                        <ul className="library-list mt-4">
                            {filtered?.map((doc, index) => (
                                <li
                                    key={doc.id}
                                    className="library-list-item"
                                    style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                                >
                                    <Link
                                        to={`/doc/${doc.id}`}
                                        className="group flex items-baseline justify-between gap-4 border-b border-stone-300/50 py-3.5 transition hover:border-accent/40"
                                    >
                                        <span className="min-w-0 truncate font-medium text-stone-800 transition group-hover:text-accent-hover">
                                            {doc.title}
                                        </span>
                                        <span className="shrink-0 text-xs text-stone-500">
                                            {doc.page_count ? `${doc.page_count} pages · ` : ''}
                                            {formatUpdated(doc.updated_at)}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}
        </div>
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
        className="library-empty mt-8 lg:mt-16"
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
