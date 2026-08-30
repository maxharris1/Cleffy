import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { getSupabase } from '@/lib/supabase';

export interface SessionState {
    session: Session | null;
    /** True until the initial getSession() resolves. */
    loading: boolean;
    /** Latest auth event from onAuthStateChange (null until the first event). */
    lastEvent: AuthChangeEvent | null;
}

const authCallbackUrl = (): string => `${window.location.origin}/auth/callback`;

/**
 * Last session observed in this tab. `undefined` means nothing has resolved yet
 * (cold start); `null` means we know the user is signed out. Remounts of
 * useSession / auth gates read this synchronously so SPA navigations do not
 * flash BrandLoading while getSession() round-trips again.
 */
let knownSession: Session | null | undefined = undefined;

const rememberSession = (session: Session | null): void => {
    knownSession = session;
};

/** Reactive Supabase session. */
export const useSession = (): SessionState => {
    const [state, setState] = useState<SessionState>(() =>
        knownSession !== undefined
            ? { session: knownSession, loading: false, lastEvent: null }
            : { session: null, loading: true, lastEvent: null },
    );

    useEffect(() => {
        const supabase = getSupabase();
        let mounted = true;

        void supabase.auth.getSession().then(({ data }) => {
            rememberSession(data.session);
            if (mounted) {
                setState((prev) => ({ ...prev, session: data.session, loading: false }));
            }
        });
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
            rememberSession(session);
            if (mounted) {
                setState({ session, loading: false, lastEvent: event });
            }
        });
        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, []);

    return state;
};

/** True when the session belongs to a registered (non-anonymous) account. */
export const isRegisteredSession = (session: Session | null): session is Session => {
    return Boolean(session && !session.user.is_anonymous);
};

/**
 * Account type for provisioned students, else null.
 *
 * `app_metadata.user_type` is admin-set by student-provision (service role) and is not
 * writable by the user, so it is trustworthy client-side — but use it for ROUTING only,
 * i.e. deciding which chrome an account belongs in. RLS on managed_students, assignments
 * and practice_notes is the actual enforcement; this is never an authorization check.
 */
export const userTypeOf = (session: Session | null): 'student' | null => {
    const meta = session?.user.app_metadata as Record<string, unknown> | undefined;
    return meta?.['user_type'] === 'student' ? 'student' : null;
};

/** Email/password registration. */
export const signUpWithPassword = async (
    email: string,
    password: string,
): Promise<{ needsEmailConfirmation: boolean }> => {
    const { data, error } = await getSupabase().auth.signUp({
        email,
        password,
        options: { emailRedirectTo: authCallbackUrl() },
    });
    if (error) {
        throw error;
    }
    // When confirmations are enabled, session is null until the user clicks the email link.
    return { needsEmailConfirmation: !data.session };
};

/** Email/password sign-in. */
export const signInWithPassword = async (email: string, password: string): Promise<void> => {
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) {
        throw error;
    }
};

/** Send password-reset email (link lands on /update-password with recovery session). */
export const requestPasswordReset = async (email: string): Promise<void> => {
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/update-password`,
    });
    if (error) {
        throw error;
    }
};

/** Set a new password after PASSWORD_RECOVERY. */
export const updatePassword = async (password: string): Promise<void> => {
    const { error } = await getSupabase().auth.updateUser({ password });
    if (error) {
        throw error;
    }
};

/** Student join flow: anonymous session carrying a display name for presence. */
export const signInAnonymouslyWithName = async (displayName: string): Promise<void> => {
    const supabase = getSupabase();
    const { error } = await supabase.auth.signInAnonymously({ options: { data: { display_name: displayName } } });
    if (error) {
        throw error;
    }
};

export const signOut = async (): Promise<void> => {
    await getSupabase().auth.signOut();
    rememberSession(null);
    // Bump the library mutation epoch BEFORE clearing: a library_bootstrap
    // response still in flight for the old account checks it and stands down
    // instead of re-populating the rows removed below.
    const { noteLibraryMutation } = await import('@/features/library/libraryCache');
    noteLibraryMutation();
    // Drop cached ScoreData so a later account on this browser can't replay it.
    const { getDb } = await import('@/sync/db');
    const db = getDb();
    await Promise.all([
        db.scoreCache.clear().catch(() => undefined),
        db.libraryList.clear().catch(() => undefined),
        db.rosterCache.clear().catch(() => undefined),
        db.assignmentsCache.clear().catch(() => undefined),
    ]);
};

/** Display name for presence/attribution: metadata name, else email, else Guest. */
export const displayNameOf = (session: Session | null): string => {
    const meta = session?.user.user_metadata as Record<string, unknown> | undefined;
    const name = typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : null;
    return name ?? session?.user.email ?? 'Guest';
};

/**
 * The stored display name with no fallback — '' when the account never set one.
 *
 * displayNameOf() substitutes the email, which is right for presence and wrong
 * for a form field: seeding the input with an address the user never typed
 * would turn "leave it blank" into "save my email as my name".
 */
export const storedDisplayNameOf = (session: Session | null): string => {
    const meta = session?.user.user_metadata as Record<string, unknown> | undefined;
    return typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : '';
};

/**
 * Set the name that appears on this account.
 *
 * Supabase notifies every onAuthStateChange subscriber with USER_UPDATED and the
 * refreshed session, so useSession — and through it the top bar's avatar and
 * label — pick this up without a reload.
 */
export const updateDisplayName = async (displayName: string): Promise<void> => {
    const { error } = await getSupabase().auth.updateUser({ data: { display_name: displayName.trim() } });
    if (error) {
        throw error;
    }
};
