import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useLayoutEffect, useRef } from 'react';

import { menuItemClassName } from '@/ui/classNames';
import { CheckIcon } from '@/ui/icons';
import type {
    MenuCheckboxItemProps,
    MenuItemProps,
    MenuProps,
    MenuRadioGroupProps,
    MenuRadioItemProps,
} from '@/ui/Menu';

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
    side = 'bottom',
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
                <BaseMenu.Positioner side={side} align="end" sideOffset={4} collisionPadding={16} className="z-50">
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

/** One choice of several, inside the menu: Base UI's radio group, labelled. */
export const MenuBaseRadioGroup = ({ label, value, onValueChange, children }: MenuRadioGroupProps) => (
    <BaseMenu.RadioGroup aria-label={label} value={value} onValueChange={(next: string) => onValueChange(next)}>
        {children}
    </BaseMenu.RadioGroup>
);

/** A menuitemradio: a check mark at the end of the chosen one. Choosing one closes the menu. */
export const MenuBaseRadioItem = ({ value, children }: MenuRadioItemProps) => (
    <BaseMenu.RadioItem
        value={value}
        closeOnClick
        className={menuItemClassName(false, 'gap-2.5 data-checked:text-accent')}
    >
        {children}
        <BaseMenu.RadioItemIndicator className="ml-auto">
            <CheckIcon size={16} />
        </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
);

/** A menuitemcheckbox: a check mark at the end while on. Toggling it closes the menu. */
export const MenuBaseCheckboxItem = ({ checked, onCheckedChange, title, children }: MenuCheckboxItemProps) => (
    <BaseMenu.CheckboxItem
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
        closeOnClick
        title={title}
        className={menuItemClassName(false, 'gap-2.5 data-checked:text-accent')}
    >
        {children}
        <BaseMenu.CheckboxItemIndicator className="ml-auto">
            <CheckIcon size={16} />
        </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
);
