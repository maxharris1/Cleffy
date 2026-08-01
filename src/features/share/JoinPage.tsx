import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { signInAnonymouslyWithName, useSession } from '@/features/auth/session';
import { redeemShareLink } from '@/features/share/shareService';

/**
 * Share-link landing. If a session already exists (teacher clicking their own
 * link, returning student) we redeem with it — NEVER clobber it with a fresh
 * anonymous identity (plan §auth). Otherwise: quick name prompt → anonymous
 * sign-in → redeem → viewer.
 */
export const JoinPage = () => {
    const { token } = useParams<{ token: string }>();
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const redeemedRef = useRef(false);

    // Auto-redeem as soon as a session exists. All setState happens inside
    // promise callbacks (async), never synchronously in the effect.
    useEffect(() => {
        if (loading || !token || !session || redeemedRef.current) {
            return;
        }
        redeemedRef.current = true;
        redeemShareLink(token)
            .then(({ documentId }) => navigate(`/doc/${documentId}`, { replace: true }))
            .catch((err: unknown) => {
                redeemedRef.current = false;
                setSubmitting(false);
                setError(
                    err instanceof Error && err.message === 'invalid_link'
                        ? 'This link is invalid, expired, or was revoked. Ask for a new one.'
                        : 'Could not join this score. Check your connection and try again.',
                );
            });
    }, [loading, session, token, navigate]);

    const joinAsGuest = async () => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setError('Enter your name so collaborators know who you are.');
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            await signInAnonymouslyWithName(trimmed);
            // The session change re-runs the effect above, which redeems.
        } catch (err) {
            setSubmitting(false);
            setError(err instanceof Error ? err.message : 'Could not join.');
        }
    };

    if (!token) {
        return null;
    }

    const busy = loading || submitting || (session !== null && error === null);

    return (
        <main className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
            <h1 className="text-2xl font-bold text-indigo-700">Join a shared score</h1>

            {error ? (
                <div className="text-center">
                    <p className="text-red-600">{error}</p>
                    <Link to="/" className="mt-3 inline-block text-sm text-indigo-600 underline">
                        Go to the library
                    </Link>
                </div>
            ) : busy ? (
                <p className="animate-pulse text-stone-500">Joining…</p>
            ) : (
                <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
                    <label htmlFor="name" className="block text-sm font-medium text-stone-700">
                        Your name
                    </label>
                    <input
                        id="name"
                        value={name}
                        autoFocus
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                void joinAsGuest();
                            }
                        }}
                        placeholder="e.g. Sharon"
                        className="mt-1 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
                    />
                    <button
                        type="button"
                        onClick={() => void joinAsGuest()}
                        className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500"
                    >
                        Join
                    </button>
                    <p className="mt-2 text-xs text-stone-400">
                        No account needed — you can add an email later to keep your work across devices.
                    </p>
                </div>
            )}
        </main>
    );
};
