import { useEffect, useRef, useState } from 'react';

import { listDocumentMembers } from '@/features/share/shareService';
import type { PresencePeer } from '@/sync/wire';
import type { MemberRole } from '@/types/database';

/** At most one member-list refetch per this many ms, however many strangers appear. */
export const MEMBER_REFETCH_MIN_MS = 5_000;

/**
 * The ids of the score's members, for presenceLabel (R4), while `enabled` and
 * the account is its owner or an editor (viewers are not given the list).
 * Refetched, throttled, when a peer appears that the list does not know and
 * no fetch has been asked about yet: someone who just joined is labelled by
 * their name once the list catches up; a stranger costs one refetch, not one
 * every few seconds. Null until the first list arrives, so names show as
 * announced rather than flash anonymous.
 */
export const usePresenceMembers = (
    docId: string,
    role: MemberRole | null | undefined,
    peers: readonly PresencePeer[],
    enabled: boolean,
): ReadonlySet<string> | null => {
    const allowed = enabled && (role === 'owner' || role === 'editor');
    const [members, setMembers] = useState<{ docId: string; ids: ReadonlySet<string> } | null>(null);
    const askedRef = useRef<{ docId: string; ids: Set<string>; at: number } | null>(null);
    const current = allowed && members?.docId === docId ? members.ids : null;
    const loaded = current !== null;
    const unknown = peers
        .filter((p) => p.via !== 'link' && !current?.has(p.userId))
        .map((p) => p.userId)
        .sort()
        .join(',');

    useEffect(() => {
        if (!allowed) {
            return;
        }
        if (askedRef.current?.docId !== docId) {
            askedRef.current = { docId, ids: new Set(), at: -Infinity };
        }
        const asked = askedRef.current;
        const fresh = unknown.split(',').filter((id) => id && !asked.ids.has(id));
        if (loaded && fresh.length === 0) {
            return;
        }
        let cancelled = false;
        const timer = setTimeout(
            () => {
                asked.at = Date.now();
                for (const id of fresh) {
                    asked.ids.add(id);
                }
                listDocumentMembers(docId)
                    .then((rows) => {
                        if (!cancelled) {
                            setMembers({ docId, ids: new Set(rows.map((r) => r.user_id)) });
                        }
                    })
                    .catch((err: unknown) => console.warn('Could not load the member list for presence', err));
            },
            Math.max(0, asked.at + MEMBER_REFETCH_MIN_MS - Date.now()),
        );
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [allowed, loaded, unknown, docId]);

    return current;
};
