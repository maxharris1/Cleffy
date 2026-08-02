import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { isRegisteredSession, useSession } from '@/features/auth/session';
import { BrandShell } from '@/ui/BrandShell';
import { LoadingText } from '@/ui/Loading';
import { linkClassName } from '@/ui/classNames';

/** True when the URL still carries tokens / PKCE that Supabase must exchange. */
const hasPendingAuthParams = (): boolean => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    const type = hash.get('type') ?? query.get('type');
    return Boolean(
        hash.get('access_token') ||
        hash.get('refresh_token') ||
        query.get('code') ||
        type === 'signup' ||
        type === 'email' ||
        type === 'recovery',
    );
};

const readAuthErrorFromUrl = (): string | null => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const description =
        params.get('error_description') ??
        hashParams.get('error_description') ??
        params.get('error') ??
        hashParams.get('error');
    return description ? description.replace(/\+/g, ' ') : null;
};

/**
 * OAuth / email-confirm landing. Password recovery redirects to `/update-password`.
 *
 * When the URL still carries tokens/PKCE, only SIGNED_IN (token exchange) finishes —
 * never INITIAL_SESSION, which may be a stale guest session that would wipe the link.
 */
export const AuthCallbackPage = () => {
    const navigate = useNavigate();
    const urlError = readAuthErrorFromUrl();
    const [pendingAuth] = useState(hasPendingAuthParams);
    const { session, loading, lastEvent } = useSession();
    const [timedOut, setTimedOut] = useState(false);

    useEffect(() => {
        if (urlError) {
            return;
        }
        const timeout = window.setTimeout(() => setTimedOut(true), 8000);
        return () => window.clearTimeout(timeout);
    }, [urlError]);

    useEffect(() => {
        if (urlError || timedOut) {
            return;
        }
        if (pendingAuth) {
            // Token exchange only — ignore INITIAL_SESSION with a pre-existing guest.
            if (lastEvent === 'SIGNED_IN' && isRegisteredSession(session)) {
                navigate('/library', { replace: true });
            }
            return;
        }
        if (!loading && isRegisteredSession(session)) {
            navigate('/library', { replace: true });
        }
    }, [urlError, timedOut, pendingAuth, lastEvent, session, loading, navigate]);

    if (urlError) {
        return (
            <BrandShell title="Sign-in failed" subtitle={urlError}>
                <p className="text-center text-sm text-stone-600">
                    <Link to="/login" className={linkClassName}>
                        Back to log in
                    </Link>
                </p>
            </BrandShell>
        );
    }

    if (
        timedOut &&
        !(pendingAuth ? lastEvent === 'SIGNED_IN' && isRegisteredSession(session) : isRegisteredSession(session))
    ) {
        return (
            <BrandShell
                title="Sign-in didn't complete"
                subtitle="The link may have expired. Request a new one and try again."
            >
                <p className="text-center text-sm text-stone-600">
                    <Link to="/login" className={linkClassName}>
                        Back to log in
                    </Link>
                </p>
            </BrandShell>
        );
    }

    return (
        <BrandShell title="Signing you in…">
            <LoadingText className="text-center text-sm">Please wait a moment.</LoadingText>
        </BrandShell>
    );
};
