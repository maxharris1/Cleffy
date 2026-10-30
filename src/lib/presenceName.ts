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

export const safePresenceName = (name: string | null | undefined, isAnonymous: boolean): string => {
    const trimmed = (name ?? '').trim();
    if (trimmed && !EMAIL_LIKE.test(trimmed)) {
        return trimmed.slice(0, MAX_NAME);
    }
    return isAnonymous ? 'Guest' : 'Collaborator';
};
