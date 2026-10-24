import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useLayoutEffect, useRef } from 'react';

import { menuItemClassName } from '@/ui/classNames';
import type { MenuItemProps, MenuProps } from '@/ui/Menu';

/** The keys a closed trigger opens on, as far as where the highlight lands goes. */
export type MenuOpenKey = 'ArrowDown' | 'ArrowUp';

/**
 * The app's dropdown menu on Base UI's Menu — ui/Menu, which callers use,
 * loads this chunk on idle, on the trigger's hover or focus, or on its first
 * press, and renders the trigger itself until then.
 */
export interface MenuBaseProps extends MenuProps {
    /** Open as it mounts: the trigger was pressed before this chunk had loaded. */
    defaultOpen?: boolean;
    /**
     * Open as it mounts, as this key on the trigger opens it: the stand-in got
     * the key (or Enter or Space, which open as ArrowDown does) before this
     * chunk had loaded.
     */
    openWithKey?: MenuOpenKey;
    /** Focus the trigger as it mounts: it takes over from a stand-in that had focus. */
    focusTrigger?: boolean;
}

export const MenuBase = ({
    label,
    triggerClassName,
    triggerContent,
    triggerTitle,
    disabled = false,
    menuLabel,
    popupClassName = 'w-48',
    open,
    onOpenChange,
    defaultOpen = false,
    openWithKey,
    focusTrigger = false,
    children,
}: MenuBaseProps) => {
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    useLayoutEffect(() => {
        if (focusTrigger) {
            triggerRef.current?.focus();
        }
    }, [focusTrigger]);
    useLayoutEffect(() => {
        // The key is replayed on the real trigger, so Base UI opens the menu as
        // it would have had the key landed there: as a keyboard open, with the
        // first item (ArrowDown) or the last (ArrowUp) highlighted and focused.
        if (openWithKey) {
            triggerRef.current?.dispatchEvent(
                new KeyboardEvent('keydown', { key: openWithKey, bubbles: true, cancelable: true }),
            );
        }
    }, [openWithKey]);
    return (
        <BaseMenu.Root
            modal={false}
            open={open}
            defaultOpen={defaultOpen}
            onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
        >
            <BaseMenu.Trigger
                ref={triggerRef}
                aria-label={label}
                title={triggerTitle}
                disabled={disabled}
                className={triggerClassName}
            >
                {triggerContent}
            </BaseMenu.Trigger>
            <BaseMenu.Portal>
                <BaseMenu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={16} className="z-50">
                    <BaseMenu.Popup
                        aria-label={menuLabel}
                        className={`ui-menu-pop max-h-[var(--available-height)] overflow-y-auto overscroll-contain rounded-xl border border-stone-200 bg-white py-1 shadow-lg outline-none ${popupClassName}`}
                    >
                        {children}
                    </BaseMenu.Popup>
                </BaseMenu.Positioner>
            </BaseMenu.Portal>
        </BaseMenu.Root>
    );
};

/** A menu item. A native <button> unless `render` swaps in a link. */
export const MenuBaseItem = ({
    children,
    onClick,
    danger = false,
    disabled = false,
    render,
    className,
}: MenuItemProps) => (
    <BaseMenu.Item
        nativeButton={!render}
        render={render ?? <button type="button" />}
        disabled={disabled}
        onClick={onClick}
        className={className ?? menuItemClassName(danger)}
    >
        {children}
    </BaseMenu.Item>
);

export const MenuBaseSeparator = () => <BaseMenu.Separator className="my-1 border-t border-stone-200" />;
