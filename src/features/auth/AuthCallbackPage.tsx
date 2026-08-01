import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useSession } from '@/features/auth/session';

/** Magic-link landing: supabase-js exchanges the URL token; we wait and go home. */
export const AuthCallbackPage = () => {
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        if (session) {
            navigate('/', { replace: true });
        }
    }, [session, navigate]);

    useEffect(() => {
        const timer = setTimeout(() => setTimedOut(true), 8000);
        return () => clearTimeout(timer);
    }, []);

    return (
        <main className="flex min-h-full flex-col items-center justify-center gap-3 p-8">
            {!timedOut || loading ? (
                <p className="animate-pulse text-stone-500">Signing you in…</p>
            ) : (
                <>
                    <p className="text-red-600">Sign-in didn&apos;t complete — the link may have expired.</p>
                    <Link to="/" className="text-sm text-indigo-600 underline">
                        Request a new link
                    </Link>
                </>
            )}
        </main>
    );
};
