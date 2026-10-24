import { Menu as BaseMenu } from '@base-ui/react/menu';
import type { ReactElement, ReactNode } from 'react';

import { menuItemClassName } from '@/ui/classNames';

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

export const Menu = ({
    label,
    triggerClassName,
    triggerContent,
    triggerTitle,
    disabled = false,
    menuLabel,
    popupClassName = 'w-48',
    open,
    onOpenChange,
    children,
}: MenuProps) => (
    <BaseMenu.Root modal={false} open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
        <BaseMenu.Trigger aria-label={label} title={triggerTitle} disabled={disabled} className={triggerClassName}>
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

export interface MenuItemProps {
    children: ReactNode;
    onClick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    /** Render as something else — a router <Link>, an <a>. */
    render?: ReactElement;
    className?: string;
}

/** A menu item. A native <button> unless `render` swaps in a link. */
export const MenuItem = ({ children, onClick, danger = false, disabled = false, render, className }: MenuItemProps) => (
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

export const MenuSeparator = () => <BaseMenu.Separator className="my-1 border-t border-stone-200" />;
