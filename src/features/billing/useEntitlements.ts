import { useCallback, useEffect, useState } from 'react';

import { loadEntitlements, readCachedEntitlements } from '@/features/billing/entitlementsService';
import type { Entitlements } from '@/types/database';

export interface EntitlementsState {
    entitlements: Entitlements | null;
    loading: boolean;
    refresh: () => Promise<void>;
}

/**
 * Loads entitlements alongside the session.
 *
 * Deliberately a plain hook with no context, matching useSession — this app has
 * no auth provider, and a second one just for billing would be a new pattern
 * for very little gain. The Dexie cache means repeat mounts are cheap and the
 * first paint is instant even offline.
 */
export const useEntitlements = (userId: string | null): EntitlementsState => {
    const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
    const [loading, setLoading] = useState(userId !== null);

    const refresh = useCallback(async () => {
        if (!userId) {
            return;
        }
        setEntitlements(await loadEntitlements(userId));
    }, [userId]);

    useEffect(() => {
        if (!userId) {
            return;
        }

        let mounted = true;
        void (async () => {
            // Paint from cache first so an offline start is instant, then
            // reconcile with the server.
            try {
                const cached = await readCachedEntitlements(userId);
                if (mounted && cached) {
                    setEntitlements(cached);
                }
            } catch {
                // Cache miss is not worth surfacing — the server read follows.
            }
            try {
                const fresh = await loadEntitlements(userId);
                if (mounted) {
                    setEntitlements(fresh);
                }
            } catch {
                // loadEntitlements already falls back to cache, then to free.
            }
            if (mounted) {
                setLoading(false);
            }
        })();

        return () => {
            mounted = false;
        };
    }, [userId]);

    // Derived rather than stored, so signing out needs no effect-driven reset.
    if (!userId) {
        return { entitlements: null, loading: false, refresh };
    }
    return { entitlements, loading, refresh };
};
