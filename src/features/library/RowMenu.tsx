import type { ReactNode } from 'react';

import { MoreVerticalIcon } from '@/ui/icons';
import { Menu, MenuItem } from '@/ui/Menu';

/**
 * Owner actions for one score, as a popover menu.
 *
 * Lifted out of LibraryPage unchanged so the shelf card and the list row share
 * one implementation — the accessible name ("Score actions"), the item labels
 * and the dismiss behaviour are contract, not decoration.
 *
 * On the shared Base UI menu (ui/Menu): keyboard movement, Escape with focus
 * back on the trigger, and collision handling that keeps it on screen from
 * any corner of the shelf. The trigger carries `aria-expanded`, which callers
 * can also key off in CSS (`has-[[aria-expanded=true]]:…`) to keep a card with
 * an open menu rendered.
 *
 * `inline` is for a trigger that ends a row of other icon buttons: on touch its
 * invisible 40x44 hit area runs past its right edge only, since the all-round
 * ring the shelf card uses would overlap the neighbour on its left.
 */
export const RowMenu = ({
    onRename,
    onShare,
    onAssign,
    onDelete,
    inline = false,
}: {
    inline?: boolean;
    onRename: () => void;
    onShare: () => void;
    /** Omitted when the plan has no roster — the item disappears with it. */
    onAssign?: () => void;
    onDelete: () => void;
}) => (
    <ScoreMenu inline={inline}>
        <MenuItem onClick={onRename}>Rename</MenuItem>
        <MenuItem onClick={onShare}>Share…</MenuItem>
        {onAssign ? <MenuItem onClick={onAssign}>Assign to student…</MenuItem> : null}
        <MenuItem danger onClick={onDelete}>
            Delete
        </MenuItem>
    </ScoreMenu>
);

/**
 * The same menu for a score someone else shared with you. Rename, share and
 * delete are the owner's; what a member can do is take it out of their own
 * library, which is leaving it.
 */
export const SharedScoreMenu = ({ onLeave, inline = false }: { onLeave: () => void; inline?: boolean }) => (
    <ScoreMenu inline={inline}>
        <MenuItem danger onClick={onLeave}>
            Remove from my library
        </MenuItem>
    </ScoreMenu>
);

const ScoreMenu = ({ inline, children }: { inline: boolean; children: ReactNode }) => (
    <Menu
        label="Score actions"
        triggerContent={<MoreVerticalIcon size={16} />}
        triggerClassName={`relative grid place-items-center rounded-lg p-1.5 text-stone-400 transition-colors hover:bg-ink/5 hover:text-stone-600 ${
            inline
                ? 'pointer-coarse:before:absolute pointer-coarse:before:left-0 pointer-coarse:before:-right-3 pointer-coarse:before:-inset-y-2'
                : 'pointer-coarse:before:absolute pointer-coarse:before:-inset-2'
        }`}
    >
        {children}
    </Menu>
);
