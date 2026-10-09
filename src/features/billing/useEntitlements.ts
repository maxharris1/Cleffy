import { useCallback, useEffect, useState } from 'react';

import { loadEntitlements, readCachedEntitlements } from '@/features/billing/entitlementsService';
import { fetchLibraryBootstrap } from '@/features/library/libraryBootstrap';
import type { Entitlements } from '@/types/database';

export interface EntitlementsState {
    entitlements: Entitlements | null;
    loading: boolean;
    refresh: () => Promise<void>;
}

export interface UseEntitlementsOptions {
    /**
     * When true (library shell), load via library_bootstrap so the page and
     * plan badge share one HTTP round-trip. Account and other surfaces keep
     * the lean get_entitlements RPC.
     */
    viaLibraryBootstrap?: boolean;
}

/**
 * Loads entitlements alongside the session.
 *
 * Deliberately a plain hook with no context, matching useSession — this app has
 * no auth provider, and a second one just for billing would be a new pattern
 * for very little gain. The Dexie cache means repeat mounts are cheap and the
 * first paint is instant even offline.
 */
export const useEntitlements = (userId: string | null, options: UseEntitlementsOptions = {}): EntitlementsState => {
    const viaBootstrap = options.viaLibraryBootstrap === true;
    const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
    const [loading, setLoading] = useState(userId !== null);

    const refresh = useCallback(async () => {
        if (!userId) {
            return;
        }
        if (viaBootstrap) {
            try {
                setEntitlements((await fetchLibraryBootstrap(userId)).entitlements);
                return;
            } catch {
                // Fall through to the lean RPC.
            }
        }
        setEntitlements(await loadEntitlements(userId));
    }, [userId, viaBootstrap]);

    useEffect(() => {
        if (!userId) {
            return;
        }

        let mounted = true;
        // Server first, cache alongside — two independent legs. The request
        // must not wait behind an IndexedDB open it does not need, and its
        // answer must not wait behind the cache read either. A fresh answer
        // that lands before the cached row is read makes the cached paint moot.
        let freshArrived = false;
        const fresh: Promise<Entitlements> = viaBootstrap
            ? fetchLibraryBootstrap(userId).then((boot) => boot.entitlements)
            : loadEntitlements(userId);

        void (async () => {
            try {
                const cached = await readCachedEntitlements(userId);
                if (mounted && cached && !freshArrived) {
                    setEntitlements(cached);
                }
            } catch {
                // Cache miss is not worth surfacing — the server read follows.
            }
        })();

        void (async () => {
            let value: Entitlements | null = null;
            try {
                value = await fresh;
            } catch {
                if (viaBootstrap) {
                    try {
                        // loadEntitlements already falls back to cache, then to free.
                        value = await loadEntitlements(userId);
                    } catch {
                        value = null;
                    }
                }
            }
            if (value) {
                freshArrived = true;
            }
            if (mounted) {
                if (value) {
                    setEntitlements(value);
                }
                setLoading(false);
            }
        })();

        return () => {
            mounted = false;
        };
    }, [userId, viaBootstrap]);

    // Derived rather than stored, so signing out needs no effect-driven reset.
    if (!userId) {
        return { entitlements: null, loading: false, refresh };
    }
    return { entitlements, loading, refresh };
};
