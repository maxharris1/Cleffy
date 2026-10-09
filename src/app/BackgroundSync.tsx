import { useEffect } from 'react';

import { useSession } from '@/features/auth/session';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

/**
 * Uploads queued annotation changes (and lesson-history snapshots) for every
 * score while someone is signed in, on whatever page they are — see
 * sync/backgroundDrain. Renders nothing.
 */
const SCORE_PAGE_START_DELAY_MS = 5000;

export const BackgroundSync = () => (isSupabaseConfigured() ? <SignedInDrain /> : null);

const SignedInDrain = () => {
    const { session } = useSession();
    const userId = session?.user.id ?? null;

    useEffect(() => {
        if (!userId) {
            return;
        }
        let cancelled = false;
        let stop: (() => void) | null = null;
        // Loaded on demand: the landing page and sign-in never need the sync stack.
        void Promise.all([
            import('@/sync/backgroundDrain'),
            import('@/sync/db'),
            import('@/sync/syncEngine'),
            import('@/features/viewer/history/snapshotService'),
        ])
            .then(([{ startBackgroundDrain }, { getDb }, { createSupabaseAnnotationsApi }, snapshots]) => {
                if (cancelled) {
                    return;
                }
                const db = getDb();
                const drain = startBackgroundDrain({
                    db,
                    api: createSupabaseAnnotationsApi(getSupabase()),
                    userId,
                    retrySnapshots: () => snapshots.retryPendingSnapshots(db),
                    countPendingSnapshots: () => snapshots.countPendingSnapshots(db),
                    // Opened straight onto a score: its viewer drains it, so
                    // give that viewer time to register before the first look.
                    startDelayMs: window.location.pathname.startsWith('/doc/') ? SCORE_PAGE_START_DELAY_MS : 0,
                });
                stop = () => drain.stop();
            })
            .catch((err: unknown) => console.warn('Background sync could not start', err));
        return () => {
            cancelled = true;
            stop?.();
        };
    }, [userId]);

    return null;
};
