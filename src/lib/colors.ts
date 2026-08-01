/** Collaborator identity colors — derived deterministically from the user id
 * so every client agrees without coordination (plan §realtime). */

const PEER_COLORS = [
    '#dc2626', // red
    '#2563eb', // blue
    '#16a34a', // green
    '#ea580c', // orange
    '#9333ea', // purple
    '#0d9488', // teal
    '#db2777', // pink
    '#ca8a04', // amber
] as const;

export const peerColor = (userId: string): string => {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    return PEER_COLORS[hash % PEER_COLORS.length] as string;
};
