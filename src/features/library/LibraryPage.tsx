import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { listCachedDocuments, listDocuments } from '@/features/library/documentsService';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import type { DocumentRow } from '@/types/database';

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
        documents === null
            ? null
            : q
              ? documents.filter((doc) => doc.title.toLowerCase().includes(q))
              : documents;

    const hasScores = documents !== null && documents.length > 0;
    const isOfflineNotice = error?.startsWith('Offline') ?? false;
    const statusError = uploadError ?? error;

    return (
        <div>
            {hasScores ? (
                <div className="flex flex-wrap items-center gap-3">
                    <UploadButton uploading={uploading} uploadPct={uploadPct} onUpload={onUpload} />
                    <LocalOpenControl label="Open locally without uploading" subtle />
                </div>
            ) : documents !== null ? (
                <EmptyLibrary uploading={uploading} uploadPct={uploadPct} onUpload={onUpload} />
            ) : null}

            {statusError ? (
                <p
                    className={`mt-5 text-sm ${isOfflineNotice && !uploadError ? 'text-amber-800' : 'text-red-600'}`}
                    role="status"
                >
                    {statusError}
                </p>
            ) : null}

            {documents === null ? (
                <p className="mt-10 animate-pulse text-stone-500">Loading scores…</p>
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
                            className="landing-input w-full rounded-lg border border-stone-300/80 bg-white/70 px-3 py-2 text-sm text-stone-800 outline-none placeholder:text-stone-400 sm:max-w-xs"
                        />
                        <p className="text-xs text-stone-500">
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
                                        className="group flex items-baseline justify-between gap-4 border-b border-stone-300/50 py-3.5 transition hover:border-indigo-300/60"
                                    >
                                        <span className="min-w-0 truncate font-medium text-stone-800 transition group-hover:text-indigo-800">
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

const UploadButton = ({
    uploading,
    uploadPct,
    onUpload,
}: {
    uploading: boolean;
    uploadPct: number | null;
    onUpload: (file: File) => Promise<void>;
}) => (
    <label
        className={`landing-cta inline-flex cursor-pointer items-center rounded-lg px-4 py-2 text-sm font-medium text-white ${
            uploading ? 'pointer-events-none opacity-80' : ''
        }`}
    >
        {uploading ? `Uploading… ${uploadPct}%` : 'Upload PDF'}
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
    <div className="library-empty mt-8 text-center lg:mt-16">
        <h2 className="text-lg font-medium tracking-tight text-stone-800">No scores yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-stone-500">
            Find a score on IMSLP or upload a PDF to start annotating.
        </p>
        <div className="mt-8 flex flex-col items-center gap-4">
            <div className="flex flex-wrap items-center justify-center gap-3">
                <Link to="/search" className="landing-cta rounded-lg px-4 py-2 text-sm font-medium text-white">
                    Find on IMSLP
                </Link>
                <UploadButton uploading={uploading} uploadPct={uploadPct} onUpload={onUpload} />
            </div>
            <LocalOpenControl label="Or open a PDF locally without uploading" subtle />
        </div>
    </div>
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
