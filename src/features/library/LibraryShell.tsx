import { useState } from 'react';
import { NavLink, Navigate, Outlet, useNavigate } from 'react-router';

import { RequireRegistered } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { uploadDocument } from '@/features/library/documentsService';
import { isSupabaseConfigured } from '@/lib/supabase';

export type LibraryOutletContext = {
    userId: string;
    uploadPct: number | null;
    uploading: boolean;
    onUpload: (file: File) => Promise<void>;
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
    const navigate = useNavigate();

    const onUpload = async (file: File) => {
        setUploadError(null);
        setUploadPct(0);
        try {
            const { document } = await uploadDocument(file, userId, ({ loaded, total }) => {
                const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
                setUploadPct(pct);
            });
            navigate(`/doc/${document.id}`);
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : 'Upload failed.');
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
        uploadError,
        clearUploadError: () => setUploadError(null),
    };

    return (
        <main className="landing-page min-h-full">
            <div className="library-layout mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10 lg:flex-row lg:gap-10 lg:py-12">
                <aside className="library-aside shrink-0 lg:sticky lg:top-8 lg:w-48 lg:self-start">
                    <div className="flex items-start justify-between gap-4 lg:block">
                        <div>
                            <p className="landing-brand font-display text-2xl font-semibold sm:text-3xl">Cleffy</p>
                            <p className="mt-1 text-sm text-stone-500 lg:mt-1.5">Your scores</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-1 lg:hidden">
                            <span className="hidden max-w-[8rem] truncate text-sm text-stone-500 sm:inline">
                                {userLabel}
                            </span>
                            <button
                                type="button"
                                onClick={() => void signOut()}
                                className="rounded-lg px-3 py-1.5 text-sm text-stone-600 transition hover:bg-black/5"
                            >
                                Sign out
                            </button>
                        </div>
                    </div>

                    <nav className="library-nav mt-5 flex gap-1 lg:mt-8 lg:flex-col lg:gap-0.5" aria-label="Library">
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
                                            : 'text-stone-600 hover:bg-black/5 hover:text-stone-900',
                                    ].join(' ')
                                }
                            >
                                {item.label}
                            </NavLink>
                        ))}
                    </nav>

                    <div className="mt-8 hidden border-t border-stone-300/50 pt-5 lg:block">
                        <p className="truncate text-sm text-stone-500">{userLabel}</p>
                        <button
                            type="button"
                            onClick={() => void signOut()}
                            className="mt-2 rounded-lg px-2 py-1.5 text-sm text-stone-600 transition hover:bg-black/5"
                        >
                            Sign out
                        </button>
                    </div>
                </aside>

                <div className="library-shell min-w-0 flex-1">
                    <Outlet context={outlet} />
                </div>
            </div>
        </main>
    );
};
