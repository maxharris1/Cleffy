import { Popover } from '@base-ui/react/popover';

import { linkViewerCount } from '@/lib/presenceName';
import { useMediaQuery } from '@/lib/useMediaQuery';
import type { PresencePeer } from '@/sync/wire';
import { menuPopupClassName } from '@/ui/classNames';

export interface PresenceBarProps {
    peers: PresencePeer[];
    selfUserId: string;
    /** The name to show for a peer (presenceLabel); defaults to the name it announced. */
    labelOf?: (peer: PresencePeer) => string;
}

const CHIP =
    'inline-flex h-[30px] min-w-11 items-center gap-2 whitespace-nowrap rounded-full bg-paper/10 pl-2.5 pr-3 text-[13px] font-semibold text-paper ring-1 ring-paper/24';

const Dot = ({ color }: { color: string }) => (
    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
);

/**
 * Who's here: a named chip per person, a dot in their ink colour, up to three
 * (two below 640px), then one "+N" chip for the rest, so a crowd keeps the
 * header to one row. Names narrow once three people are here, so the fullest
 * group still fits beside the header's actions. Each named chip opens a small
 * popover with the name and the page they are on — on hover with a mouse, on a
 * tap on touch. "+N" opens a paper list of everyone it stands for.
 */
export const PresenceBar = ({ peers, selfUserId, labelOf = (peer) => peer.name }: PresenceBarProps) => {
    const wide = useMediaQuery('(min-width: 40rem)');
    const others = peers.filter((p) => p.userId !== selfUserId);
    if (others.length === 0) {
        return null;
    }
    const people = others.map((peer) => {
        const name = labelOf(peer);
        return { peer, name, who: `${name}${peer.isAnonymous && peer.via !== 'link' ? ' (guest)' : ''}` };
    });
    const shown = people.slice(0, wide ? 3 : 2);
    const rest = people.slice(shown.length);
    const crowded = people.length > 2;
    const restLabel = `${rest.length} more collaborators`;
    return (
        <div
            className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-1.5 pointer-coarse:gap-y-3.5 lg:-order-1"
            aria-label={`${others.length} collaborators viewing`}
        >
            {shown.map(({ peer, name, who }) => (
                <Popover.Root key={peer.userId}>
                    <Popover.Trigger
                        openOnHover
                        delay={150}
                        aria-label={`${who}, on page ${peer.page + 1}`}
                        className={`${CHIP} relative cursor-default pointer-coarse:hit-44-y`}
                    >
                        <Dot color={peer.color} />
                        <span className={`truncate ${crowded ? 'max-w-20 sm:max-w-32' : 'max-w-40'}`}>{name}</span>
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
            ))}
            {rest.length > 0 ? (
                <Popover.Root>
                    <Popover.Trigger
                        aria-label={restLabel}
                        className={`${CHIP} relative cursor-pointer justify-center tabular-nums pointer-coarse:hit-44-y`}
                    >
                        +{rest.length}
                    </Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Positioner side="bottom" sideOffset={6} collisionPadding={8} className="z-50">
                            <Popover.Popup
                                className={menuPopupClassName('paper', 'max-h-[min(24rem,70dvh)] w-64 overflow-y-auto')}
                            >
                                <ul aria-label={restLabel}>
                                    {rest.map(({ peer, who }) => (
                                        <li
                                            key={peer.userId}
                                            className="flex items-center gap-2.5 rounded-xl px-3 py-2 pointer-coarse:min-h-11"
                                        >
                                            <Dot color={peer.color} />
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">
                                                {who}
                                            </span>
                                            <span className="shrink-0 text-xs tabular-nums text-stone-500">
                                                Page {peer.page + 1}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </Popover.Popup>
                        </Popover.Positioner>
                    </Popover.Portal>
                </Popover.Root>
            ) : null}
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
        <span className={`${CHIP} lg:-order-1`} title="People watching through your view link">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-ink-rule" />
            {count} viewing
        </span>
    );
};
