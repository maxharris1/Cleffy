import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { isChunkLoadError, reloadForStaleChunk } from '@/lib/staleChunk';
import { menuBaseModule as menuBase } from '@/ui/lazyPrimitives';
import type { MenuOpenKey } from '@/ui/MenuBase';

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

/** The load-failure notice's width, and the page gutter it keeps from the screen edges (px). */
const NOTICE_WIDTH = 240;
const GUTTER = 16;

/**
 * Shown under a stand-in trigger when the menu's chunk could not be fetched
 * for an open and reloading the page is not the answer (offline, or a reload
 * for a stale chunk was already tried moments ago). Pressing the trigger
 * again tries the chunk again; any press elsewhere, a scroll or Escape puts
 * the notice away.
 */
const MenuLoadFailed = ({ anchor, onDismiss }: { anchor: DOMRect; onDismiss: () => void }) => {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onDismiss();
            }
        };
        document.addEventListener('pointerdown', onDismiss, true);
        document.addEventListener('scroll', onDismiss, { capture: true, passive: true });
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onDismiss, true);
            document.removeEventListener('scroll', onDismiss, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onDismiss]);
    // Where the menu would have opened: under the trigger, its end edge on the
    // trigger's, kept off the screen edges by the page gutter (as the menu is).
    const width = Math.min(NOTICE_WIDTH, window.innerWidth - 2 * GUTTER);
    const left = Math.max(GUTTER, Math.min(anchor.right - width, window.innerWidth - GUTTER - width));
    return createPortal(
        <p
            role="alert"
            style={{ top: anchor.bottom + 4, left, width }}
            className="fixed z-50 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 shadow-lg"
        >
            {navigator.onLine === false
                ? 'You’re offline, so this menu couldn’t open. Reconnect, then try again.'
                : 'This menu couldn’t open. Check your connection, then try again.'}
        </p>,
        document.body,
    );
};

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
 *
 * The keys that open Base UI's menu open the stand-in's too, landing where
 * Base UI's would: ArrowDown, Enter and Space on the first item, ArrowUp on
 * the last.
 *
 * An open that cannot fetch the chunk is not dropped as a prefetch's failure
 * is (even when it joined a prefetch already under way): a chunk from an
 * older build reloads the page (lib/staleChunk.ts), and when that is not
 * possible the trigger says the menu could not open, and a press tries again.
 */
export const Menu = (props: MenuProps) => {
    const loaded = useSyncExternalStore(menuBase.subscribe, menuBase.get, menuBase.get);
    const [hovered, setHovered] = useState(false);
    const [pressing, setPressing] = useState(false);
    const [openOnLoad, setOpenOnLoad] = useState(false);
    const [openKey, setOpenKey] = useState<MenuOpenKey | null>(null);
    const [focused, setFocused] = useState(false);
    /** Where the stand-in was when an open failed to load the menu; null when it has not. */
    const [failedAt, setFailedAt] = useState<DOMRect | null>(null);
    const standIn = useRef<HTMLButtonElement | null>(null);
    /** Enter or Space is down on the stand-in: the click that follows is the keyboard's. */
    const keyPress = useRef(false);
    const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(settle.current), []);
    const dismissFailure = useCallback(() => setFailedAt(null), []);

    if (loaded && (openOnLoad || openKey !== null || (!hovered && !pressing))) {
        // Opening hands focus to the popup itself (and back to the trigger on close).
        // A key's open is replayed on the real trigger, which has focus by then; one
        // whose stand-in lost focus while the chunk loaded is dropped.
        return (
            <loaded.MenuBase
                {...props}
                defaultOpen={openOnLoad}
                openWithKey={focused && openKey !== null ? openKey : undefined}
                focusTrigger={focused && !openOnLoad}
            />
        );
    }

    const { label, triggerClassName, triggerContent, triggerTitle, disabled = false, open, onOpenChange } = props;
    /** Load the menu for an open the user asked for; `undo` takes the open back if it cannot. */
    const loadForOpen = (undo: () => void) => {
        clearTimeout(settle.current);
        setFailedAt(null);
        menuBase.load().catch((error: unknown) => {
            if (isChunkLoadError(error) && reloadForStaleChunk()) {
                return;
            }
            undo();
            setFailedAt(standIn.current?.getBoundingClientRect() ?? null);
        });
    };
    const openWhenLoaded = () => {
        setOpenOnLoad(true);
        onOpenChange?.(true);
        loadForOpen(() => {
            setOpenOnLoad(false);
            onOpenChange?.(false);
        });
    };
    const openOnKey = (key: MenuOpenKey) => {
        setOpenKey(key);
        loadForOpen(() => setOpenKey(null));
    };
    return (
        <>
            <button
                ref={standIn}
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
                onBlur={() => {
                    setFocused(false);
                    keyPress.current = false;
                }}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        // As Base UI's trigger does: the arrow opens the menu, not scrolls the page.
                        event.preventDefault();
                        openOnKey(event.key);
                    } else if (event.key === 'Enter' || event.key === ' ') {
                        keyPress.current = true;
                    }
                }}
                onPointerDown={(event) => {
                    keyPress.current = false;
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
                onClick={() => {
                    if (keyPress.current) {
                        keyPress.current = false;
                        // Enter and Space land on the first item, as ArrowDown does.
                        openOnKey('ArrowDown');
                    } else {
                        openWhenLoaded();
                    }
                }}
            >
                {triggerContent}
            </button>
            {failedAt ? <MenuLoadFailed anchor={failedAt} onDismiss={dismissFailure} /> : null}
        </>
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
