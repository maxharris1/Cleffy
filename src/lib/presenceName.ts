import { anonymousName } from '@/features/share/anonymousAnimals';
import type { PresencePeer } from '@/sync/wire';

/**
 * What collaborators see as someone's name in the presence bar: the display
 * name they chose, else "Guest" for a share-link guest and "Collaborator" for
 * everyone else — never an email address.
 *
 * Presence is visible to everybody on a shared score, a teacher's students
 * included, so an address there is personal data handed to people who never
 * needed it. The same rule runs on both ends: when this browser announces
 * itself (presenceNameOf in session.ts), and when it draws someone else's
 * announcement (realtimeChannel.ts), so an older build that still sends an
 * email is not shown as one.
 */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;

/** Longest name the presence schema accepts (src/sync/wire.ts). */
const MAX_NAME = 80;

/** The name as it may be shown, or null when there is none to show (blank, or an address). */
export const chosenPresenceName = (name: string | null | undefined): string | null => {
    const trimmed = (name ?? '').trim();
    return trimmed && !EMAIL_LIKE.test(trimmed) ? trimmed.slice(0, MAX_NAME) : null;
};

export const safePresenceName = (name: string | null | undefined, isAnonymous: boolean): string =>
    chosenPresenceName(name) ?? (isAnonymous ? 'Guest' : 'Collaborator');

/**
 * What owners and editors see for a presence entry (Share v2, R4). Anyone who
 * is not a member of the score (a signed-out link viewer, or anything that
 * claims a name it has no right to) is "Anonymous <animal>", whatever name it
 * announced. With no member list (a viewer's own screen) the announced name
 * stands, cleaned as everywhere.
 */
export const presenceLabel = (peer: PresencePeer, members: ReadonlySet<string> | null): string =>
    members && !members.has(peer.userId) ? anonymousName(peer.userId) : safePresenceName(peer.name, peer.isAnonymous);

/** People on the score through its view link, signed out: the owner's "N viewing". */
export const linkViewerCount = (peers: readonly PresencePeer[]): number =>
    new Set(peers.filter((p) => p.via === 'link').map((p) => p.userId)).size;
