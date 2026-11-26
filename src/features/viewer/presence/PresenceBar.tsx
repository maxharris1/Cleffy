import { Popover } from '@base-ui/react/popover';

import { linkViewerCount } from '@/lib/presenceName';
import type { PresencePeer } from '@/sync/wire';

export interface PresenceBarProps {
    peers: PresencePeer[];
    selfUserId: string;
    /** The name to show for a peer (presenceLabel); defaults to the name it announced. */
    labelOf?: (peer: PresencePeer) => string;
}

const CHIP =
    'inline-flex h-[30px] min-w-11 items-center gap-2 whitespace-nowrap rounded-full bg-paper/10 pl-2.5 pr-3 text-[13px] font-semibold text-paper ring-1 ring-paper/24';

/**
 * Who's here: one named chip per person, a dot in their ink colour. Each chip is a button that opens a small
 * popover with the name and the page they are on — on hover with a mouse, on
 * a tap on touch, where a title tooltip never appeared.
 */
export const PresenceBar = ({ peers, selfUserId, labelOf = (peer) => peer.name }: PresenceBarProps) => {
    const others = peers.filter((p) => p.userId !== selfUserId);
    if (others.length === 0) {
        return null;
    }
    return (
        <div
            className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1.5 pointer-coarse:gap-y-3.5"
            aria-label={`${others.length} collaborators viewing`}
        >
            {others.map((peer) => {
                const name = labelOf(peer);
                const who = `${name}${peer.isAnonymous && peer.via !== 'link' ? ' (guest)' : ''}`;
                return (
                    <Popover.Root key={peer.userId}>
                        <Popover.Trigger
                            openOnHover
                            delay={150}
                            aria-label={`${who}, on page ${peer.page + 1}`}
                            className={`${CHIP} relative cursor-default pointer-coarse:hit-44-y`}
                        >
                            <span
                                aria-hidden="true"
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: peer.color }}
                            />
                            <span className="max-w-40 truncate">{name}</span>
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
        <span className={CHIP} title="People watching through your view link">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-ink-rule" />
            {count} viewing
        </span>
    );
};
