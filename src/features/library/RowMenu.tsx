import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { MoreVerticalIcon } from '@/ui/icons';

/**
 * Owner actions for one score, as a popover menu.
 *
 * Lifted out of LibraryPage unchanged so the shelf card and the list row share
 * one implementation — the accessible name ("Score actions"), the item labels
 * and the dismiss behaviour are contract, not decoration.
 *
 * The trigger carries `aria-expanded`, which callers can also key off in CSS
 * (`has-[[aria-expanded=true]]:…`) to keep an open menu painted above its
 * neighbours.
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
    <MenuPopover inline={inline}>
        {(pick) => (
            <>
                <MenuItem label="Rename" onClick={() => pick(onRename)} />
                <MenuItem label="Share…" onClick={() => pick(onShare)} />
                {onAssign ? <MenuItem label="Assign to student…" onClick={() => pick(onAssign)} /> : null}
                <MenuItem label="Delete" danger onClick={() => pick(onDelete)} />
            </>
        )}
    </MenuPopover>
);

/**
 * The same menu for a score someone else shared with you. Rename, share and
 * delete are the owner's; what a member can do is take it out of their own
 * library, which is leaving it.
 */
export const SharedScoreMenu = ({ onLeave, inline = false }: { onLeave: () => void; inline?: boolean }) => (
    <MenuPopover inline={inline}>
        {(pick) => <MenuItem label="Remove from my library" danger onClick={() => pick(onLeave)} />}
    </MenuPopover>
);

/** Keep the menu this far inside the viewport edges — the page's side gutter. */
const VIEWPORT_GUTTER = 16;
/** The gap between trigger and menu (Tailwind's `mt-1`). */
const MENU_OFFSET = 4;

/**
 * The menu hangs off a narrow trigger near any edge of the screen — the left
 * column of the shelf, the last row of the list — so a fixed `right-0`, drop-
 * down placement spilled off the left edge or below the fold. Measure once it
 * is open: slide it sideways into the gutter, and open it upwards when there
 * is more room above than below. The top edge stops at the shell's sticky bar,
 * which would otherwise paint over a menu flipped up under it.
 */
const placeMenu = (root: HTMLElement, menu: HTMLElement): Partial<CSSStyleDeclaration> => {
    const anchor = root.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = menu.offsetWidth;
    const height = menu.scrollHeight;

    // Right-aligned to the trigger by default, clamped into the gutter.
    const left = Math.max(VIEWPORT_GUTTER, Math.min(anchor.right - width, viewportWidth - VIEWPORT_GUTTER - width));

    const barValue = getComputedStyle(root).getPropertyValue('--shell-bar-height').trim();
    const bar = barValue.endsWith('rem')
        ? parseFloat(barValue) * parseFloat(getComputedStyle(document.documentElement).fontSize)
        : parseFloat(barValue) || 0;
    const below = viewportHeight - anchor.bottom - MENU_OFFSET - VIEWPORT_GUTTER;
    const above = anchor.top - bar - MENU_OFFSET - VIEWPORT_GUTTER;
    const up = height > below && above > below;

    return {
        left: `${left - anchor.left}px`,
        right: 'auto',
        ...(up
            ? { top: 'auto', bottom: '100%', marginTop: '0px', marginBottom: `${MENU_OFFSET}px` }
            : { top: '100%', bottom: 'auto' }),
        // Only bites on a very short screen (phone landscape): the menu scrolls
        // inside itself rather than running off it.
        maxHeight: `${Math.max(up ? above : below, 120)}px`,
    };
};

const MenuPopover = ({
    inline,
    children,
}: {
    inline: boolean;
    children: (pick: (action: () => void) => void) => ReactNode;
}) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);

    // Before paint, so the menu never flashes in its unclamped spot. Written
    // straight to the element: the menu is freshly mounted on every open, so
    // there is no stale placement to reset.
    useLayoutEffect(() => {
        if (!open) {
            return;
        }
        const place = () => {
            if (rootRef.current && menuRef.current) {
                Object.assign(menuRef.current.style, placeMenu(rootRef.current, menuRef.current));
            }
        };
        place();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const pick = (action: () => void) => {
        setOpen(false);
        action();
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Score actions"
                onClick={() => setOpen((v) => !v)}
                className={`relative grid place-items-center rounded-lg p-1.5 text-stone-400 transition hover:bg-ink/5 hover:text-stone-600 ${
                    inline
                        ? 'pointer-coarse:before:absolute pointer-coarse:before:left-0 pointer-coarse:before:-right-3 pointer-coarse:before:-inset-y-2'
                        : 'pointer-coarse:before:absolute pointer-coarse:before:-inset-2'
                }`}
            >
                <MoreVerticalIcon size={16} />
            </button>
            {open ? (
                <div
                    ref={menuRef}
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-48 overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    {children(pick)}
                </div>
            ) : null}
        </div>
    );
};

const MenuItem = ({ label, danger = false, onClick }: { label: string; danger?: boolean; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={`w-full px-3 py-2 text-left text-sm transition hover:bg-ink/5 ${
            danger ? 'text-danger' : 'text-stone-800'
        }`}
    >
        {label}
    </button>
);
