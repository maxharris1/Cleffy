import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';
import type { DocumentRow, Entitlements, LibraryTagRow } from '@/types/database';

import { LIBRARY_PAGE_SIZE } from '@/features/library/documentsService';
import { libraryMutationEpoch } from '@/features/library/libraryCache';

export interface LibraryBootstrap {
    documents: DocumentRow[];
    hasMore: boolean;
    favoriteIds: Set<string>;
    tags: LibraryTagRow[];
    documentTags: Map<string, string[]>;
    entitlements: Entitlements;
    /**
     * libraryMutationEpoch() when the request LEFT — not when a caller joined
     * the coalesced promise. A consumer that compares the current epoch to a
     * capture of its own could join a request dispatched before an earlier
     * mutation and wrongly conclude the payload is fresh.
     */
    fetchedAtEpoch: number;
}

interface BootstrapRpc {
    documents: DocumentRow[] | null;
    has_more: boolean;
    favorite_ids: string[] | null;
    tags: LibraryTagRow[] | null;
    document_tags: Array<{ document_id: string; tag_id: string }> | null;
    entitlements: Entitlements;
}

/**
 * Coalesce concurrent LibraryShell + LibraryPage mounts onto one HTTP call.
 * Keyed by user: a request that left under the previous account must never be
 * handed to the next one (the RPC answers for whoever the auth session was
 * when it executed, not for the caller's argument).
 */
let inflight: { userId: string; promise: Promise<LibraryBootstrap> } | null = null;

const tagMapFrom = (rows: Array<{ document_id: string; tag_id: string }>): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
        const list = map.get(row.document_id) ?? [];
        list.push(row.tag_id);
        map.set(row.document_id, list);
    }
    return map;
};

const cacheBootstrap = async (userId: string, boot: LibraryBootstrap): Promise<void> => {
    const now = new Date().toISOString();
    await Promise.all([
        getDb().entitlements.put({ userId, entitlements: boot.entitlements, cachedAt: now }),
        getDb().libraryList.put({
            userId,
            documents: boot.documents,
            hasMore: boot.hasMore,
            favoriteIds: [...boot.favoriteIds],
            tags: boot.tags,
            documentTags: [...boot.documentTags.entries()],
            cachedAt: now,
        }),
    ]);
};

/** Dexie snapshot for an instant library paint before the network returns. */
export const readCachedLibraryList = async (
    userId: string,
): Promise<{
    documents: DocumentRow[];
    hasMore: boolean;
    favoriteIds: Set<string>;
    tags: LibraryTagRow[];
    documentTags: Map<string, string[]>;
} | null> => {
    const row = await getDb().libraryList.get(userId);
    if (!row) {
        return null;
    }
    return {
        documents: row.documents,
        hasMore: row.hasMore,
        favoriteIds: new Set(row.favoriteIds),
        tags: row.tags,
        documentTags: new Map(row.documentTags),
    };
};

const fetchBootstrap = async (userId: string): Promise<LibraryBootstrap> => {
    const epochAtFetch = libraryMutationEpoch();
    const { data, error } = await getSupabase().rpc('library_bootstrap');
    if (error || !data) {
        throw new Error(error?.message ?? 'library_bootstrap returned nothing');
    }
    const raw = data as BootstrapRpc;
    const documents = raw.documents ?? [];
    // Defensive: server already caps at LIBRARY_PAGE_SIZE, but keep the client
    // contract identical to listDocuments().
    const hasMore = Boolean(raw.has_more) || documents.length > LIBRARY_PAGE_SIZE;
    const trimmed = hasMore && documents.length > LIBRARY_PAGE_SIZE ? documents.slice(0, LIBRARY_PAGE_SIZE) : documents;
    const boot: LibraryBootstrap = {
        documents: trimmed,
        hasMore,
        favoriteIds: new Set(raw.favorite_ids ?? []),
        tags: raw.tags ?? [],
        documentTags: tagMapFrom(raw.document_tags ?? []),
        entitlements: { ...raw.entitlements, user_id: userId },
        fetchedAtEpoch: epochAtFetch,
    };
    // A mutation (or sign-out) since this request left means the payload
    // predates local edits: hand it to the caller — which re-checks the epoch
    // before applying — but do not persist it over their newer state.
    if (libraryMutationEpoch() === epochAtFetch) {
        await cacheBootstrap(userId, boot);
    }
    return boot;
};

/**
 * One round-trip for documents + favorites + tags + entitlements.
 * Concurrent callers for the same user share the in-flight promise.
 */
export const fetchLibraryBootstrap = (userId: string): Promise<LibraryBootstrap> => {
    if (inflight && inflight.userId === userId) {
        return inflight.promise;
    }
    const promise = fetchBootstrap(userId).finally(() => {
        if (inflight?.promise === promise) {
            inflight = null;
        }
    });
    inflight = { userId, promise };
    return promise;
};
