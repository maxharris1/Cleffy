import type { Session } from '@supabase/supabase-js';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

import { isRegisteredSession, userTypeOf, useSession } from '@/features/auth/session';
import { isSupabaseConfigured } from '@/lib/supabase';
import { BrandLoading } from '@/ui/BrandShell';

/** Landing route for a registered account: students have their own chrome. */
const homeFor = (session: Session): string => (userTypeOf(session) === 'student' ? '/assignments' : '/library');

/** Blocks until session bootstrap finishes, then requires a registered account. */
export const RequireRegistered = ({
    children,
    fallback = '/',
}: {
    children: (session: Session) => ReactNode;
    fallback?: string;
}) => {
    const { session, loading } = useSession();
    // Paint chrome from a known session immediately; BrandLoading only on a true
    // cold start where nothing has resolved yet.
    if (loading && !session) {
        return <BrandLoading />;
    }
    if (!isRegisteredSession(session)) {
        return <Navigate to={fallback} replace />;
    }
    // A provisioned student is registered, but teacher chrome is not theirs: send
    // them to their assignments rather than showing a library they cannot own.
    if (userTypeOf(session) === 'student') {
        return <Navigate to="/assignments" replace />;
    }
    return children(session);
};

/** Session gate — only mounted when a project exists to ask. */
const RequireGuestConfigured = ({ children }: { children: ReactNode }) => {
    const { session, loading } = useSession();
    if (loading && !session) {
        return <BrandLoading />;
    }
    if (isRegisteredSession(session)) {
        return <Navigate to={homeFor(session)} replace />;
    }
    return children;
};

/** Blocks until session bootstrap finishes; registered users go to their own home. */
export const RequireGuest = ({ children }: { children: ReactNode }) => {
    // Local-only builds have no project: do not call getSupabase(), which
    // throws, and do not block the landing page behind a session that
    // cannot exist.
    if (!isSupabaseConfigured()) {
        return children;
    }
    return <RequireGuestConfigured>{children}</RequireGuestConfigured>;
};

/**
 * Student counterpart to RequireRegistered: only a provisioned student gets through.
 * Anonymous and guest sessions go to the code-entry page; registered non-students
 * (teachers) go back to the library.
 */
export const RequireStudent = ({ children }: { children: (session: Session) => ReactNode }) => {
    const { session, loading } = useSession();
    if (loading && !session) {
        return <BrandLoading />;
    }
    if (!isRegisteredSession(session)) {
        return <Navigate to="/student" replace />;
    }
    if (userTypeOf(session) !== 'student') {
        return <Navigate to="/library" replace />;
    }
    return children(session);
};
