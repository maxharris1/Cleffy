import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { getSupabase } from '@/lib/supabase';

export interface SessionState {
    session: Session | null;
    /** True until the initial getSession() resolves. */
    loading: boolean;
}

/** Reactive Supabase session. */
export const useSession = (): SessionState => {
    const [state, setState] = useState<SessionState>({ session: null, loading: true });

    useEffect(() => {
        const supabase = getSupabase();
        let mounted = true;

        void supabase.auth.getSession().then(({ data }) => {
            if (mounted) {
                setState({ session: data.session, loading: false });
            }
        });
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            if (mounted) {
                setState({ session, loading: false });
            }
        });
        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, []);

    return state;
};

/** Teacher sign-in: email magic link, landing on /auth/callback. */
export const signInWithMagicLink = async (email: string): Promise<void> => {
    const { error } = await getSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
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
};

/** Display name for presence/attribution: metadata name, else email, else Guest. */
export const displayNameOf = (session: Session | null): string => {
    const meta = session?.user.user_metadata as Record<string, unknown> | undefined;
    const name = typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : null;
    return name ?? session?.user.email ?? 'Guest';
};
