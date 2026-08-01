import type { PresencePeer } from '@/sync/wire';

const MAX_CHIPS = 5;

const initialsOf = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '?';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase();
};

export interface PresenceBarProps {
    peers: PresencePeer[];
    selfUserId: string;
}

/** Who's here: colored initial chips, collaborator page hints in tooltips. */
export const PresenceBar = ({ peers, selfUserId }: PresenceBarProps) => {
    const others = peers.filter((p) => p.userId !== selfUserId);
    if (others.length === 0) {
        return null;
    }
    const shown = others.slice(0, MAX_CHIPS);
    const overflow = others.length - shown.length;

    return (
        <div className="flex items-center -space-x-1.5" aria-label={`${others.length} collaborators viewing`}>
            {shown.map((peer) => (
                <span
                    key={peer.userId}
                    title={`${peer.name}${peer.isAnonymous ? ' (guest)' : ''} — page ${peer.page + 1}`}
                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white shadow-sm"
                    style={{ backgroundColor: peer.color }}
                >
                    {initialsOf(peer.name)}
                </span>
            ))}
            {overflow > 0 ? (
                <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-stone-400 text-[10px] font-bold text-white shadow-sm">
                    +{overflow}
                </span>
            ) : null}
        </div>
    );
};
