import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { menuBaseModule as menuBase } from '@/ui/lazyPrimitives';

/**
 * The app's dropdown menu, on Base UI's Menu: arrow keys and Home/End move
 * through the items, typing jumps to one, Escape closes and puts focus back on
 * the trigger, and the popup flips and shifts to stay on screen (collision
 * padding = the page gutter). It grows out of its trigger: Base UI publishes
 * --transform-origin, which .ui-menu-pop scales from.
 *
 * Non-modal: the page stays live behind an open menu, and a press outside
 * closes it and still lands where it was aimed.
 */
export interface MenuProps {
    /** The trigger's accessible name. */
    label: string;
    triggerClassName: string;
    triggerContent: ReactNode;
    triggerTitle?: string;
    disabled?: boolean;
    /** Accessible name of the menu itself, when it differs from the trigger's. */
    menuLabel?: string;
    /** Width and any extras for the popup. */
    popupClassName?: string;
    /** Controlled open state (the account menu closes on navigation). */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
}

/**
 * How long a released press holds back the switch to the loaded menu while
 * its click is still to come: a touch's click follows its pointerup (and its
 * pointerleave), and replacing the button in between would lose it.
 */
const PRESS_SETTLE_MS = 500;

/**
 * The Base UI menu (ui/MenuBase) is a lazy chunk. Until it has loaded, this
 * renders a stand-in trigger with the same look and accessible name; hovering
 * or focusing it warms the chunk, and pressing it opens the menu as soon as
 * the chunk is in. Once loaded (on idle, usually, well before anyone reaches
 * for a menu), every menu switches to the real one, carrying focus over if
 * the stand-in had it — but never under a pointer that is over it or pressing
 * it: a button swapped out from under the cursor loses its hover style until
 * the mouse moves, and one swapped out mid-press loses the click. A stand-in
 * that is pressed hands over as the menu opens.
 */
export const Menu = (props: MenuProps) => {
    const loaded = useSyncExternalStore(menuBase.subscribe, menuBase.get, menuBase.get);
    const [hovered, setHovered] = useState(false);
    const [pressing, setPressing] = useState(false);
    const [openOnLoad, setOpenOnLoad] = useState(false);
    const [focused, setFocused] = useState(false);
    const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(settle.current), []);

    if (loaded && (openOnLoad || (!hovered && !pressing))) {
        // Opening hands focus to the popup itself (and back to the trigger on close).
        return <loaded.MenuBase {...props} defaultOpen={openOnLoad} focusTrigger={focused && !openOnLoad} />;
    }

    const { label, triggerClassName, triggerContent, triggerTitle, disabled = false, open, onOpenChange } = props;
    const openWhenLoaded = () => {
        clearTimeout(settle.current);
        setOpenOnLoad(true);
        onOpenChange?.(true);
        void menuBase.load().catch(() => undefined);
    };
    return (
        <button
            type="button"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open === true}
            title={triggerTitle}
            disabled={disabled}
            className={triggerClassName}
            onPointerEnter={() => {
                setHovered(true);
                menuBase.prefetch();
            }}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => {
                setFocused(true);
                menuBase.prefetch();
            }}
            onBlur={() => setFocused(false)}
            onPointerDown={(event) => {
                if (event.button === 0) {
                    clearTimeout(settle.current);
                    setPressing(true);
                    menuBase.prefetch();
                }
            }}
            onPointerUp={() => {
                clearTimeout(settle.current);
                settle.current = setTimeout(() => setPressing(false), PRESS_SETTLE_MS);
            }}
            onPointerCancel={() => {
                clearTimeout(settle.current);
                setPressing(false);
            }}
            onClick={openWhenLoaded}
        >
            {triggerContent}
        </button>
    );
};

export interface MenuItemProps {
    children: ReactNode;
    onClick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    /** Render as something else — a router <Link>, an <a>. */
    render?: ReactElement;
    className?: string;
}

/**
 * A menu item. A native <button> unless `render` swaps in a link. Items render
 * inside the popup, which exists only once the menu chunk has loaded.
 */
export const MenuItem = (props: MenuItemProps) => {
    const loaded = useSyncExternalStore(menuBase.subscribe, menuBase.get, menuBase.get);
    return loaded ? <loaded.MenuBaseItem {...props} /> : null;
};

export const MenuSeparator = () => {
    const loaded = useSyncExternalStore(menuBase.subscribe, menuBase.get, menuBase.get);
    return loaded ? <loaded.MenuBaseSeparator /> : null;
};
