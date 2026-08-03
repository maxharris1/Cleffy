import { useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router';

import { RequireRegistered } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { recordImportStatus, shouldOfferImport } from '@/features/import/importPromptService';
import { prescanDocument } from '@/features/import/prescan';
import { importDocumentFromImslp, loadDocumentBytes, uploadDocument } from '@/features/library/documentsService';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DocumentRow } from '@/types/database';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { buttonClassName } from '@/ui/classNames';

export type LibraryOutletContext = {
    userId: string;
    uploadPct: number | null;
    uploading: boolean;
    onUpload: (file: File) => Promise<void>;
    onImportImslp: (
        filename: string,
        workTitle: string,
    ) => Promise<{ ok: true } | { ok: false; openUrl: string; message: string }>;
    uploadError: string | null;
    clearUploadError: () => void;
};

const NAV_ITEMS = [
    { to: '/library', label: 'Library', end: true },
    { to: '/search', label: 'Find on IMSLP', end: true },
] as const;

/** Authenticated app chrome: side nav + shared upload for library/search. */
export const LibraryShell = () => {
    if (!isSupabaseConfigured()) {
        return <Navigate to="/" replace />;
    }
    return (
        <RequireRegistered>
            {(session) => <LibraryFrame userId={session.user.id} userLabel={displayNameOf(session)} />}
        </RequireRegistered>
    );
};

const LibraryFrame = ({ userId, userLabel }: { userId: string; userLabel: string }) => {
    const [uploadPct, setUploadPct] = useState<number | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [importOffer, setImportOffer] = useState<DocumentRow | null>(null);
    const navigate = useNavigate();

    const onUpload = async (file: File) => {
        setUploadError(null);
        setUploadPct(0);
        try {
            const { document } = await uploadDocument(file, userId, ({ loaded, total }) => {
                const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                setUploadPct(pct);
            });
            // Free, local prescan: does this score already carry colored-ink
            // markings? If so (and the user never declined), offer the import.
            try {
                const bytes = await loadDocumentBytes(document);
                if ((await prescanDocument(bytes)) && (await shouldOfferImport(document.id))) {
                    setImportOffer(document);
                    return; // the dialog decides where to navigate
                }
            } catch {
                // Best-effort — never block the upload flow.
            }
            navigate(`/doc/${document.id}`);
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed.');
            throw err;
        } finally {
            setUploadPct(null);
        }
    };

    const resolveImportOffer = (accepted: boolean) => {
        const doc = importOffer;
        if (!doc) {
            return;
        }
        setImportOffer(null);
        void recordImportStatus(doc.id, accepted ? 'prompted' : 'declined');
        navigate(accepted ? `/doc/${doc.id}?import=1` : `/doc/${doc.id}`);
    };

    const onImportImslp = async (filename: string, workTitle: string) => {
        setUploadError(null);
        setUploadPct(0);
        try {
            const result = await importDocumentFromImslp(filename, workTitle, userId);
            if (!result.ok) {
                return {
                    ok: false as const,
                    openUrl: result.fallback.openUrl,
                    message: result.fallback.message,
                };
            }
            navigate(`/doc/${result.document.id}`);
            return { ok: true as const };
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Import failed.');
            throw err;
        } finally {
            setUploadPct(null);
        }
    };

    const outlet: LibraryOutletContext = {
        userId,
        uploadPct,
        uploading: uploadPct !== null,
        onUpload,
        onImportImslp,
        uploadError,
        clearUploadError: () => setUploadError(null),
    };

    return (
        <main className="paper-page min-h-full">
            <div className="library-layout mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 md:flex-row md:gap-8 lg:gap-10 lg:py-12">
                <aside className="shrink-0 md:sticky md:top-8 md:w-44 md:self-start lg:w-48">
                    <div className="flex items-start justify-between gap-4 md:block">
                        <div>
                            <p className="landing-brand font-display text-2xl font-semibold sm:text-3xl">Cleffy</p>
                            <p className="mt-1 text-sm text-stone-500 md:mt-1.5">Your scores</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-1 md:hidden">
                            <span className="hidden max-w-[8rem] truncate text-sm text-stone-500 sm:inline">
                                {userLabel}
                            </span>
                            <button
                                type="button"
                                onClick={() => void signOut()}
                                className={buttonClassName('ghost', 'sm')}
                            >
                                Sign out
                            </button>
                        </div>
                    </div>

                    <nav className="mt-5 flex gap-1 md:mt-8 md:flex-col md:gap-0.5" aria-label="Library">
                        {NAV_ITEMS.map((item) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.end}
                                className={({ isActive }) =>
                                    [
                                        'rounded-lg px-3 py-2 text-sm transition',
                                        isActive
                                            ? 'bg-white/70 font-medium text-stone-900 shadow-sm ring-1 ring-stone-300/50'
                                            : 'text-stone-600 hover:bg-ink/5 hover:text-stone-900',
                                    ].join(' ')
                                }
                            >
                                {item.label}
                            </NavLink>
                        ))}
                    </nav>

                    <div className="mt-8 hidden border-t border-stone-300/50 pt-5 md:block">
                        <p className="truncate text-sm text-stone-500">{userLabel}</p>
                        <button
                            type="button"
                            onClick={() => void signOut()}
                            className={buttonClassName('ghost', 'sm', 'mt-2')}
                        >
                            Sign out
                        </button>
                    </div>
                </aside>

                <div className="library-shell min-w-0 flex-1">
                    <Outlet context={outlet} />
                </div>
            </div>
            {importOffer ? (
                <ConfirmDialog
                    title="Existing marks found"
                    body="This score already carries handwritten marks (colored ink). Cleffy can lift them off the page and turn them into marks you can edit and erase — you review everything before anything changes."
                    confirmLabel="Review marks"
                    cancelLabel="Not now"
                    onConfirm={() => resolveImportOffer(true)}
                    onCancel={() => resolveImportOffer(false)}
                />
            ) : null}
        </main>
    );
};
