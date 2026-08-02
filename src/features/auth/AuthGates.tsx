import type { Session } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

import { isRegisteredSession, useSession } from '@/features/auth/session';
import { BrandLoading } from '@/ui/BrandShell';

/** True when the URL still carries tokens / PKCE that Supabase must exchange. */
export const hasPendingAuthParams = (): boolean => {
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

/** Blocks until session bootstrap finishes, then requires a registered account. */
export const RequireRegistered = ({
    children,
    fallback = '/',
}: {
    children: (session: Session) => ReactNode;
    fallback?: string;
}) => {
    const { session, loading } = useSession();
    if (loading) {
        return <BrandLoading />;
    }
    if (!isRegisteredSession(session)) {
        return <Navigate to={fallback} replace />;
    }
    return children(session);
};

/** Blocks until session bootstrap finishes; registered users go to the library. */
export const RequireGuest = ({ children }: { children: ReactNode }) => {
    const { session, loading } = useSession();
    if (loading) {
        return <BrandLoading />;
    }
    if (isRegisteredSession(session)) {
        return <Navigate to="/library" replace />;
    }
    return children;
};
