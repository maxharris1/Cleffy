import { Popover } from '@base-ui/react/popover';

import { initialsOf } from '@/features/account/initials';
import { linkViewerCount } from '@/lib/presenceName';
import type { PresencePeer } from '@/sync/wire';

const MAX_CHIPS = 5;

export interface PresenceBarProps {
    peers: PresencePeer[];
    selfUserId: string;
    /** The name to show for a peer (presenceLabel); defaults to the name it announced. */
    labelOf?: (peer: PresencePeer) => string;
}

const CHIP =
    'flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold text-white shadow-sm';

/**
 * Who's here: colored initial chips. Each chip is a button that opens a small
 * popover with the name and the page they are on — on hover with a mouse, on
 * a tap on touch, where a title tooltip never appeared.
 */
export const PresenceBar = ({ peers, selfUserId, labelOf = (peer) => peer.name }: PresenceBarProps) => {
    const others = peers.filter((p) => p.userId !== selfUserId);
    if (others.length === 0) {
        return null;
    }
    const shown = others.slice(0, MAX_CHIPS);
    const overflow = others.length - shown.length;

    return (
        // Overlapped on a fine pointer. On touch each chip's 44px hit area
        // (hit-44) would overlap its neighbour's and the later chip would win
        // every tap meant for the one before, so the chips stand apart there,
        // 28px + a 16px gap: 44px from centre to centre, no overlap.
        <div
            className="flex items-center -space-x-1.5 pointer-coarse:gap-4 pointer-coarse:space-x-0"
            aria-label={`${others.length} collaborators viewing`}
        >
            {shown.map((peer) => {
                const name = labelOf(peer);
                const who = `${name}${peer.isAnonymous && peer.via !== 'link' ? ' (guest)' : ''}`;
                return (
                    <Popover.Root key={peer.userId}>
                        <Popover.Trigger
                            openOnHover
                            delay={150}
                            aria-label={`${who}, on page ${peer.page + 1}`}
                            className={`${CHIP} relative cursor-default pointer-coarse:hit-44`}
                            style={{ backgroundColor: peer.color }}
                        >
                            {initialsOf(name)}
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Positioner side="bottom" sideOffset={6} collisionPadding={8} className="z-50">
                                <Popover.Popup className="ui-menu-pop rounded-lg border border-stone-200 bg-white px-3 py-2 text-left shadow-lg outline-none">
                                    <p className="max-w-56 truncate text-sm font-medium text-stone-800">{who}</p>
                                    <p className="text-xs tabular-nums text-stone-500">Page {peer.page + 1}</p>
                                </Popover.Popup>
                            </Popover.Positioner>
                        </Popover.Portal>
                    </Popover.Root>
                );
            })}
            {overflow > 0 ? <span className={`${CHIP} bg-stone-400`}>+{overflow}</span> : null}
        </div>
    );
};

export interface LinkViewerCountProps {
    peers: PresencePeer[];
}

export const LinkViewerCount = ({ peers }: LinkViewerCountProps) => {
    const count = linkViewerCount(peers);
    if (count === 0) {
        return null;
    }
    return (
        <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent"
            title="People watching through your view link"
        >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            {count} viewing
        </span>
    );
};
