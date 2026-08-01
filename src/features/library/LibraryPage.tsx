import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { displayNameOf, signInWithMagicLink, signOut, useSession } from '@/features/auth/session';
import { listCachedDocuments, listDocuments, uploadDocument } from '@/features/library/documentsService';
import { localDocId, putLocalDoc } from '@/lib/localDocs';
import { isSupabaseConfigured } from '@/lib/supabase';
import type { DocumentRow } from '@/types/database';

export const LibraryPage = () => {
    if (!isSupabaseConfigured()) {
        return <LocalOnlyLibrary />;
    }
    return <CloudLibrary />;
};

const CloudLibrary = () => {
    const { session, loading } = useSession();

    if (loading) {
        return (
            <main className="flex min-h-full items-center justify-center">
                <p className="animate-pulse text-stone-500">Loading…</p>
            </main>
        );
    }
    if (!session) {
        return <SignInScreen />;
    }
    return <DocumentGrid userId={session.user.id} userLabel={displayNameOf(session)} />;
};

const SignInScreen = () => {
    const [email, setEmail] = useState('');
    const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [error, setError] = useState<string | null>(null);

    const sendLink = async () => {
        if (!email.includes('@')) {
            setError('Enter a valid email address.');
            return;
        }
        setError(null);
        setState('sending');
        try {
            await signInWithMagicLink(email.trim());
            setState('sent');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send the sign-in link.');
            setState('idle');
        }
    };

    return (
        <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
            <h1 className="text-3xl font-bold text-indigo-700">Sheet Music Scribbler</h1>
            <p className="max-w-md text-center text-stone-600">
                Annotate scores together, in real time. Sign in to upload and share; students join through a link — no
                account needed.
            </p>

            <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
                {state === 'sent' ? (
                    <div className="text-center">
                        <p className="font-medium text-stone-800">Check your email ✉️</p>
                        <p className="mt-1 text-sm text-stone-500">
                            We sent a sign-in link to <span className="font-medium">{email}</span>.
                        </p>
                        <button
                            type="button"
                            className="mt-3 text-sm text-indigo-600 underline"
                            onClick={() => setState('idle')}
                        >
                            Use a different email
                        </button>
                    </div>
                ) : (
                    <>
                        <label htmlFor="email" className="block text-sm font-medium text-stone-700">
                            Email
                        </label>
                        <input
                            id="email"
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    void sendLink();
                                }
                            }}
                            placeholder="you@example.com"
                            className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                        />
                        <button
                            type="button"
                            disabled={state === 'sending'}
                            onClick={() => void sendLink()}
                            className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500 disabled:opacity-50"
                        >
                            {state === 'sending' ? 'Sending…' : 'Send sign-in link'}
                        </button>
                        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
                    </>
                )}
            </div>

            <LocalOpenControl label="…or just open a PDF locally (no account)" />
        </main>
    );
};

const DocumentGrid = ({ userId, userLabel }: { userId: string; userLabel: string }) => {
    const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [uploadPct, setUploadPct] = useState<number | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        let cancelled = false;
        listDocuments()
            .then((docs) => {
                if (!cancelled) {
                    setDocuments(docs);
                    setError(null);
                }
            })
            .catch(async (err: unknown) => {
                // Offline: fall back to the cached copies on this device.
                const cached = await listCachedDocuments().catch(() => []);
                if (cancelled) {
                    return;
                }
                if (cached.length > 0) {
                    setDocuments(
                        cached.map((c) => ({
                            id: c.id,
                            owner_id: '',
                            title: c.title,
                            storage_path: `${c.id}/original.pdf`,
                            page_count: null,
                            created_at: c.cachedAt,
                            updated_at: c.cachedAt,
                        })),
                    );
                    setError('Offline — showing scores cached on this device.');
                } else {
                    setError(err instanceof Error ? err.message : 'Could not load your scores.');
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const onUpload = async (file: File) => {
        setError(null);
        setUploadPct(0);
        try {
            const { document } = await uploadDocument(file, userId, ({ loaded, total }) =>
                setUploadPct(total > 0 ? Math.round((loaded / total) * 100) : 0),
            );
            navigate(`/doc/${document.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed.');
        } finally {
            setUploadPct(null);
        }
    };

    return (
        <main className="mx-auto min-h-full w-full max-w-4xl p-4 sm:p-8">
            <header className="mb-6 flex items-center justify-between gap-3">
                <h1 className="text-2xl font-bold text-indigo-700">Your scores</h1>
                <div className="flex items-center gap-3">
                    <span className="hidden text-sm text-stone-500 sm:block">{userLabel}</span>
                    <button
                        type="button"
                        onClick={() => void signOut()}
                        className="rounded-lg px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100"
                    >
                        Sign out
                    </button>
                </div>
            </header>

            <div className="mb-6 flex flex-wrap items-center gap-3">
                <label className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500">
                    {uploadPct !== null ? `Uploading… ${uploadPct}%` : 'Upload a score (PDF)'}
                    <input
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        disabled={uploadPct !== null}
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                                void onUpload(file);
                            }
                            e.target.value = '';
                        }}
                    />
                </label>
                <LocalOpenControl label="Open locally without uploading" subtle />
            </div>

            {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

            {documents === null ? (
                <p className="animate-pulse text-stone-500">Loading scores…</p>
            ) : documents.length === 0 ? (
                <p className="text-stone-500">No scores yet — upload a PDF from IMSLP to get started.</p>
            ) : (
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                    {documents.map((doc) => (
                        <li key={doc.id}>
                            <Link
                                to={`/doc/${doc.id}`}
                                className="block rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow"
                            >
                                <p className="truncate font-medium text-stone-800">{doc.title}</p>
                                <p className="mt-1 text-xs text-stone-500">
                                    {doc.page_count ? `${doc.page_count} pages · ` : ''}
                                    {new Date(doc.updated_at).toLocaleDateString()}
                                </p>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
};

const LocalOnlyLibrary = () => {
    return (
        <main className="flex min-h-full flex-col items-center justify-center gap-6 p-8">
            <h1 className="text-3xl font-bold text-indigo-700">Sheet Music Scribbler</h1>
            <p className="max-w-md text-center text-stone-600">
                Cloud sync is not configured. You can still open and annotate PDFs locally on this device.
            </p>
            <LocalOpenControl label="Open a PDF" />
        </main>
    );
};

const LocalOpenControl = ({ label, subtle = false }: { label: string; subtle?: boolean }) => {
    const navigate = useNavigate();
    const [openError, setOpenError] = useState<string | null>(null);

    const openFile = useCallback(
        async (file: File) => {
            setOpenError(null);
            if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
                setOpenError('Please choose a PDF file.');
                return;
            }
            const buffer = await file.arrayBuffer();
            const id = await localDocId(buffer);
            putLocalDoc(id, buffer);
            navigate(`/doc/${id}`);
        },
        [navigate],
    );

    return (
        <div className="flex flex-col items-center gap-1">
            <label
                className={
                    subtle
                        ? 'cursor-pointer text-sm text-indigo-600 underline'
                        : 'cursor-pointer rounded-lg bg-stone-700 px-4 py-2 font-medium text-white shadow hover:bg-stone-600'
                }
            >
                {label}
                <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                            void openFile(file);
                        }
                        e.target.value = '';
                    }}
                />
            </label>
            {openError ? <p className="text-sm text-red-600">{openError}</p> : null}
        </div>
    );
};
